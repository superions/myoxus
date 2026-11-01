//! Search-query plan compilation and evaluation for [`SearchQueryInputType`].
//!
//! Implements the P1 contract: the GraphQL `SearchQueryInputType` is
//! compiled into a [`SearchPlan`] and evaluated through real doc-id set
//! algebra. No silent keyword downgrade.
//!
//! ## Operators
//!
//! | Operator | P1 support |
//! |---|---|
//! | `Match` | yes (FTS on `plainText` or `title`) |
//! | `Boolean` with `must` / `must_not` / `should` / `filter` | yes (set algebra) |
//! | `Exists` | yes (non-null, non-empty column check) |
//! | `Prefix` / `Phrase` / `Fuzzy` / `Wildcard` / `Regex` / `Boost` | rejected with stable error code |
//!
//! See `docs/dev/server/business-logic-search.md` for the documented contract.

use std::collections::HashSet;

use thiserror::Error;
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use myoxus_domain::entities::SearchDocument;
use myoxus_domain::repositories::{PageRequest, RepositoryError, SearchRepository};

// ─── Error model ────────────────────────────────────────────────────────────

/// Stable error codes for the SearchQueryInputType plan layer.
pub const ERR_OPERATOR_UNSUPPORTED: &str = "MIX_SRCH_OPERATOR_UNSUPPORTED";
pub const ERR_QUERY_EMPTY: &str = "MIX_SRCH_QUERY_EMPTY";
pub const ERR_FIELD_INVALID: &str = "MIX_SRCH_FIELD_INVALID";
pub const ERR_FIELD_REQUIRED: &str = "MIX_SRCH_FIELD_REQUIRED";
pub const ERR_SEARCH_UNAVAILABLE: &str = "MIX_SRCH_UNAVAILABLE";

/// Fields a query may target in P1. Anything outside this list is rejected so
/// the resolver cannot silently scan arbitrary columns.
pub const SUPPORTED_FIELDS: &[&str] = &["plainText", "title"];

/// Hard cap on how many doc_ids the evaluator fetches per set-algebra step.
pub const EVAL_MAX_DOC_IDS: i64 = 50_000;

#[derive(Debug, Error)]
pub enum SearchPlanError {
  /// The plan references an operator that P1 does not implement.
  #[error("unsupported search operator `{operator}`; supported in P1 are Match, Boolean, Exists")]
  UnsupportedOperator {
    /// GraphQL identifier of the operator, e.g. `"Fuzzy"`.
    operator: String,
    /// Stable error code that clients must switch on.
    code: &'static str,
  },

  /// The query had no leaf terms.
  #[error("empty search query: at least one Match, Exists, or non-empty Boolean branch is required")]
  EmptyQuery,

  /// The `field` value points at a column the resolver does not know how to
  /// evaluate in P1.
  #[error("unsupported search field `{field}`; supported are {supported:?}")]
  InvalidField {
    field: String,
    code: &'static str,
    supported: &'static [&'static str],
  },

  /// A non-Boolean leaf did not name a `field`.
  #[error("search field is required for {operator} queries")]
  FieldRequired { operator: &'static str, code: &'static str },

  /// A valid plan could not be executed by the search repository.
  ///
  /// The repository cause is retained for internal diagnostics, while the
  /// display text remains safe for the public GraphQL error surface.
  #[error("search is temporarily unavailable")]
  ExecutionUnavailable {
    #[source]
    cause: RepositoryError,
  },
}

impl SearchPlanError {
  /// Stable GraphQL extension code for the error variant.
  pub const fn code(&self) -> &'static str {
    match self {
      Self::UnsupportedOperator { .. } => ERR_OPERATOR_UNSUPPORTED,
      Self::EmptyQuery => ERR_QUERY_EMPTY,
      Self::InvalidField { .. } => ERR_FIELD_INVALID,
      Self::FieldRequired { .. } => ERR_FIELD_REQUIRED,
      Self::ExecutionUnavailable { .. } => ERR_SEARCH_UNAVAILABLE,
    }
  }

  pub(crate) fn execution_unavailable(cause: RepositoryError) -> Self {
    warn!(
      repository_error_kind = repository_error_kind(&cause),
      "search repository call failed"
    );
    Self::ExecutionUnavailable { cause }
  }
}

