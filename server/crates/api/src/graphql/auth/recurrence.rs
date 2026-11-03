// SPDX-License-Identifier: AGPL-3.0-or-later
//! Scoped native recurrence transport. Calculation and Task writes stay in Application.
use super::database::{DatabaseRichTextCellValueInput, DatabaseRichTextCellValueObjectType, parse_uuid_id};
use crate::{graphql::utils::require_session, state::ApiState};
use async_graphql::{Context, Enum, Error, ErrorExtensions, ID, InputObject, OneofObject, Result, SimpleObject};
use chrono::{DateTime, NaiveDate, NaiveDateTime, Utc, Weekday};
use myoxus_application::{
  database::{DatabaseLimits, DatabaseServiceError, editing::rules::rich_text_value_from_document},
  recurrence::TaskRecurrenceService,
};
use myoxus_domain::{recurrence::*, scheduling::*};
use std::{num::NonZeroU32, sync::Arc};
use uuid::Uuid;

fn invalid() -> Error {
  coded("MIX_RECURRENCE_INVALID", "invalid recurrence input")
}
fn coded(code: &'static str, message: impl Into<String>) -> Error {
  Error::new(message).extend_with(|_, extensions| {
    extensions.set("code", code);
    extensions.set("type", code);
    extensions.set("name", code);
  })
}
fn map_error(error: DatabaseServiceError) -> Error {
  coded(error.code, error.message)
}
fn service(state: &ApiState) -> Result<Arc<TaskRecurrenceService>> {
  state
    .task_recurrence_service()
    .ok_or_else(|| coded("MIX_RECURRENCE_UNAVAILABLE", "native recurrence unavailable"))
}

#[derive(Enum, Debug, Clone, Copy, PartialEq, Eq)]
#[graphql(name = "RecurrenceFrequency", rename_items = "PascalCase")]
pub enum RecurrenceFrequency {
  Daily,
  Weekly,
  Monthly,
  Yearly,
}

#[derive(Enum, Debug, Clone, Copy, PartialEq, Eq)]
#[graphql(name = "RecurrenceWeekday", rename_items = "PascalCase")]
pub enum RecurrenceWeekday {
  Monday,
  Tuesday,
  Wednesday,
  Thursday,
  Friday,
  Saturday,
  Sunday,
}
impl From<RecurrenceWeekday> for Weekday {
  fn from(value: RecurrenceWeekday) -> Self {
    match value {
      RecurrenceWeekday::Monday => Self::Mon,
      RecurrenceWeekday::Tuesday => Self::Tue,
      RecurrenceWeekday::Wednesday => Self::Wed,
      RecurrenceWeekday::Thursday => Self::Thu,
      RecurrenceWeekday::Friday => Self::Fri,
      RecurrenceWeekday::Saturday => Self::Sat,
      RecurrenceWeekday::Sunday => Self::Sun,
    }
  }
}
impl From<Weekday> for RecurrenceWeekday {
  fn from(value: Weekday) -> Self {
    match value {
      Weekday::Mon => Self::Monday,
      Weekday::Tue => Self::Tuesday,
      Weekday::Wed => Self::Wednesday,
      Weekday::Thu => Self::Thursday,
      Weekday::Fri => Self::Friday,
      Weekday::Sat => Self::Saturday,
      Weekday::Sun => Self::Sunday,
    }
  }
}

#[derive(Enum, Debug, Clone, Copy, PartialEq, Eq)]
#[graphql(name = "RecurrenceRelativeUnit", rename_items = "PascalCase")]
pub enum RecurrenceRelativeUnit {
  Days,
  Weeks,
  Months,
}
impl From<RecurrenceRelativeUnit> for RelativeUnit {
  fn from(value: RecurrenceRelativeUnit) -> Self {
    match value {
      RecurrenceRelativeUnit::Days => Self::Days,
      RecurrenceRelativeUnit::Weeks => Self::Weeks,
      RecurrenceRelativeUnit::Months => Self::Months,
    }
  }
}
impl From<RelativeUnit> for RecurrenceRelativeUnit {
  fn from(value: RelativeUnit) -> Self {
    match value {
      RelativeUnit::Days => Self::Days,
      RelativeUnit::Weeks => Self::Weeks,
      RelativeUnit::Months => Self::Months,
    }
  }
}

