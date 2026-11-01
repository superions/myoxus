//! Deterministic server-side formula parser and evaluator for Databases.
//!
//! The grammar intentionally stays small and typed. Expressions can reference
//! fields in the same database as `[Field name]`; the server resolves those
//! names to field ids during validation so clients never author dependencies
//! as a second source of truth.

use std::collections::{BTreeSet, HashMap};

use chrono::{Duration, NaiveDate};
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseCurrencyValue, DatabaseDateTimeValue, DatabaseDateValue, DatabaseDurationValue,
  DatabaseField, DatabaseFieldType, DatabaseFormulaResultType, DatabaseFormulaScalarValue, DatabaseFormulaSourceValue,
};
use myoxus_domain::ids::{DatabaseFieldId, UserId};
use nom::IResult;
use nom::branch::alt;
use nom::bytes::complete::{escaped_transform, is_not, tag, take_until, take_while, take_while1};
use nom::character::complete::{char, digit1, multispace0};
use nom::combinator::{all_consuming, map, map_res, opt, recognize, value};
use nom::multi::separated_list0;
use nom::sequence::{delimited, pair, preceded, tuple};

use super::{
  DatabaseServiceError, ERR_FORMULA_DEPENDENCY_INVALID, ERR_FORMULA_EVAL_LIMIT_EXCEEDED, ERR_FORMULA_PARSE_FAILED,
  ERR_FORMULA_TYPE_INVALID,
};

const MAX_AST_NODES: usize = 256;
const MAX_AST_DEPTH: usize = 32;
const MAX_FUNCTION_ARGS: usize = 8;
const MAX_TEXT_BYTES: usize = 16_384;