// ─── Plan model ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanMode {
  /// All child branches must match.
  MustAll,
  /// At least one child branch must match.
  ShouldAny,
  /// Conjunction with no scoring. Set semantics equivalent to MustAll.
  FilterAll,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BranchOccur {
  Must,
  MustNot,
  Should,
  Filter,
}

/// Compiled, evaluator-ready search query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SearchPlan {
  Match {
    field: String,
    keyword: String,
  },
  Boolean {
    mode: BooleanMode,
    branches: Vec<(BranchOccur, SearchPlan)>,
  },
  MustNot(Box<SearchPlan>),
  Exists {
    field: String,
  },
}

// ─── Compilation ────────────────────────────────────────────────────────────

#[instrument(skip(input))]
pub fn compile_plan(input: &super::types::SearchQueryInputType) -> Result<SearchPlan, SearchPlanError> {
  use super::types::SearchQueryTypeEnum;

  let typ = input.r#type;
  let keyword_raw = input.match_value.as_deref().map(str::trim);
  let keyword = keyword_raw.filter(|value| !value.is_empty());

  match typ {
    None => {
      if let Some(value) = keyword {
        let field = canonical_field(input.field.as_deref(), "Match")?;
        return Ok(SearchPlan::Match {
          field,
          keyword: value.to_string(),
        });
      }
      if let Some(nested) = input.query.as_deref() {
        return compile_plan(nested);
      }
      if let Some(list) = input.queries.as_deref() {
        if list.is_empty() {
          return Err(SearchPlanError::EmptyQuery);
        }
        let branches = list.iter().map(compile_branch).collect::<Result<Vec<_>, _>>()?;
        return Ok(SearchPlan::Boolean {
          mode: BooleanMode::MustAll,
          branches,
        });
      }
      Err(SearchPlanError::EmptyQuery)
    }
    Some(SearchQueryTypeEnum::Match) => {
      let Some(value) = keyword else {
        return Err(SearchPlanError::EmptyQuery);
      };
      let field = canonical_field(input.field.as_deref(), "Match")?;
      Ok(SearchPlan::Match {
        field,
        keyword: value.to_string(),
      })
    }
    Some(SearchQueryTypeEnum::Boolean) => {
      let branches = if let Some(list) = input.queries.as_deref() {
        if list.is_empty() {
          return Err(SearchPlanError::EmptyQuery);
        }
        list.iter().map(compile_branch).collect::<Result<Vec<_>, _>>()?
      } else if let Some(nested) = input.query.as_deref() {
        vec![compile_branch(nested)?]
      } else {
        return Err(SearchPlanError::EmptyQuery);
      };
      let mode = if branches.iter().all(|(occur, _)| matches!(occur, BranchOccur::Filter)) {
        BooleanMode::FilterAll
      } else {
        BooleanMode::MustAll
      };
      Ok(SearchPlan::Boolean { mode, branches })
    }
    Some(SearchQueryTypeEnum::Exists) => {
      let field = canonical_field(input.field.as_deref(), "Exists")?;
      Ok(SearchPlan::Exists { field })
    }
    Some(unsupported) => Err(SearchPlanError::UnsupportedOperator {
      operator: graphql_operator_name(unsupported),
      code: ERR_OPERATOR_UNSUPPORTED,
    }),
  }
}

fn compile_branch(input: &super::types::SearchQueryInputType) -> Result<(BranchOccur, SearchPlan), SearchPlanError> {
  use super::types::SearchQueryOccurType;
  let occur = match input.occur {
    None | Some(SearchQueryOccurType::Must) => BranchOccur::Must,
    Some(SearchQueryOccurType::MustNot) => BranchOccur::MustNot,
    Some(SearchQueryOccurType::Should) => BranchOccur::Should,
    Some(SearchQueryOccurType::Filter) => BranchOccur::Filter,
  };
  let plan = compile_plan(input)?;
  Ok((occur, plan))
}

fn canonical_field(raw: Option<&str>, operator: &'static str) -> Result<String, SearchPlanError> {
  let Some(name) = raw else {
    if operator == "Match" {
      return Ok("plainText".to_string());
    }
    return Err(SearchPlanError::FieldRequired {
      operator,
      code: ERR_FIELD_REQUIRED,
    });
  };
  if !SUPPORTED_FIELDS.contains(&name) {
    return Err(SearchPlanError::InvalidField {
      field: name.to_string(),
      code: ERR_FIELD_INVALID,
      supported: SUPPORTED_FIELDS,
    });
  }
  Ok(name.to_string())
}