/// Exactly one civil value; a local timestamp must not carry a UTC offset.
#[derive(OneofObject)]
pub enum RecurrenceValueInput {
  Date(String),
  LocalDateTime(String),
}
impl RecurrenceValueInput {
  fn parse(self) -> Result<ScheduleValue> {
    match self {
      Self::Date(value) => value
        .parse::<NaiveDate>()
        .map(ScheduleValue::Date)
        .map_err(|_| invalid()),
      Self::LocalDateTime(value) => value
        .parse::<NaiveDateTime>()
        .map(ScheduleValue::LocalDateTime)
        .map_err(|_| invalid()),
    }
  }
}

#[derive(InputObject)]
pub struct FixedRecurrenceInput {
  pub frequency: RecurrenceFrequency,
  pub interval: i32,
  pub start: RecurrenceValueInput,
  pub end: Option<RecurrenceValueInput>,
  pub zone: String,
  pub weekdays: Option<Vec<RecurrenceWeekday>>,
  pub day: Option<i32>,
  pub last_day: Option<bool>,
  pub month: Option<i32>,
}

#[derive(InputObject)]
pub struct CompletionRecurrenceInput {
  pub amount: i32,
  pub unit: RecurrenceRelativeUnit,
  pub zone: String,
}

#[derive(OneofObject)]
pub enum RecurrenceRuleInput {
  Fixed(FixedRecurrenceInput),
  AfterCompletion(CompletionRecurrenceInput),
}
fn positive(value: i32) -> Result<NonZeroU32> {
  u32::try_from(value).ok().and_then(NonZeroU32::new).ok_or_else(invalid)
}
impl RecurrenceRuleInput {
  fn parse(self) -> Result<(ScheduleRule, AdmissionZone)> {
    let (rule, zone) = match self {
      Self::AfterCompletion(input) => {
        let zone = AdmissionZone::try_from(input.zone).map_err(|_| invalid())?;
        (
          ScheduleRule::AfterCompletion {
            interval: RelativeInterval {
              amount: positive(input.amount)?,
              unit: input.unit.into(),
            },
            date_only: false,
          },
          zone,
        )
      }
      Self::Fixed(input) => {
        let zone = AdmissionZone::try_from(input.zone).map_err(|_| invalid())?;
        let weekdays = input.weekdays.unwrap_or_default();
        let last = input.last_day.unwrap_or(false);
        let selector = match input.frequency {
          RecurrenceFrequency::Daily
            if weekdays.is_empty() && input.day.is_none() && !last && input.month.is_none() =>
          {
            RecurrenceSelector::Daily
          }
          RecurrenceFrequency::Weekly if input.day.is_none() && !last && input.month.is_none() => {
            RecurrenceSelector::Weekly {
              weekdays: weekdays.into_iter().map(Into::into).collect(),
            }
          }
          RecurrenceFrequency::Monthly
            if weekdays.is_empty() && input.month.is_none() && (last != input.day.is_some()) =>
          {
            RecurrenceSelector::Monthly {
              day: if last {
                MonthDay::Last
              } else {
                MonthDay::Day(positive(input.day.ok_or_else(invalid)?)?.get())
              },
            }
          }
          RecurrenceFrequency::Yearly if weekdays.is_empty() && !last => RecurrenceSelector::Yearly {
            month: positive(input.month.ok_or_else(invalid)?)?.get(),
            day: positive(input.day.ok_or_else(invalid)?)?.get(),
          },
          _ => return Err(invalid()),
        };
        (
          ScheduleRule::Fixed {
            rule: RecurrenceRule {
              selector,
              interval: positive(input.interval)?,
              start: input.start.parse()?,
              end: input.end.map(RecurrenceValueInput::parse).transpose()?,
              zone,
            },
          },
          zone,
        )
      }
    };
    rule.validate(zone).map_err(|_| invalid())?;
    Ok((rule, zone))
  }
}