#[derive(Debug, Clone, PartialEq)]
pub enum FormulaAst {
  Null,
  Number(f64),
  Text(String),
  Checkbox(bool),
  Field(String),
  UnaryMinus(Box<FormulaAst>),
  Binary {
    op: FormulaBinaryOp,
    left: Box<FormulaAst>,
    right: Box<FormulaAst>,
  },
  Call {
    name: String,
    args: Vec<FormulaAst>,
  },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormulaBinaryOp {
  Add,
  Subtract,
  Multiply,
  Divide,
  Equal,
  NotEqual,
  Less,
  LessEqual,
  Greater,
  GreaterEqual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormulaValueType {
  Text,
  Number,
  Percent,
  Currency,
  Duration,
  Checkbox,
  Date,
  DateTime,
  User,
  Users,
  Empty,
}

impl FormulaValueType {
  pub fn matches_result_type(self, result_type: DatabaseFormulaResultType) -> bool {
    matches!(
      (self, result_type),
      (Self::Text, DatabaseFormulaResultType::Text)
        | (Self::Number, DatabaseFormulaResultType::Number)
        | (Self::Percent, DatabaseFormulaResultType::Percent)
        | (Self::Currency, DatabaseFormulaResultType::Currency)
        | (Self::Duration, DatabaseFormulaResultType::Duration)
        | (Self::Checkbox, DatabaseFormulaResultType::Checkbox)
        | (Self::Date, DatabaseFormulaResultType::Date)
        | (Self::DateTime, DatabaseFormulaResultType::DateTime)
        | (Self::User, DatabaseFormulaResultType::User)
        | (Self::Users, DatabaseFormulaResultType::Users)
        | (Self::Empty, _)
    )
  }

  fn is_numeric(self) -> bool {
    matches!(self, Self::Number | Self::Percent | Self::Duration)
  }
}

#[derive(Debug, Clone)]
pub struct FormulaAnalysis {
  pub ast: FormulaAst,
  pub dependency_field_ids: Vec<DatabaseFieldId>,
}

#[derive(Debug, Clone, PartialEq)]
enum FormulaRuntimeValue {
  Null,
  Number(f64),
  Percent(f64),
  Currency(DatabaseCurrencyValue),
  Duration(DatabaseDurationValue),
  Text(String),
  Checkbox(bool),
  Date(DatabaseDateValue),
  DateTime(DatabaseDateTimeValue),
  User(UserId),
  Users(Vec<UserId>),
}

fn ws<'a, F, O>(inner: F) -> impl FnMut(&'a str) -> IResult<&'a str, O>
where
  F: FnMut(&'a str) -> IResult<&'a str, O>,
{
  delimited(multispace0, inner, multispace0)
}

fn parse_number(input: &str) -> IResult<&str, FormulaAst> {
  map_res(
    recognize(tuple((opt(char('-')), digit1, opt(pair(char('.'), digit1))))),
    |value: &str| {
      value
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
        .map(FormulaAst::Number)
        .ok_or(())
    },
  )(input)
}

fn parse_text(input: &str) -> IResult<&str, FormulaAst> {
  map(
    delimited(
      char('"'),
      escaped_transform(
        is_not("\\\""),
        '\\',
        alt((value("\n", tag("n")), value("\"", tag("\"")), value("\\", tag("\\")))),
      ),
      char('"'),
    ),
    FormulaAst::Text,
  )(input)
}

fn parse_checkbox(input: &str) -> IResult<&str, FormulaAst> {
  alt((
    value(FormulaAst::Checkbox(true), tag("true")),
    value(FormulaAst::Checkbox(false), tag("false")),
  ))(input)
}

fn parse_null(input: &str) -> IResult<&str, FormulaAst> {
  value(FormulaAst::Null, tag("null"))(input)
}

fn parse_identifier(input: &str) -> IResult<&str, &str> {
  recognize(pair(
    take_while1(|c: char| c.is_ascii_alphabetic() || c == '_'),
    take_while(|c: char| c.is_ascii_alphanumeric() || c == '_'),
  ))(input)
}

fn parse_field(input: &str) -> IResult<&str, FormulaAst> {
  map(delimited(char('['), take_until("]"), char(']')), |name: &str| {
    FormulaAst::Field(name.trim().to_string())
  })(input)
}

fn parse_call(input: &str) -> IResult<&str, FormulaAst> {
  map(
    pair(
      parse_identifier,
      ws(delimited(
        char('('),
        separated_list0(ws(char(',')), parse_expression),
        char(')'),
      )),
    ),
    |(name, args)| FormulaAst::Call {
      name: name.to_ascii_lowercase(),
      args,
    },
  )(input)
}

fn parse_primary(input: &str) -> IResult<&str, FormulaAst> {
  ws(alt((
    delimited(char('('), parse_expression, char(')')),
    parse_call,
    parse_field,
    parse_text,
    parse_number,
    parse_checkbox,
    parse_null,
  )))(input)
}

fn parse_unary(input: &str) -> IResult<&str, FormulaAst> {
  alt((
    map(preceded(ws(char('-')), parse_unary), |ast| {
      FormulaAst::UnaryMinus(Box::new(ast))
    }),
    parse_primary,
  ))(input)
}

fn parse_multiplicative(input: &str) -> IResult<&str, FormulaAst> {
  let (mut input, mut ast) = parse_unary(input)?;
  loop {
    let parsed = opt(pair(ws(alt((char('*'), char('/')))), parse_unary))(input)?;
    match parsed {
      (next_input, Some((op, right))) => {
        ast = FormulaAst::Binary {
          op: if op == '*' {
            FormulaBinaryOp::Multiply
          } else {
            FormulaBinaryOp::Divide
          },
          left: Box::new(ast),
          right: Box::new(right),
        };
        input = next_input;
      }
      (next_input, None) => return Ok((next_input, ast)),
    }
  }
}

fn parse_additive(input: &str) -> IResult<&str, FormulaAst> {
  let (mut input, mut ast) = parse_multiplicative(input)?;
  loop {
    let parsed = opt(pair(ws(alt((char('+'), char('-')))), parse_multiplicative))(input)?;
    match parsed {
      (next_input, Some((op, right))) => {
        ast = FormulaAst::Binary {
          op: if op == '+' {
            FormulaBinaryOp::Add
          } else {
            FormulaBinaryOp::Subtract
          },
          left: Box::new(ast),
          right: Box::new(right),
        };
        input = next_input;
      }
      (next_input, None) => return Ok((next_input, ast)),
    }
  }
}

fn parse_comparison_operator(input: &str) -> IResult<&str, FormulaBinaryOp> {
  alt((
    value(FormulaBinaryOp::LessEqual, tag("<=")),
    value(FormulaBinaryOp::GreaterEqual, tag(">=")),
    value(FormulaBinaryOp::NotEqual, tag("!=")),
    value(FormulaBinaryOp::Equal, tag("==")),
    value(FormulaBinaryOp::Equal, tag("=")),
    value(FormulaBinaryOp::Less, tag("<")),
    value(FormulaBinaryOp::Greater, tag(">")),
  ))(input)
}

fn parse_comparison(input: &str) -> IResult<&str, FormulaAst> {
  let (input, left) = parse_additive(input)?;
  let (input, comparison) = opt(pair(ws(parse_comparison_operator), parse_additive))(input)?;
  Ok((
    input,
    match comparison {
      Some((op, right)) => FormulaAst::Binary {
        op,
        left: Box::new(left),
        right: Box::new(right),
      },
      None => left,
    },
  ))
}

fn parse_expression(input: &str) -> IResult<&str, FormulaAst> {
  parse_comparison(input)
}

pub fn parse_formula(expression: &str) -> Result<FormulaAst, DatabaseServiceError> {
  let (_, ast) = all_consuming(ws(parse_expression))(expression)
    .map_err(|_| DatabaseServiceError::new(ERR_FORMULA_PARSE_FAILED, "formula expression could not be parsed"))?;
  validate_limits(&ast, 0)?;
  Ok(ast)
}

fn validate_limits(ast: &FormulaAst, depth: usize) -> Result<usize, DatabaseServiceError> {
  if depth > MAX_AST_DEPTH {
    return Err(DatabaseServiceError::new(
      ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
      "formula expression nesting is too deep",
    ));
  }
  let children = match ast {
    FormulaAst::UnaryMinus(child) => vec![child.as_ref()],
    FormulaAst::Binary { left, right, .. } => vec![left.as_ref(), right.as_ref()],
    FormulaAst::Call { args, .. } => args.iter().collect(),
    _ => Vec::new(),
  };
  if children.len() > MAX_FUNCTION_ARGS {
    return Err(DatabaseServiceError::new(
      ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
      "formula function has too many arguments",
    ));
  }
  let mut nodes = 1;
  for child in children {
    nodes += validate_limits(child, depth + 1)?;
  }
  if nodes > MAX_AST_NODES {
    return Err(DatabaseServiceError::new(
      ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
      "formula expression is too large",
    ));
  }
  Ok(nodes)
}

pub fn analyze_formula(
  expression: &str,
  result_type: DatabaseFormulaResultType,
  fields: &[DatabaseField],
) -> Result<FormulaAnalysis, DatabaseServiceError> {
  let ast = parse_formula(expression)?;
  let field_names = fields
    .iter()
    .map(|field| (field.name.to_lowercase(), field))
    .collect::<HashMap<_, _>>();
  let mut dependencies = BTreeSet::new();
  let value_type = infer_type(&ast, &field_names, &mut dependencies)?;
  if !value_type.matches_result_type(result_type) {
    return Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      "formula expression result does not match configured result type",
    ));
  }
  Ok(FormulaAnalysis {
    ast,
    dependency_field_ids: dependencies.into_iter().collect(),
  })
}