fn graphql_operator_name(typ: super::types::SearchQueryTypeEnum) -> String {
  use super::types::SearchQueryTypeEnum;
  match typ {
    SearchQueryTypeEnum::Match => "Match".to_string(),
    SearchQueryTypeEnum::Boolean => "Boolean".to_string(),
    SearchQueryTypeEnum::Prefix => "Prefix".to_string(),
    SearchQueryTypeEnum::Phrase => "Phrase".to_string(),
    SearchQueryTypeEnum::Fuzzy => "Fuzzy".to_string(),
    SearchQueryTypeEnum::Wildcard => "Wildcard".to_string(),
    SearchQueryTypeEnum::Regex => "Regex".to_string(),
    SearchQueryTypeEnum::Boost => "Boost".to_string(),
    SearchQueryTypeEnum::Exists => "Exists".to_string(),
  }
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

/// Result of evaluating a plan against a workspace.
#[derive(Debug, Default)]
pub struct PlanHits {
  pub doc_ids: HashSet<Uuid>,
  pub documents: Vec<SearchDocument>,
}

impl PlanHits {
  pub fn len(&self) -> usize {
    self.doc_ids.len()
  }

  pub fn is_empty(&self) -> bool {
    self.doc_ids.is_empty()
  }
}

#[instrument(skip(plan, repo), fields(workspace_id = %workspace_id))]
pub async fn evaluate_plan(
  plan: &SearchPlan,
  workspace_id: Uuid,
  language: Option<&str>,
  repo: &dyn SearchRepository,
) -> Result<PlanHits, SearchPlanError> {
  match plan {
    SearchPlan::Match { field, keyword } => evaluate_match(field, keyword, workspace_id, language, repo).await,
    SearchPlan::Boolean { mode, branches } => {
      Box::pin(evaluate_boolean(*mode, branches, workspace_id, language, repo)).await
    }
    SearchPlan::MustNot(inner) => Box::pin(evaluate_must_not(inner, workspace_id, language, repo)).await,
    SearchPlan::Exists { field } => evaluate_exists(field, workspace_id, repo).await,
  }
}

async fn evaluate_match(
  field: &str,
  keyword: &str,
  workspace_id: Uuid,
  language: Option<&str>,
  repo: &dyn SearchRepository,
) -> Result<PlanHits, SearchPlanError> {
  let rows = repo
    .search_docs_in_field(
      workspace_id,
      field,
      keyword,
      language,
      PageRequest {
        limit: EVAL_MAX_DOC_IDS,
        offset: 0,
      },
    )
    .await
    .map_err(map_repo_err)?;
  debug!(
    workspace_id = %workspace_id,
    field,
    keyword,
    hits = rows.len(),
    "match plan evaluation completed"
  );
  let doc_ids: HashSet<Uuid> = rows.iter().map(|doc| doc.doc_id).collect();
  Ok(PlanHits {
    doc_ids,
    documents: rows,
  })
}

async fn evaluate_boolean(
  mode: BooleanMode,
  branches: &[(BranchOccur, SearchPlan)],
  workspace_id: Uuid,
  language: Option<&str>,
  repo: &dyn SearchRepository,
) -> Result<PlanHits, SearchPlanError> {
  if branches.is_empty() {
    return Ok(PlanHits::default());
  }

  let mut must_doc_ids: Option<HashSet<Uuid>> = None;
  let mut should_doc_ids: HashSet<Uuid> = HashSet::new();
  let mut must_not_doc_ids: HashSet<Uuid> = HashSet::new();

  for (occur, child) in branches {
    match occur {
      BranchOccur::Must | BranchOccur::Filter => {
        let hits = Box::pin(evaluate_plan(child, workspace_id, language, repo)).await?;
        must_doc_ids = Some(match must_doc_ids.take() {
          Some(existing) => existing.intersection(&hits.doc_ids).copied().collect(),
          None => hits.doc_ids,
        });
      }
      BranchOccur::Should => {
        let hits = Box::pin(evaluate_plan(child, workspace_id, language, repo)).await?;
        should_doc_ids.extend(hits.doc_ids);
      }
      BranchOccur::MustNot => {
        let hits = Box::pin(evaluate_plan(child, workspace_id, language, repo)).await?;
        must_not_doc_ids.extend(hits.doc_ids);
      }
    }
  }

  let combined: HashSet<Uuid> = match mode {
    BooleanMode::MustAll | BooleanMode::FilterAll => match must_doc_ids.take() {
      Some(must) => must,
      None => {
        if should_doc_ids.is_empty() {
          HashSet::new()
        } else {
          should_doc_ids.clone()
        }
      }
    },
    BooleanMode::ShouldAny => {
      if let Some(must) = must_doc_ids.take() {
        if should_doc_ids.is_empty() {
          HashSet::new()
        } else {
          must.intersection(&should_doc_ids).copied().collect()
        }
      } else if should_doc_ids.is_empty() {
        HashSet::new()
      } else {
        should_doc_ids.clone()
      }
    }
  };

  let final_set: HashSet<Uuid> = combined
    .into_iter()
    .filter(|id| !must_not_doc_ids.contains(id))
    .collect();
  Ok(PlanHits {
    doc_ids: final_set,
    documents: Vec::new(),
  })
}

async fn evaluate_must_not(
  inner: &SearchPlan,
  workspace_id: Uuid,
  language: Option<&str>,
  repo: &dyn SearchRepository,
) -> Result<PlanHits, SearchPlanError> {
  let inner_hits = Box::pin(evaluate_plan(inner, workspace_id, language, repo)).await?;
  let excluded = inner_hits.doc_ids;
  let all = repo
    .list_doc_ids_in_workspace(workspace_id, EVAL_MAX_DOC_IDS)
    .await
    .map_err(map_repo_err)?;
  let doc_ids: HashSet<Uuid> = all.into_iter().filter(|id| !excluded.contains(id)).collect();
  Ok(PlanHits {
    doc_ids,
    documents: Vec::new(),
  })
}

async fn evaluate_exists(
  field: &str,
  workspace_id: Uuid,
  repo: &dyn SearchRepository,
) -> Result<PlanHits, SearchPlanError> {
  let doc_ids: HashSet<Uuid> = repo
    .list_doc_ids_with_field_exists(workspace_id, field)
    .await
    .map_err(map_repo_err)?
    .into_iter()
    .collect();
  Ok(PlanHits {
    doc_ids,
    documents: Vec::new(),
  })
}

fn map_repo_err(err: RepositoryError) -> SearchPlanError {
  SearchPlanError::execution_unavailable(err)
}

fn repository_error_kind(err: &RepositoryError) -> &'static str {
  match err {
    RepositoryError::NotFound(_) => "not_found",
    RepositoryError::Conflict(_) => "conflict",
    RepositoryError::Validation(_) => "validation",
    RepositoryError::Storage(_) => "storage",
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
  use super::*;
  use crate::graphql::auth::types::{SearchQueryInputType, SearchQueryOccurType, SearchQueryTypeEnum};

  fn input(
    typ: Option<SearchQueryTypeEnum>,
    match_value: Option<&str>,
    field: Option<&str>,
    occur: Option<SearchQueryOccurType>,
    queries: Vec<SearchQueryInputType>,
  ) -> SearchQueryInputType {
    SearchQueryInputType {
      r#type: typ,
      field: field.map(str::to_string),
      match_value: match_value.map(str::to_string),
      occur,
      query: None,
      queries: if queries.is_empty() { None } else { Some(queries) },
      boost: None,
    }
  }

  #[test]
  fn compile_match_explicit_field_produces_match() {
    let plan = compile_plan(&input(
      Some(SearchQueryTypeEnum::Match),
      Some("alpha"),
      Some("title"),
      None,
      vec![],
    ))
    .unwrap();
    assert_eq!(
      plan,
      SearchPlan::Match {
        field: "title".to_string(),
        keyword: "alpha".to_string(),
      }
    );
  }

  #[test]
  fn compile_match_without_field_defaults_to_plaintext() {
    let plan = compile_plan(&input(
      Some(SearchQueryTypeEnum::Match),
      Some("alpha"),
      None,
      None,
      vec![],
    ))
    .unwrap();
    assert!(matches!(plan, SearchPlan::Match { ref field, ref keyword } if field == "plainText" && keyword == "alpha"));
  }

  #[test]
  fn compile_match_without_keyword_is_empty_query() {
    let err = compile_plan(&input(
      Some(SearchQueryTypeEnum::Match),
      None,
      Some("plainText"),
      None,
      vec![],
    ))
    .expect_err("empty Match must error");
    assert_eq!(err.code(), ERR_QUERY_EMPTY);
  }

  #[test]
  fn compile_invalid_field_is_rejected() {
    let err = compile_plan(&input(
      Some(SearchQueryTypeEnum::Match),
      Some("alpha"),
      Some("not_a_field"),
      None,
      vec![],
    ))
    .expect_err("unknown field must error");
    assert_eq!(err.code(), ERR_FIELD_INVALID);
  }

  #[test]
  fn compile_exists_without_field_is_field_required() {
    let err = compile_plan(&input(Some(SearchQueryTypeEnum::Exists), None, None, None, vec![]))
      .expect_err("Exists needs field");
    assert_eq!(err.code(), ERR_FIELD_REQUIRED);
  }

  #[test]
  fn compile_unsupported_operators_all_rejected() {
    for op in [
      SearchQueryTypeEnum::Prefix,
      SearchQueryTypeEnum::Phrase,
      SearchQueryTypeEnum::Fuzzy,
      SearchQueryTypeEnum::Wildcard,
      SearchQueryTypeEnum::Regex,
      SearchQueryTypeEnum::Boost,
    ] {
      let result = compile_plan(&input(Some(op), Some("alpha"), Some("plainText"), None, vec![]));
      assert!(
        matches!(result, Err(SearchPlanError::UnsupportedOperator { .. })),
        "operator {:?} must reject",
        op
      );
    }
  }

  #[test]
  fn compile_boolean_must_all_branches() {
    let plan = compile_plan(&input(
      Some(SearchQueryTypeEnum::Boolean),
      None,
      None,
      None,
      vec![
        input(
          Some(SearchQueryTypeEnum::Match),
          Some("alpha"),
          Some("plainText"),
          None,
          vec![],
        ),
        input(
          Some(SearchQueryTypeEnum::Match),
          Some("beta"),
          Some("plainText"),
          None,
          vec![],
        ),
      ],
    ))
    .unwrap();
    if let SearchPlan::Boolean { mode, branches } = plan {
      assert_eq!(mode, BooleanMode::MustAll);
      assert_eq!(branches.len(), 2);
      assert_eq!(branches[0].0, BranchOccur::Must);
      assert_eq!(branches[1].0, BranchOccur::Must);
    } else {
      panic!("expected Boolean plan");
    }
  }

  #[test]
  fn compile_boolean_with_must_not_branch_preserves_occur() {
    let plan = compile_plan(&input(
      Some(SearchQueryTypeEnum::Boolean),
      None,
      None,
      None,
      vec![
        input(
          Some(SearchQueryTypeEnum::Match),
          Some("alpha"),
          Some("plainText"),
          None,
          vec![],
        ),
        input(
          Some(SearchQueryTypeEnum::Match),
          Some("beta"),
          Some("plainText"),
          Some(SearchQueryOccurType::MustNot),
          vec![],
        ),
      ],
    ))
    .unwrap();
    if let SearchPlan::Boolean { branches, .. } = plan {
      assert_eq!(branches[0].0, BranchOccur::Must);
      assert_eq!(branches[1].0, BranchOccur::MustNot);
    } else {
      panic!("expected Boolean");
    }
  }

  #[test]
  fn compile_legacy_typeless_match_value_treated_as_match() {
    let plan = compile_plan(&input(None, Some("alpha"), Some("plainText"), None, vec![])).unwrap();
    assert!(matches!(plan, SearchPlan::Match { ref keyword, .. } if keyword == "alpha"));
  }

  #[test]
  fn compile_legacy_typeless_queries_treated_as_boolean() {
    let plan = compile_plan(&input(
      None,
      None,
      None,
      None,
      vec![
        input(
          Some(SearchQueryTypeEnum::Match),
          Some("alpha"),
          Some("plainText"),
          None,
          vec![],
        ),
        input(
          Some(SearchQueryTypeEnum::Match),
          Some("beta"),
          Some("plainText"),
          None,
          vec![],
        ),
      ],
    ))
    .unwrap();
    assert!(matches!(plan, SearchPlan::Boolean { mode: BooleanMode::MustAll, ref branches } if branches.len() == 2));
  }

  #[test]
  fn compile_empty_input_is_empty_query_error() {
    let err = compile_plan(&input(None, None, None, None, vec![])).expect_err("empty input errors");
    assert_eq!(err.code(), ERR_QUERY_EMPTY);
  }
}