pub(super) fn parse_calendar_rule(input: FixedRecurrenceInput) -> Result<RecurrenceRule> {
  let (rule, _) = RecurrenceRuleInput::Fixed(input).parse()?;
  match rule {
    ScheduleRule::Fixed { rule } => Ok(rule),
    _ => Err(invalid()),
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "RecurrenceValue")]
pub struct RecurrenceValueObject {
  pub date: Option<String>,
  pub local_date_time: Option<String>,
}
impl From<ScheduleValue> for RecurrenceValueObject {
  fn from(value: ScheduleValue) -> Self {
    match value {
      ScheduleValue::Date(date) => Self {
        date: Some(date.to_string()),
        local_date_time: None,
      },
      ScheduleValue::LocalDateTime(value) => Self {
        date: None,
        local_date_time: Some(value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()),
      },
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "RecurrenceOccurrence")]
pub struct RecurrenceOccurrenceObject {
  pub nominal: RecurrenceValueObject,
  pub due_at: DateTime<Utc>,
}
impl From<Occurrence> for RecurrenceOccurrenceObject {
  fn from(value: Occurrence) -> Self {
    Self {
      nominal: value.nominal.into(),
      due_at: value.due_at,
    }
  }
}

#[derive(Enum, Debug, Clone, Copy, PartialEq, Eq)]
#[graphql(name = "RecurrenceMode", rename_items = "PascalCase")]
pub enum RecurrenceMode {
  Fixed,
  AfterCompletion,
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "RecurrenceRule")]
pub struct RecurrenceRuleObject {
  pub mode: RecurrenceMode,
  pub zone: String,
  pub interval: i64,
  pub frequency: Option<RecurrenceFrequency>,
  pub start: Option<RecurrenceValueObject>,
  pub end: Option<RecurrenceValueObject>,
  pub weekdays: Vec<RecurrenceWeekday>,
  pub day: Option<i64>,
  pub last_day: bool,
  pub month: Option<i64>,
  pub relative_unit: Option<RecurrenceRelativeUnit>,
  pub date_only: bool,
}
impl RecurrenceRuleObject {
  pub(super) fn from_rule(rule: ScheduleRule, zone: AdmissionZone) -> Self {
    let mut output = Self {
      mode: RecurrenceMode::Fixed,
      zone: zone.into(),
      interval: 1,
      frequency: None,
      start: None,
      end: None,
      weekdays: vec![],
      day: None,
      last_day: false,
      month: None,
      relative_unit: None,
      date_only: false,
    };
    match rule {
      ScheduleRule::AfterCompletion { interval, date_only } => {
        output.mode = RecurrenceMode::AfterCompletion;
        output.interval = i64::from(interval.amount.get());
        output.relative_unit = Some(interval.unit.into());
        output.date_only = date_only;
      }
      ScheduleRule::Fixed { rule } => {
        output.interval = i64::from(rule.interval.get());
        output.date_only = matches!(rule.start, ScheduleValue::Date(_));
        output.start = Some(rule.start.into());
        output.end = rule.end.map(Into::into);
        output.frequency = Some(match rule.selector {
          RecurrenceSelector::Daily => RecurrenceFrequency::Daily,
          RecurrenceSelector::Weekly { weekdays } => {
            output.weekdays = weekdays.into_iter().map(Into::into).collect();
            RecurrenceFrequency::Weekly
          }
          RecurrenceSelector::Monthly { day } => {
            match day {
              MonthDay::Day(day) => output.day = Some(i64::from(day)),
              MonthDay::Last => output.last_day = true,
            };
            RecurrenceFrequency::Monthly
          }
          RecurrenceSelector::Yearly { month, day } => {
            output.month = Some(i64::from(month));
            output.day = Some(i64::from(day));
            RecurrenceFrequency::Yearly
          }
        });
      }
    }
    output
  }
}