fn field_value_type(field_type: DatabaseFieldType) -> Result<FormulaValueType, DatabaseServiceError> {
  match field_type {
    DatabaseFieldType::Title
    | DatabaseFieldType::Text
    | DatabaseFieldType::RichText
    | DatabaseFieldType::Select
    | DatabaseFieldType::Status
    | DatabaseFieldType::Url
    | DatabaseFieldType::Email
    | DatabaseFieldType::Phone => Ok(FormulaValueType::Text),
    DatabaseFieldType::UniqueId => Ok(FormulaValueType::Text),
    DatabaseFieldType::Number => Ok(FormulaValueType::Number),
    DatabaseFieldType::Percent => Ok(FormulaValueType::Percent),
    DatabaseFieldType::Duration => Ok(FormulaValueType::Duration),
    DatabaseFieldType::Currency => Ok(FormulaValueType::Currency),
    DatabaseFieldType::Checkbox => Ok(FormulaValueType::Checkbox),
    DatabaseFieldType::Date => Ok(FormulaValueType::Date),
    DatabaseFieldType::DateTime | DatabaseFieldType::CreatedTime | DatabaseFieldType::UpdatedTime => {
      Ok(FormulaValueType::DateTime)
    }
    DatabaseFieldType::User => Ok(FormulaValueType::User),
    DatabaseFieldType::Users => Ok(FormulaValueType::Users),
    DatabaseFieldType::MultiSelect
    | DatabaseFieldType::Tags
    | DatabaseFieldType::Files
    | DatabaseFieldType::DocumentLink
    | DatabaseFieldType::CreatedBy
    | DatabaseFieldType::UpdatedBy
    | DatabaseFieldType::Relation
    | DatabaseFieldType::Rollup
    | DatabaseFieldType::Formula => Err(DatabaseServiceError::new(
      ERR_FORMULA_DEPENDENCY_INVALID,
      "formula dependency field type is not supported",
    )),
  }
}

fn infer_type(
  ast: &FormulaAst,
  fields: &HashMap<String, &DatabaseField>,
  dependencies: &mut BTreeSet<DatabaseFieldId>,
) -> Result<FormulaValueType, DatabaseServiceError> {
  match ast {
    FormulaAst::Null => Ok(FormulaValueType::Empty),
    FormulaAst::Number(_) => Ok(FormulaValueType::Number),
    FormulaAst::Text(_) => Ok(FormulaValueType::Text),
    FormulaAst::Checkbox(_) => Ok(FormulaValueType::Checkbox),
    FormulaAst::Field(name) => {
      let field = fields.get(&name.to_lowercase()).ok_or_else(|| {
        DatabaseServiceError::new(ERR_FORMULA_DEPENDENCY_INVALID, "formula references an unknown field")
      })?;
      dependencies.insert(field.id);
      field_value_type(field.field_type)
    }
    FormulaAst::UnaryMinus(child) => {
      require_type(infer_type(child, fields, dependencies)?, FormulaValueType::Number)?;
      Ok(FormulaValueType::Number)
    }
    FormulaAst::Binary { op, left, right } => {
      let left_type = infer_type(left, fields, dependencies)?;
      let right_type = infer_type(right, fields, dependencies)?;
      match op {
        FormulaBinaryOp::Add | FormulaBinaryOp::Subtract | FormulaBinaryOp::Multiply | FormulaBinaryOp::Divide => {
          require_numeric_type(left_type)?;
          require_numeric_type(right_type)?;
          Ok(FormulaValueType::Number)
        }
        FormulaBinaryOp::Equal | FormulaBinaryOp::NotEqual => {
          require_comparable(left_type, right_type)?;
          Ok(FormulaValueType::Checkbox)
        }
        FormulaBinaryOp::Less
        | FormulaBinaryOp::LessEqual
        | FormulaBinaryOp::Greater
        | FormulaBinaryOp::GreaterEqual => {
          require_orderable(left_type, right_type)?;
          Ok(FormulaValueType::Checkbox)
        }
      }
    }
    FormulaAst::Call { name, args } => infer_call_type(name, args, fields, dependencies),
  }
}

fn infer_call_type(
  name: &str,
  args: &[FormulaAst],
  fields: &HashMap<String, &DatabaseField>,
  dependencies: &mut BTreeSet<DatabaseFieldId>,
) -> Result<FormulaValueType, DatabaseServiceError> {
  match name {
    "if" => {
      require_arg_count(name, args, 3)?;
      require_type(infer_type(&args[0], fields, dependencies)?, FormulaValueType::Checkbox)?;
      let true_type = infer_type(&args[1], fields, dependencies)?;
      let false_type = infer_type(&args[2], fields, dependencies)?;
      require_comparable(true_type, false_type)?;
      Ok(if true_type == FormulaValueType::Empty {
        false_type
      } else {
        true_type
      })
    }
    "empty" => {
      require_arg_count(name, args, 1)?;
      let _ = infer_type(&args[0], fields, dependencies)?;
      Ok(FormulaValueType::Checkbox)
    }
    "concat" => {
      if args.is_empty() {
        return Err(DatabaseServiceError::new(
          ERR_FORMULA_TYPE_INVALID,
          "concat requires at least one argument",
        ));
      }
      for arg in args {
        let value_type = infer_type(arg, fields, dependencies)?;
        if !matches!(
          value_type,
          FormulaValueType::Text | FormulaValueType::Number | FormulaValueType::Checkbox | FormulaValueType::Empty
        ) {
          return Err(DatabaseServiceError::new(
            ERR_FORMULA_TYPE_INVALID,
            "concat accepts text, number, checkbox or empty values",
          ));
        }
      }
      Ok(FormulaValueType::Text)
    }
    "formatdate" => {
      require_arg_count(name, args, 2)?;
      require_type(infer_type(&args[0], fields, dependencies)?, FormulaValueType::Date)?;
      require_type(infer_type(&args[1], fields, dependencies)?, FormulaValueType::Text)?;
      Ok(FormulaValueType::Text)
    }
    "dateadd" => {
      require_arg_count(name, args, 2)?;
      require_type(infer_type(&args[0], fields, dependencies)?, FormulaValueType::Date)?;
      require_type(infer_type(&args[1], fields, dependencies)?, FormulaValueType::Number)?;
      Ok(FormulaValueType::Date)
    }
    "datediff" => {
      require_arg_count(name, args, 2)?;
      require_type(infer_type(&args[0], fields, dependencies)?, FormulaValueType::Date)?;
      require_type(infer_type(&args[1], fields, dependencies)?, FormulaValueType::Date)?;
      Ok(FormulaValueType::Number)
    }
    _ => Err(DatabaseServiceError::new(
      ERR_FORMULA_PARSE_FAILED,
      format!("unsupported formula function: {name}"),
    )),
  }
}

fn require_arg_count(name: &str, args: &[FormulaAst], count: usize) -> Result<(), DatabaseServiceError> {
  if args.len() == count {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      format!("{name} expects {count} arguments"),
    ))
  }
}

fn require_type(actual: FormulaValueType, expected: FormulaValueType) -> Result<(), DatabaseServiceError> {
  if actual == expected || actual == FormulaValueType::Empty {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      "formula value type mismatch",
    ))
  }
}

fn require_numeric_type(actual: FormulaValueType) -> Result<(), DatabaseServiceError> {
  if actual.is_numeric() || actual == FormulaValueType::Empty {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      "formula numeric operation requires number, percent or duration values",
    ))
  }
}

fn require_comparable(left: FormulaValueType, right: FormulaValueType) -> Result<(), DatabaseServiceError> {
  if left == right || left == FormulaValueType::Empty || right == FormulaValueType::Empty {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      "formula comparison uses incompatible value types",
    ))
  }
}

fn require_orderable(left: FormulaValueType, right: FormulaValueType) -> Result<(), DatabaseServiceError> {
  require_comparable(left, right)?;
  if left.is_numeric()
    || matches!(
      left,
      FormulaValueType::Date | FormulaValueType::DateTime | FormulaValueType::Empty
    )
  {
    Ok(())
  } else {
    Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      "formula ordered comparisons require number or date values",
    ))
  }
}

pub fn evaluate_formula(
  ast: &FormulaAst,
  fields: &[DatabaseField],
  sources: &[DatabaseFormulaSourceValue],
) -> Result<Option<DatabaseFormulaScalarValue>, DatabaseServiceError> {
  let by_id = fields.iter().map(|field| (field.id, field)).collect::<HashMap<_, _>>();
  let by_name = fields
    .iter()
    .map(|field| (field.name.to_lowercase(), field.id))
    .collect::<HashMap<_, _>>();
  let values = sources
    .iter()
    .map(|source| (source.field_id, source))
    .collect::<HashMap<_, _>>();
  let value = eval(ast, &by_name, &by_id, &values, 0)?;
  scalar_from_runtime(value)
}