#[derive(InputObject)]
pub struct TaskRecurrenceRecipeInput {
  pub database_id: ID,
  pub title: String,
  /// Use the native document-only input; its plain-text projection is server-owned.
  pub description: Option<DatabaseRichTextCellValueInput>,
  pub assignees: Vec<ID>,
  pub priority: Option<String>,
}
impl TaskRecurrenceRecipeInput {
  fn parse(self) -> Result<TaskRecurrenceRecipe> {
    Ok(TaskRecurrenceRecipe {
      database_id: parse_uuid_id(&self.database_id, "databaseId")?,
      title: self.title,
      description: self
        .description
        .map(|value| rich_text_value_from_document(value.document.0, &DatabaseLimits::default()))
        .transpose()
        .map_err(map_error)?,
      assignees: self
        .assignees
        .iter()
        .map(|id| parse_uuid_id(id, "assigneeId"))
        .collect::<Result<_>>()?,
      priority: self.priority,
    })
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "TaskRecurrenceRecipe")]
pub struct TaskRecurrenceRecipeObject {
  pub database_id: ID,
  pub title: String,
  pub description: Option<DatabaseRichTextCellValueObjectType>,
  pub assignees: Vec<ID>,
  pub priority: Option<String>,
}
impl From<TaskRecurrenceRecipe> for TaskRecurrenceRecipeObject {
  fn from(value: TaskRecurrenceRecipe) -> Self {
    Self {
      database_id: value.database_id.to_string().into(),
      title: value.title,
      description: value.description.map(|value| DatabaseRichTextCellValueObjectType {
        plain_text: value.plain_text,
        document: async_graphql::Json(value.document),
      }),
      assignees: value.assignees.into_iter().map(|id| id.to_string().into()).collect(),
      priority: value.priority,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "TaskRecurrenceMember")]
pub struct TaskRecurrenceMemberObject {
  pub id: ID,
  pub occurrence_id: Option<ID>,
  pub row_id: ID,
  pub captured_database_id: ID,
  pub slot: Option<RecurrenceOccurrenceObject>,
  pub advanced_at: Option<DateTime<Utc>>,
  pub advance_kind: Option<String>,
  pub successor_occurrence_id: Option<ID>,
}
impl From<TaskRecurrenceMember> for TaskRecurrenceMemberObject {
  fn from(value: TaskRecurrenceMember) -> Self {
    Self {
      id: value.id.to_string().into(),
      occurrence_id: value.occurrence_id.map(|id| id.to_string().into()),
      row_id: value.row_id.to_string().into(),
      captured_database_id: value.database_id.to_string().into(),
      slot: value.slot.map(Into::into),
      advanced_at: value.advanced_at,
      advance_kind: value.advance_kind,
      successor_occurrence_id: value.successor_occurrence_id.map(|id| id.to_string().into()),
    }
  }
}

#[derive(Enum, Debug, Clone, Copy, PartialEq, Eq)]
#[graphql(name = "RecurrenceLifecycle", rename_items = "PascalCase")]
pub enum RecurrenceLifecycle {
  Active,
  Paused,
  Ended,
}
impl From<ScheduleLifecycle> for RecurrenceLifecycle {
  fn from(value: ScheduleLifecycle) -> Self {
    match value {
      ScheduleLifecycle::Active => Self::Active,
      ScheduleLifecycle::Paused => Self::Paused,
      ScheduleLifecycle::Ended => Self::Ended,
    }
  }
}

#[derive(SimpleObject, Clone)]
#[graphql(name = "TaskRecurrence")]
pub struct TaskRecurrenceObject {
  pub id: ID,
  pub workspace_id: ID,
  pub actor_id: Option<ID>,
  pub current_member_id: Option<ID>,
  pub revision: i64,
  pub generation: i64,
  pub lifecycle: RecurrenceLifecycle,
  pub rule: RecurrenceRuleObject,
  pub recipe: TaskRecurrenceRecipeObject,
  pub paused_at: Option<DateTime<Utc>>,
  pub blocked_reason: Option<String>,
  pub next: Option<RecurrenceOccurrenceObject>,
  pub pending: Option<RecurrenceOccurrenceObject>,
  pub preserved_next: Option<TaskRecurrenceMemberObject>,
  pub effective_after: Option<TaskRecurrenceMemberObject>,
  pub members: Vec<TaskRecurrenceMemberObject>,
}
impl TaskRecurrenceObject {
  fn from_view(value: TaskRecurrenceRead) -> Result<Self> {
    let rule = value.schedule.rule.ok_or_else(invalid)?;
    Ok(Self {
      id: value.series.id.to_string().into(),
      workspace_id: value.series.workspace_id.to_string().into(),
      actor_id: value.schedule.actor_id.map(|id| id.to_string().into()),
      current_member_id: value.series.current_member_id.map(|id| id.to_string().into()),
      revision: value.schedule.revision,
      generation: value.schedule.generation,
      lifecycle: value.schedule.lifecycle.into(),
      rule: RecurrenceRuleObject::from_rule(rule, value.schedule.zone),
      recipe: value.series.recipe.into(),
      paused_at: value.paused_at,
      blocked_reason: value.schedule.blocked_reason,
      next: value.schedule.next.map(Into::into),
      pending: value.pending.map(Into::into),
      preserved_next: value.preserved_next.map(Into::into),
      effective_after: value.effective_after.map(Into::into),
      members: value.members.into_iter().map(Into::into).collect(),
    })
  }
}

#[derive(OneofObject)]
pub enum TaskRecurrenceLookupInput {
  SeriesId(ID),
  RowId(ID),
}

#[derive(InputObject)]
pub struct RecurrencePreviewInput {
  pub rule: RecurrenceRuleInput,
  pub after: Option<DateTime<Utc>>,
  pub completion_reference: Option<RecurrenceValueInput>,
  /// Optional native series-edit boundary; must accompany its current revision.
  pub series_id: Option<ID>,
  pub expected_revision: Option<i64>,
  #[graphql(default = 5)]
  pub count: i32,
}
#[derive(SimpleObject, Clone)]
#[graphql(name = "RecurrencePreview")]
pub struct RecurrencePreviewObject {
  pub occurrence: RecurrenceOccurrenceObject,
  pub completion_reference: Option<RecurrenceValueObject>,
}

#[derive(InputObject)]
pub struct ConfigureTaskRecurrenceInput {
  pub workspace_id: ID,
  pub database_id: ID,
  pub row_id: ID,
  pub expected_row_revision: i64,
  pub expected_due_revision: i64,
  pub rule: RecurrenceRuleInput,
  pub recipe: TaskRecurrenceRecipeInput,
}
#[derive(InputObject)]
pub struct TaskRecurrenceControlInput {
  pub workspace_id: ID,
  pub series_id: ID,
  pub expected_revision: i64,
}
#[derive(InputObject)]
pub struct UpdateTaskRecurrenceInput {
  pub workspace_id: ID,
  pub series_id: ID,
  pub expected_revision: i64,
  pub rule: RecurrenceRuleInput,
  pub recipe: TaskRecurrenceRecipeInput,
}
#[derive(InputObject)]
pub struct SkipTaskRecurrenceInput {
  pub workspace_id: ID,
  pub series_id: ID,
  pub member_id: ID,
  pub expected_revision: i64,
  pub expected_row_revision: i64,
  pub expected_status_revision: i64,
}

#[tracing::instrument(skip_all)]
pub(crate) async fn read(
  ctx: &Context<'_>,
  workspace: Uuid,
  input: TaskRecurrenceLookupInput,
) -> Result<Option<TaskRecurrenceObject>> {
  let (state, session) = require_session(ctx).await?;
  let service = service(&state)?;
  let value = match input {
    TaskRecurrenceLookupInput::SeriesId(id) => {
      service
        .read(session.user.id, workspace, parse_uuid_id(&id, "seriesId")?)
        .await
    }
    TaskRecurrenceLookupInput::RowId(id) => {
      service
        .for_row(session.user.id, workspace, parse_uuid_id(&id, "rowId")?)
        .await
    }
  }
  .map_err(map_error)?;
  value.map(TaskRecurrenceObject::from_view).transpose()
}

#[tracing::instrument(skip_all)]
pub(crate) async fn list(
  ctx: &Context<'_>,
  workspace: Uuid,
  after: Option<ID>,
  first: Option<i32>,
) -> Result<Vec<TaskRecurrenceObject>> {
  let (state, session) = require_session(ctx).await?;
  let after = after.as_ref().map(|id| parse_uuid_id(id, "after")).transpose()?;
  let first = u32::try_from(first.unwrap_or(20)).map_err(|_| invalid())?;
  if !(1..=50).contains(&first) {
    return Err(invalid());
  }
  service(&state)?
    .list(session.user.id, workspace, after, first)
    .await
    .map_err(map_error)?
    .into_iter()
    .map(TaskRecurrenceObject::from_view)
    .collect()
}

#[tracing::instrument(skip_all)]
pub(crate) async fn preview(
  ctx: &Context<'_>,
  workspace: Uuid,
  input: RecurrencePreviewInput,
) -> Result<Vec<RecurrencePreviewObject>> {
  let (state, session) = require_session(ctx).await?;
  let (rule, zone) = input.rule.parse()?;
  let count = u8::try_from(input.count).map_err(|_| invalid())?;
  let change = match (input.series_id, input.expected_revision) {
    (Some(id), Some(revision)) => Some((parse_uuid_id(&id, "seriesId")?, revision)),
    (None, None) => None,
    _ => return Err(invalid()),
  };
  service(&state)?
    .preview(
      session.user.id,
      workspace,
      rule,
      zone,
      input.after,
      input
        .completion_reference
        .map(RecurrenceValueInput::parse)
        .transpose()?,
      count,
      change,
    )
    .await
    .map_err(map_error)
    .map(|items| {
      items
        .into_iter()
        .map(|item| RecurrencePreviewObject {
          occurrence: item.occurrence.into(),
          completion_reference: item.completion_reference.map(Into::into),
        })
        .collect()
    })
}

#[tracing::instrument(skip_all)]
pub(crate) async fn configure(ctx: &Context<'_>, input: ConfigureTaskRecurrenceInput) -> Result<TaskRecurrenceObject> {
  let (state, session) = require_session(ctx).await?;
  let service = service(&state)?;
  let workspace = parse_uuid_id(&input.workspace_id, "workspaceId")?;
  let (rule, zone) = input.rule.parse()?;
  let activation = service
    .configure(ConfigureTaskRecurrence {
      workspace_id: workspace,
      actor_id: session.user.id,
      database_id: parse_uuid_id(&input.database_id, "databaseId")?,
      row_id: parse_uuid_id(&input.row_id, "rowId")?,
      expected_row_revision: input.expected_row_revision,
      expected_due_revision: input.expected_due_revision,
      rule,
      zone,
      recipe: input.recipe.parse()?,
    })
    .await
    .map_err(map_error)?;
  let view = service
    .read(session.user.id, workspace, activation.series.id)
    .await
    .map_err(map_error)?
    .ok_or_else(invalid)?;
  TaskRecurrenceObject::from_view(view)
}

#[tracing::instrument(skip_all)]
pub(crate) async fn control(
  ctx: &Context<'_>,
  input: TaskRecurrenceControlInput,
  change: TaskRecurrenceChange,
) -> Result<TaskRecurrenceObject> {
  let (state, session) = require_session(ctx).await?;
  let view = service(&state)?
    .control(TaskRecurrenceControl {
      workspace_id: parse_uuid_id(&input.workspace_id, "workspaceId")?,
      series_id: parse_uuid_id(&input.series_id, "seriesId")?,
      actor_id: session.user.id,
      expected_revision: input.expected_revision,
      change,
    })
    .await
    .map_err(map_error)?;
  TaskRecurrenceObject::from_view(view)
}

pub(crate) async fn update(ctx: &Context<'_>, input: UpdateTaskRecurrenceInput) -> Result<TaskRecurrenceObject> {
  let (rule, zone) = input.rule.parse()?;
  control(
    ctx,
    TaskRecurrenceControlInput {
      workspace_id: input.workspace_id,
      series_id: input.series_id,
      expected_revision: input.expected_revision,
    },
    TaskRecurrenceChange::Update {
      rule,
      zone,
      recipe: input.recipe.parse()?,
    },
  )
  .await
}

#[tracing::instrument(skip_all)]
pub(crate) async fn skip(ctx: &Context<'_>, input: SkipTaskRecurrenceInput) -> Result<TaskRecurrenceObject> {
  let (state, session) = require_session(ctx).await?;
  let view = service(&state)?
    .skip(TaskRecurrenceSkip {
      workspace_id: parse_uuid_id(&input.workspace_id, "workspaceId")?,
      series_id: parse_uuid_id(&input.series_id, "seriesId")?,
      member_id: parse_uuid_id(&input.member_id, "memberId")?,
      actor_id: session.user.id,
      expected_revision: input.expected_revision,
      expected_row_revision: input.expected_row_revision,
      expected_status_revision: input.expected_status_revision,
    })
    .await
    .map_err(map_error)?;
  TaskRecurrenceObject::from_view(view)
}