fn eval(
  ast: &FormulaAst,
  by_name: &HashMap<String, DatabaseFieldId>,
  by_id: &HashMap<DatabaseFieldId, &DatabaseField>,
  values: &HashMap<DatabaseFieldId, &DatabaseFormulaSourceValue>,
  depth: usize,
) -> Result<FormulaRuntimeValue, DatabaseServiceError> {
  if depth > MAX_AST_DEPTH {
    return Err(DatabaseServiceError::new(
      ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
      "formula evaluation exceeded nesting limit",
    ));
  }
  match ast {
    FormulaAst::Null => Ok(FormulaRuntimeValue::Null),
    FormulaAst::Number(value) => Ok(FormulaRuntimeValue::Number(*value)),
    FormulaAst::Text(value) => Ok(FormulaRuntimeValue::Text(value.clone())),
    FormulaAst::Checkbox(value) => Ok(FormulaRuntimeValue::Checkbox(*value)),
    FormulaAst::Field(name) => {
      let Some(field_id) = by_name.get(&name.to_lowercase()) else {
        return Ok(FormulaRuntimeValue::Null);
      };
      let Some(field) = by_id.get(field_id) else {
        return Ok(FormulaRuntimeValue::Null);
      };
      Ok(runtime_from_cell(
        field.field_type,
        values.get(field_id).and_then(|source| source.value.as_ref()),
      ))
    }
    FormulaAst::UnaryMinus(child) => match eval(child, by_name, by_id, values, depth + 1)? {
      FormulaRuntimeValue::Number(value) => Ok(FormulaRuntimeValue::Number(-value)),
      FormulaRuntimeValue::Null => Ok(FormulaRuntimeValue::Null),
      _ => Err(DatabaseServiceError::new(
        ERR_FORMULA_TYPE_INVALID,
        "unary minus requires number",
      )),
    },
    FormulaAst::Binary { op, left, right } => {
      let left = eval(left, by_name, by_id, values, depth + 1)?;
      let right = eval(right, by_name, by_id, values, depth + 1)?;
      eval_binary(*op, left, right)
    }
    FormulaAst::Call { name, args } => {
      let evaluated = args
        .iter()
        .map(|arg| eval(arg, by_name, by_id, values, depth + 1))
        .collect::<Result<Vec<_>, _>>()?;
      eval_call(name, &evaluated)
    }
  }
}

fn runtime_from_cell(field_type: DatabaseFieldType, value: Option<&DatabaseCellValueData>) -> FormulaRuntimeValue {
  match (field_type, value) {
    (DatabaseFieldType::Title, Some(DatabaseCellValueData::Text(value)))
    | (DatabaseFieldType::Text, Some(DatabaseCellValueData::Text(value)))
    | (DatabaseFieldType::Select, Some(DatabaseCellValueData::Select(value)))
    | (DatabaseFieldType::Status, Some(DatabaseCellValueData::Status(value)))
    | (DatabaseFieldType::Url, Some(DatabaseCellValueData::Url(value)))
    | (DatabaseFieldType::Email, Some(DatabaseCellValueData::Email(value)))
    | (DatabaseFieldType::Phone, Some(DatabaseCellValueData::Phone(value))) => FormulaRuntimeValue::Text(value.clone()),
    (DatabaseFieldType::Number, Some(DatabaseCellValueData::Number(value))) => FormulaRuntimeValue::Number(*value),
    (DatabaseFieldType::Percent, Some(DatabaseCellValueData::Percent(value))) => FormulaRuntimeValue::Percent(*value),
    (DatabaseFieldType::Currency, Some(DatabaseCellValueData::Currency(value))) => {
      FormulaRuntimeValue::Currency(value.clone())
    }
    (DatabaseFieldType::Duration, Some(DatabaseCellValueData::Duration(value))) => {
      FormulaRuntimeValue::Duration(value.clone())
    }
    (DatabaseFieldType::Files, Some(DatabaseCellValueData::Files(_))) => FormulaRuntimeValue::Null,
    (DatabaseFieldType::UniqueId, Some(DatabaseCellValueData::UniqueId(value))) => {
      FormulaRuntimeValue::Text(value.display.clone())
    }
    (DatabaseFieldType::Checkbox, Some(DatabaseCellValueData::Checkbox(value))) => {
      FormulaRuntimeValue::Checkbox(*value)
    }
    (DatabaseFieldType::Date, Some(DatabaseCellValueData::Date(value))) => FormulaRuntimeValue::Date(value.clone()),
    (DatabaseFieldType::DateTime, Some(DatabaseCellValueData::DateTime(value))) => {
      FormulaRuntimeValue::DateTime(value.clone())
    }
    (DatabaseFieldType::CreatedTime, Some(DatabaseCellValueData::CreatedTime(value)))
    | (DatabaseFieldType::UpdatedTime, Some(DatabaseCellValueData::UpdatedTime(value))) => {
      FormulaRuntimeValue::DateTime(DatabaseDateTimeValue {
        start: *value,
        end: None,
        all_day: false,
        time_zone: "UTC".to_string(),
      })
    }
    (DatabaseFieldType::User, Some(DatabaseCellValueData::User(value))) => FormulaRuntimeValue::User(*value),
    (DatabaseFieldType::Users, Some(DatabaseCellValueData::Users(value))) => FormulaRuntimeValue::Users(value.clone()),
    _ => FormulaRuntimeValue::Null,
  }
}

fn eval_binary(
  op: FormulaBinaryOp,
  left: FormulaRuntimeValue,
  right: FormulaRuntimeValue,
) -> Result<FormulaRuntimeValue, DatabaseServiceError> {
  if matches!(left, FormulaRuntimeValue::Null) || matches!(right, FormulaRuntimeValue::Null) {
    return Ok(FormulaRuntimeValue::Null);
  }
  match op {
    FormulaBinaryOp::Add => numeric_binary(left, right, |a, b| a + b),
    FormulaBinaryOp::Subtract => numeric_binary(left, right, |a, b| a - b),
    FormulaBinaryOp::Multiply => numeric_binary(left, right, |a, b| a * b),
    FormulaBinaryOp::Divide => numeric_binary(left, right, |a, b| a / b),
    FormulaBinaryOp::Equal => Ok(FormulaRuntimeValue::Checkbox(left == right)),
    FormulaBinaryOp::NotEqual => Ok(FormulaRuntimeValue::Checkbox(left != right)),
    FormulaBinaryOp::Less | FormulaBinaryOp::LessEqual | FormulaBinaryOp::Greater | FormulaBinaryOp::GreaterEqual => {
      ordered_binary(op, left, right)
    }
  }
}

fn numeric_binary(
  left: FormulaRuntimeValue,
  right: FormulaRuntimeValue,
  op: impl FnOnce(f64, f64) -> f64,
) -> Result<FormulaRuntimeValue, DatabaseServiceError> {
  match (runtime_to_number(&left), runtime_to_number(&right)) {
    (Some(left), Some(right)) => {
      let value = op(left, right);
      if value.is_finite() {
        Ok(FormulaRuntimeValue::Number(value))
      } else {
        Err(DatabaseServiceError::new(
          ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
          "formula numeric result is not finite",
        ))
      }
    }
    _ => Err(DatabaseServiceError::new(
      ERR_FORMULA_TYPE_INVALID,
      "formula arithmetic requires number values",
    )),
  }
}

fn runtime_to_number(value: &FormulaRuntimeValue) -> Option<f64> {
  match value {
    FormulaRuntimeValue::Number(value) | FormulaRuntimeValue::Percent(value) => Some(*value),
    FormulaRuntimeValue::Duration(value) => Some(value.minutes as f64),
    _ => None,
  }
}

fn ordered_binary(
  op: FormulaBinaryOp,
  left: FormulaRuntimeValue,
  right: FormulaRuntimeValue,
) -> Result<FormulaRuntimeValue, DatabaseServiceError> {
  let ordering = match (left, right) {
    (FormulaRuntimeValue::Number(left), FormulaRuntimeValue::Number(right)) => left.partial_cmp(&right),
    (FormulaRuntimeValue::Percent(left), FormulaRuntimeValue::Percent(right)) => left.partial_cmp(&right),
    (FormulaRuntimeValue::Duration(left), FormulaRuntimeValue::Duration(right)) => {
      Some(left.minutes.cmp(&right.minutes))
    }
    (FormulaRuntimeValue::Date(left), FormulaRuntimeValue::Date(right)) => Some(left.start.cmp(&right.start)),
    (FormulaRuntimeValue::DateTime(left), FormulaRuntimeValue::DateTime(right)) => Some(left.start.cmp(&right.start)),
    _ => None,
  }
  .ok_or_else(|| DatabaseServiceError::new(ERR_FORMULA_TYPE_INVALID, "formula ordered comparison failed"))?;
  let result = match op {
    FormulaBinaryOp::Less => ordering.is_lt(),
    FormulaBinaryOp::LessEqual => ordering.is_le(),
    FormulaBinaryOp::Greater => ordering.is_gt(),
    FormulaBinaryOp::GreaterEqual => ordering.is_ge(),
    _ => unreachable!("ordered_binary receives only ordered operators"),
  };
  Ok(FormulaRuntimeValue::Checkbox(result))
}

fn eval_call(name: &str, args: &[FormulaRuntimeValue]) -> Result<FormulaRuntimeValue, DatabaseServiceError> {
  match name {
    "if" => match (&args[0], &args[1], &args[2]) {
      (FormulaRuntimeValue::Checkbox(condition), true_value, false_value) => Ok(if *condition {
        true_value.clone()
      } else {
        false_value.clone()
      }),
      _ => Err(DatabaseServiceError::new(
        ERR_FORMULA_TYPE_INVALID,
        "if requires a checkbox condition",
      )),
    },
    "empty" => Ok(FormulaRuntimeValue::Checkbox(match &args[0] {
      FormulaRuntimeValue::Null => true,
      FormulaRuntimeValue::Text(value) => value.trim().is_empty(),
      _ => false,
    })),
    "concat" => {
      let mut output = String::new();
      for arg in args {
        output.push_str(&runtime_to_text(arg));
        if output.len() > MAX_TEXT_BYTES {
          return Err(DatabaseServiceError::new(
            ERR_FORMULA_EVAL_LIMIT_EXCEEDED,
            "formula text result exceeds limit",
          ));
        }
      }
      Ok(FormulaRuntimeValue::Text(output))
    }
    "formatdate" => match (&args[0], &args[1]) {
      (FormulaRuntimeValue::Date(value), FormulaRuntimeValue::Text(format)) => {
        Ok(FormulaRuntimeValue::Text(format_date(value.start, format)))
      }
      _ => Err(DatabaseServiceError::new(
        ERR_FORMULA_TYPE_INVALID,
        "formatDate requires date and text arguments",
      )),
    },
    "dateadd" => match (&args[0], &args[1]) {
      (FormulaRuntimeValue::Date(value), FormulaRuntimeValue::Number(days)) => {
        let days = *days as i64;
        Ok(FormulaRuntimeValue::Date(DatabaseDateValue {
          start: value.start + Duration::days(days),
          end: value.end.map(|end| end + Duration::days(days)),
        }))
      }
      _ => Err(DatabaseServiceError::new(
        ERR_FORMULA_TYPE_INVALID,
        "dateAdd requires date and number arguments",
      )),
    },
    "datediff" => match (&args[0], &args[1]) {
      (FormulaRuntimeValue::Date(left), FormulaRuntimeValue::Date(right)) => {
        Ok(FormulaRuntimeValue::Number((right.start - left.start).num_days() as f64))
      }
      _ => Err(DatabaseServiceError::new(
        ERR_FORMULA_TYPE_INVALID,
        "dateDiff requires two date arguments",
      )),
    },
    _ => Err(DatabaseServiceError::new(
      ERR_FORMULA_PARSE_FAILED,
      "unsupported formula function",
    )),
  }
}

fn runtime_to_text(value: &FormulaRuntimeValue) -> String {
  match value {
    FormulaRuntimeValue::Null => String::new(),
    FormulaRuntimeValue::Number(value) => value.to_string(),
    FormulaRuntimeValue::Percent(value) => value.to_string(),
    FormulaRuntimeValue::Currency(value) => format!("{} {}", value.amount, value.currency_code),
    FormulaRuntimeValue::Duration(value) => value.minutes.to_string(),
    FormulaRuntimeValue::Text(value) => value.clone(),
    FormulaRuntimeValue::Checkbox(value) => value.to_string(),
    FormulaRuntimeValue::Date(value) => value.start.to_string(),
    FormulaRuntimeValue::DateTime(value) => value.start.to_rfc3339(),
    FormulaRuntimeValue::User(value) => value.to_string(),
    FormulaRuntimeValue::Users(value) => value.iter().map(ToString::to_string).collect::<Vec<_>>().join(","),
  }
}

fn format_date(date: NaiveDate, format: &str) -> String {
  let chrono_format = format.replace("yyyy", "%Y").replace("MM", "%m").replace("dd", "%d");
  date.format(&chrono_format).to_string()
}

fn scalar_from_runtime(value: FormulaRuntimeValue) -> Result<Option<DatabaseFormulaScalarValue>, DatabaseServiceError> {
  Ok(match value {
    FormulaRuntimeValue::Null => None,
    FormulaRuntimeValue::Number(value) => Some(DatabaseFormulaScalarValue::Number(value)),
    FormulaRuntimeValue::Percent(value) => Some(DatabaseFormulaScalarValue::Percent(value)),
    FormulaRuntimeValue::Currency(value) => Some(DatabaseFormulaScalarValue::Currency(value)),
    FormulaRuntimeValue::Duration(value) => Some(DatabaseFormulaScalarValue::Duration(value)),
    FormulaRuntimeValue::Text(value) => Some(DatabaseFormulaScalarValue::Text(value)),
    FormulaRuntimeValue::Checkbox(value) => Some(DatabaseFormulaScalarValue::Checkbox(value)),
    FormulaRuntimeValue::Date(value) => Some(DatabaseFormulaScalarValue::Date(value)),
    FormulaRuntimeValue::DateTime(value) => Some(DatabaseFormulaScalarValue::DateTime(value)),
    FormulaRuntimeValue::User(value) => Some(DatabaseFormulaScalarValue::User(value)),
    FormulaRuntimeValue::Users(value) => Some(DatabaseFormulaScalarValue::Users(value)),
  })
}

#[cfg(test)]
mod tests {
  use super::*;
  use chrono::TimeZone;
  use myoxus_domain::ids::DatabaseId;
  use uuid::Uuid;

  fn field(id: u128, name: &str, field_type: DatabaseFieldType) -> DatabaseField {
    DatabaseField {
      id: DatabaseFieldId::from_u128(id),
      database_id: DatabaseId::from_u128(1),
      name: name.to_string(),
      field_type,
      config: myoxus_domain::database::DatabaseFieldConfig::empty_for(field_type),
      position: id as i32,
      required: false,
      edit_revision: 1,
      created_at: chrono::Utc::now(),
      updated_at: chrono::Utc::now(),
    }
  }

  #[test]
  fn parser_accepts_arithmetic_functions_and_field_refs() {
    let ast = parse_formula(r#"if(empty([Done]), 0, [Score] + 2 * 3)"#).expect("valid formula");
    assert!(matches!(ast, FormulaAst::Call { .. }));
  }

  #[test]
  fn parser_materializes_supported_text_escapes() {
    let ast = parse_formula(r#""Line 1\nLine 2 \"quoted\" \\slash""#).expect("valid text formula");
    assert_eq!(ast, FormulaAst::Text("Line 1\nLine 2 \"quoted\" \\slash".to_string()));
  }

  #[test]
  fn parser_rejects_unconsumed_or_unknown_syntax() {
    let err = parse_formula("[Score] +").expect_err("invalid formula");
    assert_eq!(err.code, ERR_FORMULA_PARSE_FAILED);
  }

  #[test]
  fn typecheck_collects_dependencies_and_blocks_incompatible_result() {
    let fields = vec![
      field(2, "Score", DatabaseFieldType::Number),
      field(3, "Done", DatabaseFieldType::Checkbox),
    ];
    let analysis = analyze_formula(
      r#"if([Done], [Score] + 1, 0)"#,
      DatabaseFormulaResultType::Number,
      &fields,
    )
    .expect("valid analysis");
    assert_eq!(analysis.dependency_field_ids.len(), 2);
    let err = analyze_formula(r#"[Score] + 1"#, DatabaseFormulaResultType::Text, &fields).expect_err("type mismatch");
    assert_eq!(err.code, ERR_FORMULA_TYPE_INVALID);
  }

  #[test]
  fn evaluator_computes_numbers_dates_and_text() {
    let fields = vec![
      field(2, "Score", DatabaseFieldType::Number),
      field(3, "Due", DatabaseFieldType::Date),
    ];
    let analysis = analyze_formula(
      r#"concat(formatDate(dateAdd([Due], 2), "yyyy-MM-dd"), "=", [Score] * 2)"#,
      DatabaseFormulaResultType::Text,
      &fields,
    )
    .expect("valid analysis");
    let sources = vec![
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(2),
        field_type: DatabaseFieldType::Number,
        value: Some(DatabaseCellValueData::Number(4.0)),
      },
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(3),
        field_type: DatabaseFieldType::Date,
        value: Some(DatabaseCellValueData::Date(DatabaseDateValue {
          start: NaiveDate::from_ymd_opt(2026, 7, 2).unwrap(),
          end: None,
        })),
      },
    ];
    let value = evaluate_formula(&analysis.ast, &fields, &sources).expect("formula value");
    assert_eq!(
      value,
      Some(DatabaseFormulaScalarValue::Text("2026-07-04=8".to_string()))
    );
  }

  #[test]
  fn evaluator_treats_duration_cells_as_canonical_minutes() {
    let fields = vec![field(2, "Effort", DatabaseFieldType::Duration)];
    let analysis = analyze_formula(r#"[Effort] / 60"#, DatabaseFormulaResultType::Number, &fields)
      .expect("duration fields are numeric formula dependencies");
    let sources = vec![DatabaseFormulaSourceValue {
      field_id: DatabaseFieldId::from_u128(2),
      field_type: DatabaseFieldType::Duration,
      value: Some(DatabaseCellValueData::Duration(
        myoxus_domain::database::DatabaseDurationValue { minutes: 150 },
      )),
    }];
    let value = evaluate_formula(&analysis.ast, &fields, &sources).expect("formula value");
    assert_eq!(value, Some(DatabaseFormulaScalarValue::Number(2.5)));
  }

  #[test]
  fn evaluator_materializes_full_formula_result_set() {
    let user_id = Uuid::from_u128(100);
    let second_user_id = Uuid::from_u128(101);
    let date_time = DatabaseDateTimeValue {
      start: chrono::Utc.with_ymd_and_hms(2026, 7, 6, 8, 30, 0).unwrap(),
      end: None,
      all_day: false,
      time_zone: "Europe/Berlin".to_string(),
    };
    let fields = vec![
      field(2, "Progress", DatabaseFieldType::Percent),
      field(3, "Budget", DatabaseFieldType::Currency),
      field(4, "Effort", DatabaseFieldType::Duration),
      field(5, "Starts", DatabaseFieldType::DateTime),
      field(6, "Owner", DatabaseFieldType::User),
      field(7, "Assignees", DatabaseFieldType::Users),
    ];
    let sources = vec![
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(2),
        field_type: DatabaseFieldType::Percent,
        value: Some(DatabaseCellValueData::Percent(0.75)),
      },
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(3),
        field_type: DatabaseFieldType::Currency,
        value: Some(DatabaseCellValueData::Currency(DatabaseCurrencyValue {
          amount: 1200.0,
          currency_code: "EUR".to_string(),
        })),
      },
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(4),
        field_type: DatabaseFieldType::Duration,
        value: Some(DatabaseCellValueData::Duration(DatabaseDurationValue { minutes: 90 })),
      },
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(5),
        field_type: DatabaseFieldType::DateTime,
        value: Some(DatabaseCellValueData::DateTime(date_time.clone())),
      },
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(6),
        field_type: DatabaseFieldType::User,
        value: Some(DatabaseCellValueData::User(user_id)),
      },
      DatabaseFormulaSourceValue {
        field_id: DatabaseFieldId::from_u128(7),
        field_type: DatabaseFieldType::Users,
        value: Some(DatabaseCellValueData::Users(vec![user_id, second_user_id])),
      },
    ];

    for (expression, result_type, expected) in [
      (
        "[Progress]",
        DatabaseFormulaResultType::Percent,
        DatabaseFormulaScalarValue::Percent(0.75),
      ),
      (
        "[Budget]",
        DatabaseFormulaResultType::Currency,
        DatabaseFormulaScalarValue::Currency(DatabaseCurrencyValue {
          amount: 1200.0,
          currency_code: "EUR".to_string(),
        }),
      ),
      (
        "[Effort]",
        DatabaseFormulaResultType::Duration,
        DatabaseFormulaScalarValue::Duration(DatabaseDurationValue { minutes: 90 }),
      ),
      (
        "[Starts]",
        DatabaseFormulaResultType::DateTime,
        DatabaseFormulaScalarValue::DateTime(date_time.clone()),
      ),
      (
        "[Owner]",
        DatabaseFormulaResultType::User,
        DatabaseFormulaScalarValue::User(user_id),
      ),
      (
        "[Assignees]",
        DatabaseFormulaResultType::Users,
        DatabaseFormulaScalarValue::Users(vec![user_id, second_user_id]),
      ),
    ] {
      let analysis = analyze_formula(expression, result_type, &fields).expect("formula analysis");
      let value = evaluate_formula(&analysis.ast, &fields, &sources).expect("formula value");
      assert_eq!(value, Some(expected));
    }
  }
}
