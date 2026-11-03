// SPDX-License-Identifier: AGPL-3.0-or-later
//! One consuming native Task recurrence journey, without Redis wake-ups.

use crate::helpers;
use async_trait::async_trait;
use chrono::{Duration, SubsecRound, Utc};
use futures_util::FutureExt;
use myoxus_application::{
  recurrence::TaskRecurrenceService,
  scheduling::admission::RecurringTaskSource,
  workspace_automation::{
    recurring_task,
    runtime::{WorkspaceAutomationRuntime, freeze_definition},
  },
};
use myoxus_domain::{database::*, recurrence::*, scheduling::*, workspace_automation::*};
use myoxus_infrastructure::{
  recurrence::PgTaskRecurrenceRepository, scheduling::PgSchedulingRepository,
  workflow_runtime::GlirulusWorkspaceAutomationRuntime, workspace_database::PgDatabaseRepository,
};
use std::{
  panic::AssertUnwindSafe,
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
  time::Duration as StdDuration,
};
use uuid::Uuid;

fn value_input(value: ScheduleValue) -> serde_json::Value {
  match value {
    ScheduleValue::Date(date) => serde_json::json!({"date":date.to_string()}),
    ScheduleValue::LocalDateTime(value) => {
      serde_json::json!({"localDateTime":value.format("%Y-%m-%dT%H:%M:%S%.f").to_string()})
    }
  }
}

fn recipe_input(recipe: TaskRecurrenceRecipe) -> serde_json::Value {
  serde_json::json!({"databaseId":recipe.database_id,"title":recipe.title,
    "description":recipe.description.map(|value|serde_json::json!({"document":value.document})),
    "assignees":recipe.assignees,"priority":recipe.priority})
}

fn rule_input(rule: &ScheduleRule, zone: AdmissionZone) -> serde_json::Value {
  match rule {
    ScheduleRule::Fixed { rule } => {
      assert!(
        matches!(rule.selector, RecurrenceSelector::Daily),
        "the existing consuming fixture uses daily rules"
      );
      serde_json::json!({"fixed":{"frequency":"Daily","interval":rule.interval.get(),"start":value_input(rule.start),
        "end":rule.end.map(value_input),"zone":String::from(rule.zone)}})
    }
    ScheduleRule::AfterCompletion { interval, .. } => {
      serde_json::json!({"afterCompletion":{"amount":interval.amount.get(),
      "unit":match interval.unit {RelativeUnit::Days=>"Days",RelativeUnit::Weeks=>"Weeks",RelativeUnit::Months=>"Months"},
      "zone":String::from(zone)}})
    }
  }
}

async fn configure(
  app: &axum::Router,
  state: &myoxus_api::state::ApiState,
  session: Uuid,
  command: ConfigureTaskRecurrence,
) -> Result<TaskRecurrenceActivation, serde_json::Value> {
  let rule = rule_input(&command.rule, command.zone);
  let response=helpers::gql(app,session,serde_json::json!({"query":
    "mutation Configure($input:ConfigureTaskRecurrenceInput!){configureTaskRecurrence(input:$input){id}}",
    "variables":{"input":{"workspaceId":command.workspace_id,"databaseId":command.database_id,"rowId":command.row_id,
      "expectedRowRevision":command.expected_row_revision,"expectedDueRevision":command.expected_due_revision,"rule":rule,
      "recipe":recipe_input(command.recipe)}}})).await;
  if response.get("errors").is_some() {
    return Err(response);
  }
  let id = response["data"]["configureTaskRecurrence"]["id"]
    .as_str()
    .unwrap()
    .parse()
    .unwrap();
  let series = state
    .task_recurrence_service()
    .unwrap()
    .read(command.actor_id, command.workspace_id, id)
    .await
    .unwrap()
    .unwrap()
    .series;
  let member = state
    .database_services()
    .unwrap()
    .views
    .get_row(command.actor_id, command.database_id, command.row_id)
    .await
    .unwrap()
    .unwrap();
  Ok(TaskRecurrenceActivation {
    series,
    member: DatabaseRowRecord {
      row: member.row,
      cells: member.cells,
      cell_revisions: member.cell_revisions,
    },
  })
}

async fn control_graphql(
  app: &axum::Router,
  state: &myoxus_api::state::ApiState,
  session: Uuid,
  command: TaskRecurrenceControl,
) -> Result<TaskRecurrenceRead, serde_json::Value> {
  let mut input = serde_json::json!({"workspaceId":command.workspace_id,"seriesId":command.series_id,"expectedRevision":command.expected_revision});
  let (operation, input_type) = match command.change {
    TaskRecurrenceChange::Pause => ("pauseTaskRecurrence", "TaskRecurrenceControlInput"),
    TaskRecurrenceChange::Resume => ("resumeTaskRecurrence", "TaskRecurrenceControlInput"),
    TaskRecurrenceChange::End => ("endTaskRecurrence", "TaskRecurrenceControlInput"),
    TaskRecurrenceChange::Update { rule, zone, recipe } => {
      input["rule"] = rule_input(&rule, zone);
      input["recipe"] = recipe_input(recipe);
      ("updateTaskRecurrence", "UpdateTaskRecurrenceInput")
    }
  };
  let response = helpers::gql(
    app,
    session,
    serde_json::json!({"query":format!(
    "mutation Control($input:{input_type}!){{{operation}(input:$input){{id}}}}"),"variables":{"input":input}}),
  )
  .await;
  if response.get("errors").is_some() {
    return Err(response);
  }
  Ok(
    state
      .task_recurrence_service()
      .unwrap()
      .read(command.actor_id, command.workspace_id, command.series_id)
      .await
      .unwrap()
      .unwrap(),
  )
}

async fn skip_graphql(
  app: &axum::Router,
  state: &myoxus_api::state::ApiState,
  session: Uuid,
  command: TaskRecurrenceSkip,
) -> Result<TaskRecurrenceRead, serde_json::Value> {
  let response = helpers::gql(
    app,
    session,
    serde_json::json!({"query":
    "mutation Skip($input:SkipTaskRecurrenceInput!){skipTaskRecurrence(input:$input){id}}","variables":{"input":{
      "workspaceId":command.workspace_id,"seriesId":command.series_id,"memberId":command.member_id,
      "expectedRevision":command.expected_revision,"expectedRowRevision":command.expected_row_revision,
      "expectedStatusRevision":command.expected_status_revision}}}),
  )
  .await;
  if response.get("errors").is_some() {
    return Err(response);
  }
  Ok(
    state
      .task_recurrence_service()
      .unwrap()
      .read(command.actor_id, command.workspace_id, command.series_id)
      .await
      .unwrap()
      .unwrap(),
  )
}

/// Admission failure injection is synthetic; successful Task preparation uses
/// the productive recipe/permission service and canonical native Task writer.
struct RepairableSource {
  native: Arc<TaskRecurrenceService>,
  blocked_series: Uuid,
  blocked: AtomicBool,
}
#[async_trait]
impl RecurringTaskSource for RepairableSource {
  async fn prepare(&self, plan: &ScheduledPlan, slot: Occurrence) -> Result<AcceptedRecurringTask, &'static str> {
    if plan.id == self.blocked_series && self.blocked.load(Ordering::SeqCst) {
      return Err("taskDestinationUnavailable");
    }
    self.native.prepare(plan, slot).await
  }
}

async fn wait_for_effects(pool: &sqlx::PgPool, ids: &[Uuid], count: i64) {
  tokio::time::timeout(StdDuration::from_secs(30), async {
    loop {
      let acknowledged: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workspace_automation_actions WHERE run_id=ANY($1) AND status='succeeded'",
      )
      .bind(ids)
      .fetch_one(pool)
      .await
      .unwrap();
      if acknowledged == count {
        break;
      }
      tokio::time::sleep(StdDuration::from_millis(25)).await;
    }
  })
  .await
  .expect("native Task creation/ACK without Redis or optional Rules");
}

#[test]
fn recurring_task_admission_and_native_effect_are_durable_without_optional_automations() {
  helpers::block_on_large_stack("recurring-task-contract", || async {
    let _logging = tracing::subscriber::set_default(
      tracing_subscriber::fmt()
        .with_env_filter("myoxus_infrastructure::scheduling=warn")
        .with_test_writer()
        .finish(),
    );
    let (app, pool, auth, state) = helpers::setup_app_with_template_registry_and_sql_notifications_state().await;
    let (actor, actor_session) = helpers::seed_user(&pool, &auth, "recurring-task-owner").await;
    let (observer, observer_session) = helpers::seed_user(&pool, &auth, "recurring-task-reader").await;
    let workspace = helpers::create_workspace(&pool, actor).await;
    let services = state.database_services().unwrap();
    let mut runtime = Arc::new(
      GlirulusWorkspaceAutomationRuntime::new(
        pool.clone(),
        state.workspace_automation_service().unwrap().native_executor(),
      )
      .with_optional_automations_enabled(false),
    );
    let failure = format!("recurrence_snapshot_{}", Uuid::new_v4().simple());
    let mut run_ids = Vec::new();
    let outcome = AssertUnwindSafe(async {
      state.workspace().seed_root_doc(workspace,actor,yjs::create_initial_workspace_doc("Recurrence contract")).await.unwrap();
      let database: Uuid = sqlx::query_scalar("SELECT id FROM workspace_databases WHERE workspace_id=$1 AND system_role='workspace_tasks'")
        .bind(workspace).fetch_one(&pool).await.unwrap();
      let record = services.definition.get_database(actor,database).await.unwrap();
      let field = |role:&str| record.field_roles.iter().find(|field|field.role_key==role).unwrap().field_id;
      let status_field = field("task.status");
      let due_field = field("task.dueDate");
      let DatabaseFieldConfig::Status(status) = &record.fields.iter().find(|field|field.id==status_field).unwrap().config
        else { panic!("native Task status") };
      let open = status.options.iter().find(|option|option.group==DatabaseStatusGroup::NotStarted).unwrap().id.clone();
      let DatabaseFieldConfig::Select(priority) = &record.fields.iter().find(|candidate|candidate.id==field("task.priority")).unwrap().config
        else { panic!("native Task priority") };
      let recipe = TaskRecurrenceRecipe { database_id:database,title:"Frozen recurring Task".into(),
        description:Some(DatabaseRichTextValue { plain_text:"Frozen description".into(),
          document:serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Frozen description"}]}]}) }),
        assignees:vec![actor],priority:Some(priority.options[0].id.clone()) };
      let native = Arc::new(TaskRecurrenceService::new(Arc::new(PgTaskRecurrenceRepository::new(pool.clone(),
        Arc::new(PgDatabaseRepository::new(pool.clone(),helpers::database_starter_catalog())))),services.editing.clone()));
      runtime.readiness().await.unwrap();
      let optional = freeze_definition(vec![WorkspaceAutomationActionDefinition {position:0,
        config:WorkspaceAutomationActionConfig::CreateRow { database_id:database,title_template:None,cells:vec![] }}],
        myoxus_application::scheduling::admission::task_policy()).unwrap();
      assert!(runtime.register_definition(optional).await.is_err(),"ordinary Rule definitions remain disabled");
      let now = Utc::now().trunc_subsecs(6);
      let zone = AdmissionZone::try_from("Europe/Berlin".to_owned()).unwrap();
      let first_due = now+Duration::hours(1);
      let rule = RecurrenceRule { selector:RecurrenceSelector::Daily,interval:std::num::NonZeroU32::new(1).unwrap(),
        start:ScheduleValue::LocalDateTime(first_due.with_timezone(&zone.timezone()).naive_local()),end:None,zone };
      let mut activations = Vec::new();
      for index in 0..3 {
        let mut initial = vec![(status_field,DatabaseCellValueData::Status(open.clone()))];
        if index==1 {initial.push((due_field,DatabaseCellValueData::DateTime(recurring_task::due_value(
          Occurrence {nominal:rule.start,due_at:first_due},zone))));}
        let original = services.editing.create_row(actor,database,Some("Original open Task".into()),
          initial).await.unwrap();
        let original_due_revision = original.cells.iter().find(|cell|cell.field_id==due_field).map_or(0,|cell|cell.edit_revision);
        let active = configure(&app,&state,actor_session,ConfigureTaskRecurrence{workspace_id:workspace,actor_id:actor,
          database_id:database,row_id:original.row.id,expected_row_revision:original.row.edit_revision,
          expected_due_revision:original_due_revision,rule:ScheduleRule::Fixed{rule:rule.clone()},zone,recipe:recipe.clone()}).await.unwrap();
        assert_eq!(active.member.row.id,original.row.id,"activation adopts, never duplicates, the original Task");
        let due = active.member.cells.iter().find(|cell|cell.field_id==due_field).unwrap();
        if index==1 {assert_eq!(due.edit_revision,original_due_revision,"unchanged first Due is not rewritten");}
        assert_eq!(due.value,DatabaseCellValueData::DateTime(recurring_task::due_value(
          Occurrence { nominal:rule.start,due_at:first_due },zone)));
        assert!(configure(&app,&state,actor_session,ConfigureTaskRecurrence{workspace_id:workspace,actor_id:actor,
          database_id:database,row_id:active.member.row.id,expected_row_revision:active.member.row.edit_revision,
          expected_due_revision:due.edit_revision,rule:ScheduleRule::Fixed{rule:rule.clone()},zone,recipe:recipe.clone()})
          .await.is_err(),"one active series per adopted member");
        activations.push(active);
      }
      let ids = activations.iter().map(|active|active.series.id).collect::<Vec<_>>();
      let read=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "query Read($workspace:String!,$input:TaskRecurrenceLookupInput!){workspace(id:$workspace){taskRecurrence(input:$input){id lifecycle recipe{title} rule{zone mode} members{rowId}} taskRecurrences(first:2){id}}}",
        "variables":{"workspace":workspace,"input":{"rowId":activations[0].member.row.id}}})).await;
      assert!(read.get("errors").is_none(),"{read:?}");
      assert_eq!(read["data"]["workspace"]["taskRecurrence"]["id"],ids[0].to_string());
      assert_eq!(read["data"]["workspace"]["taskRecurrences"].as_array().unwrap().len(),2);
      let preview=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "query Preview($workspace:String!,$input:RecurrencePreviewInput!){workspace(id:$workspace){recurrencePreview(input:$input){occurrence{nominal{date localDateTime} dueAt} completionReference{date localDateTime}}}}",
        "variables":{"workspace":workspace,"input":{"rule":rule_input(&ScheduleRule::Fixed{rule:rule.clone()},zone),"count":5}}})).await;
      assert!(preview.get("errors").is_none(),"{preview:?}");
      let preview=preview["data"]["workspace"]["recurrencePreview"].as_array().unwrap();
      assert_eq!(preview.len(),5);
      assert_eq!(chrono::DateTime::parse_from_rfc3339(preview[0]["occurrence"]["dueAt"].as_str().unwrap()).unwrap().with_timezone(&Utc),first_due);
      let foreign=helpers::create_workspace(&pool,actor).await;
      let foreign_read=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "query Read($workspace:String!,$input:TaskRecurrenceLookupInput!){workspace(id:$workspace){taskRecurrence(input:$input){id recipe{title}}}}",
        "variables":{"workspace":foreign,"input":{"seriesId":ids[0]}}})).await;
      assert!(foreign_read.get("errors").is_none(),"{foreign_read:?}");
      assert!(foreign_read["data"]["workspace"]["taskRecurrence"].is_null(),"another workspace cannot disclose a recipe");
      let wrong_scope=services.editing.create_row(actor,database,Some("Scoped confirmation".into()),vec![]).await.unwrap();
      assert!(configure(&app,&state,actor_session,ConfigureTaskRecurrence{workspace_id:foreign,actor_id:actor,
        database_id:database,row_id:wrong_scope.row.id,expected_row_revision:wrong_scope.row.edit_revision,expected_due_revision:0,
        rule:ScheduleRule::Fixed{rule:rule.clone()},zone,recipe:recipe.clone()}).await.is_err());
      let escaped:i64=sqlx::query_scalar("SELECT count(*) FROM task_recurrence_members WHERE row_id=$1")
        .bind(wrong_scope.row.id).fetch_one(&pool).await.unwrap();
      assert_eq!(escaped,0,"a mismatched workspace must fail before native adoption commits");
      services.editing.delete_row(actor,database,wrong_scope.row.id).await.unwrap();
      let source = Arc::new(RepairableSource {native,blocked_series:ids[0],blocked:AtomicBool::new(true)});
      let scheduler = PgSchedulingRepository::new(pool.clone(),runtime.clone()).with_task_source(source.clone());
      let early = scheduler.dispatch_due(now,50).await.unwrap();
      assert_eq!(early.admitted,0,"the adopted future Task already is the one future member");
      let rows: i64 = sqlx::query_scalar("SELECT count(*) FROM workspace_database_rows WHERE database_id=$1")
        .bind(database).fetch_one(&pool).await.unwrap();
      assert_eq!(rows,4);
      let second = myoxus_application::scheduling::next_after(&rule,first_due,CalculationBudget::default()).unwrap().unwrap();
      for id in &ids {run_ids.push(Uuid::new_v5(&occurrence_id(*id,second.nominal),b"run"));}
      sqlx::query(&format!("CREATE FUNCTION {failure}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.instance_id='{}' THEN RAISE EXCEPTION 'owned recurrence snapshot failure'; END IF; RETURN NEW; END $$",run_ids[2]))
        .execute(&pool).await.unwrap();
      sqlx::query(&format!("CREATE TRIGGER {failure} BEFORE INSERT ON sayiir_workflow_snapshots FOR EACH ROW EXECUTE FUNCTION {failure}()"))
        .execute(&pool).await.unwrap();
      let (a,b) = tokio::join!(scheduler.dispatch_due(first_due,50),scheduler.dispatch_due(first_due,50));
      let reports = (a.unwrap(),b.unwrap());
      let counts:(i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM scheduling_occurrences WHERE schedule_id=$1),(SELECT count(*) FROM workspace_automation_runs WHERE id=$2),(SELECT count(*) FROM sayiir_workflow_snapshots WHERE instance_id=$3)")
        .bind(ids[2]).bind(run_ids[2]).bind(run_ids[2].to_string()).fetch_one(&pool).await.unwrap();
      assert_eq!(counts,(1,0,0),"failed admission retains only the pre-existing adopted slot");
      let reason:Option<String> = sqlx::query_scalar("SELECT blocked_reason FROM scheduling_schedules WHERE id=$1")
        .bind(ids[2]).fetch_one(&pool).await.unwrap();
      assert_eq!(reason.as_deref(),Some("taskRuntimeUnavailable"),"the snapshot failure must actually be reached");
      let counts:(i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM scheduling_occurrences WHERE schedule_id=$1),(SELECT count(*) FROM workspace_automation_runs WHERE id=$2),(SELECT count(*) FROM sayiir_workflow_snapshots WHERE instance_id=$3)")
        .bind(ids[1]).bind(run_ids[1]).bind(run_ids[1].to_string()).fetch_one(&pool).await.unwrap();
      assert_eq!(counts,(2,1,1),"blocked target isolation and unique admission: {reports:?}");
      let pending:(Option<serde_json::Value>,Option<String>) = sqlx::query_as("SELECT next_nominal,blocked_reason FROM scheduling_schedules WHERE id=$1")
        .bind(ids[0]).fetch_one(&pool).await.unwrap();
      assert_eq!(pending.0,Some(serde_json::to_value(second.nominal).unwrap()));
      assert_eq!(pending.1.as_deref(),Some("taskDestinationUnavailable"));
      sqlx::query(&format!("DROP TRIGGER {failure} ON sayiir_workflow_snapshots")).execute(&pool).await.unwrap();
      sqlx::query(&format!("DROP FUNCTION {failure}()")).execute(&pool).await.unwrap();
      scheduler.dispatch_due(first_due+Duration::seconds(31),50).await.unwrap();
      runtime.start().await.unwrap();
      wait_for_effects(&pool,&run_ids,2).await;
      let row_id = Uuid::new_v5(&occurrence_id(ids[1],second.nominal),b"row");
      let row = services.views.get_row(actor,database,row_id).await.unwrap().unwrap();
      assert_eq!(row.row.row_kind,DatabaseRowKind::Task);
      assert!(row.row.content_document_id.is_none());
      assert_eq!(row.row.title,recipe.title);
      for (role,value) in [("task.description",DatabaseCellValueData::RichText(recipe.description.clone().unwrap())),
        ("task.assignees",DatabaseCellValueData::Users(recipe.assignees.clone())),
        ("task.priority",DatabaseCellValueData::Select(recipe.priority.clone().unwrap())),
        ("task.dueDate",DatabaseCellValueData::DateTime(recurring_task::due_value(second,zone)))] {
        assert_eq!(row.cells.iter().find(|cell|cell.field_id==field(role)).unwrap().value,value);
      }
      let members:i64 = sqlx::query_scalar("SELECT count(*) FROM task_recurrence_members WHERE series_id=$1")
        .bind(ids[1]).fetch_one(&pool).await.unwrap();
      assert_eq!(members,2,"native creation and member association share the ACK commit");
      services.editing.delete_row(actor,database,row_id).await.unwrap();
      sqlx::query("UPDATE scheduling_schedules SET next_nominal=$2,next_due_at=$3,next_admission_at=$4 WHERE id=$1")
        .bind(ids[1]).bind(serde_json::to_value(second.nominal).unwrap()).bind(second.due_at).bind(first_due).execute(&pool).await.unwrap();
      let replay = scheduler.dispatch_due(first_due,50).await.unwrap();
      assert_eq!((replay.admitted,replay.blocked,replay.raced),(0,0,0));
      let deleted:bool = sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM workspace_database_rows WHERE id=$1")
        .bind(row_id).fetch_one(&pool).await.unwrap();
      assert!(deleted,"an acknowledged deleted member is never recreated");
      // A multi-day outage admits newest missed plus exactly one future, never
      // every elapsed slot. Original older open members remain native Tasks.
      let recovery = first_due+Duration::days(5)+Duration::minutes(1);
      let missed = myoxus_application::scheduling::window(&rule,recovery-Duration::days(1),recovery,
        CalculationBudget::default()).unwrap().pop().unwrap();
      let future = myoxus_application::scheduling::next_after(&rule,recovery,CalculationBudget::default()).unwrap().unwrap();
      for id in &ids[1..] {for slot in [missed,future] {
        run_ids.push(Uuid::new_v5(&occurrence_id(*id,slot.nominal),b"run"));
      }}
      scheduler.dispatch_due(recovery,50).await.unwrap();
      wait_for_effects(&pool,&run_ids,6).await;
      let dues:Vec<chrono::DateTime<Utc>> = sqlx::query_scalar("SELECT o.nominal_due_at FROM task_recurrence_members m JOIN scheduling_occurrences o ON o.id=m.occurrence_id WHERE m.series_id=$1 ORDER BY o.nominal_due_at")
        .bind(ids[1]).fetch_all(&pool).await.unwrap();
      assert_eq!(dues,vec![first_due,second.due_at,missed.due_at,future.due_at]);
      assert!(services.views.get_row(actor,database,activations[1].member.row.id).await.unwrap().is_some(),"older open Tasks survive advancement");
      source.blocked.store(false,Ordering::SeqCst);
      for slot in [missed,future] {run_ids.push(Uuid::new_v5(&occurrence_id(ids[0],slot.nominal),b"run"));}
      scheduler.dispatch_due(recovery+Duration::seconds(31),50).await.unwrap();
      wait_for_effects(&pool,&run_ids,8).await;
      let repaired:Vec<chrono::DateTime<Utc>> = sqlx::query_scalar("SELECT o.nominal_due_at FROM task_recurrence_members m JOIN scheduling_occurrences o ON o.id=m.occurrence_id WHERE m.series_id=$1 ORDER BY o.nominal_due_at")
        .bind(ids[0]).fetch_all(&pool).await.unwrap();
      assert_eq!(repaired,vec![first_due,missed.due_at,future.due_at],"repair preserves the same bounded recovery policy");
      // Early completion of consecutive all-day members may legitimately yield
      // the same next Due. The advancing member, not that date, owns identity.
      let complete = status.options.iter().find(|option|option.group==DatabaseStatusGroup::Complete).unwrap().id.clone();
      // Stay hours away from midnight without a product clock override.
      let relative_zone = AdmissionZone::try_from(if (6..=18).contains(&chrono::Timelike::hour(&Utc::now())) {
        "UTC".to_owned() } else {"Pacific/Honolulu".to_owned()}).unwrap();
      let tomorrow = Utc::now().with_timezone(&relative_zone.timezone()).date_naive()+chrono::Days::new(1);
      let original = services.editing.create_row(actor,database,Some("Completion-relative original".into()),vec![
        (status_field,DatabaseCellValueData::Status(open.clone())),
        (due_field,DatabaseCellValueData::DateTime(DatabaseDateTimeValue { start:tomorrow.and_time(chrono::NaiveTime::MIN).and_utc(),
          end:None,all_day:true,time_zone:String::from(relative_zone) }))]).await.unwrap();
      let relative = configure(&app,&state,actor_session,ConfigureTaskRecurrence{workspace_id:workspace,actor_id:actor,
        database_id:database,row_id:original.row.id,expected_row_revision:original.row.edit_revision,
        expected_due_revision:original.cells.iter().find(|cell|cell.field_id==due_field).unwrap().edit_revision,
        rule:ScheduleRule::AfterCompletion{interval:RelativeInterval {amount:std::num::NonZeroU32::new(1).unwrap(),unit:RelativeUnit::Days},date_only:false},
        zone:relative_zone,recipe:recipe.clone()}).await.unwrap();
      assert_eq!(relative.member.row.id,original.row.id);
      let conditional=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "query Preview($workspace:String!,$input:RecurrencePreviewInput!){workspace(id:$workspace){recurrencePreview(input:$input){occurrence{nominal{date}} completionReference{date}}}}",
        "variables":{"workspace":workspace,"input":{"rule":rule_input(&ScheduleRule::AfterCompletion{
          interval:RelativeInterval{amount:std::num::NonZeroU32::new(1).unwrap(),unit:RelativeUnit::Days},date_only:true},relative_zone),
          "completionReference":value_input(ScheduleValue::Date(tomorrow)),"count":5}}})).await;
      assert!(conditional.get("errors").is_none(),"{conditional:?}");
      let conditional=conditional["data"]["workspace"]["recurrencePreview"].as_array().unwrap();
      assert_eq!(conditional.len(),5);
      assert_eq!(conditional[0]["completionReference"]["date"],tomorrow.to_string());
      assert_eq!(conditional[1]["completionReference"]["date"],conditional[0]["occurrence"]["nominal"]["date"]);
      let relative_id = relative.series.id;
      let initial_member = relative.series.current_member_id.unwrap();
      let event = Uuid::new_v5(&initial_member,b"completion-wake");
      sqlx::query(&format!("CREATE FUNCTION {failure}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='{event}' THEN RAISE EXCEPTION 'owned recurrence intent failure'; END IF; RETURN NEW; END $$"))
        .execute(&pool).await.unwrap();
      sqlx::query(&format!("CREATE TRIGGER {failure} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION {failure}()"))
        .execute(&pool).await.unwrap();
      let status_revision = original.cells.iter().find(|cell|cell.field_id==status_field).unwrap().edit_revision;
      assert!(services.editing.update_cell_value_with_precondition(actor,database,original.row.id,status_field,
        DatabaseCellValueData::Status(complete.clone()),Some(status_revision),false).await.is_err());
      let unchanged = services.views.get_row(actor,database,original.row.id).await.unwrap().unwrap();
      assert_eq!(unchanged.cells.iter().find(|cell|cell.field_id==status_field).unwrap().value,
        DatabaseCellValueData::Status(open.clone()),"intent failure rolls back native completion");
      let rolled_back:(Option<chrono::DateTime<Utc>>,Option<serde_json::Value>) = sqlx::query_as("SELECT m.advanced_at,s.next_nominal FROM task_recurrence_members m JOIN scheduling_schedules s ON s.id=m.series_id WHERE m.id=$1")
        .bind(initial_member).fetch_one(&pool).await.unwrap();
      assert_eq!(rolled_back,(None,None),"receipt and timing intent share the Cell transaction");
      sqlx::query(&format!("DROP TRIGGER {failure} ON outbox_events")).execute(&pool).await.unwrap();
      sqlx::query(&format!("DROP FUNCTION {failure}()")).execute(&pool).await.unwrap();
      let (first_complete,racing_complete) = tokio::join!(
        services.editing.update_cell_value_with_precondition(actor,database,original.row.id,status_field,
          DatabaseCellValueData::Status(complete.clone()),Some(status_revision),false),
        services.editing.update_cell_value_with_precondition(actor,database,original.row.id,status_field,
          DatabaseCellValueData::Status(complete.clone()),Some(status_revision),false));
      assert_eq!(usize::from(first_complete.is_ok())+usize::from(racing_complete.is_ok()),1,
        "exactly one concurrent native Complete transition commits");
      let first_successor = task_occurrence_id(relative_id,ScheduleValue::Date(tomorrow),Some(initial_member));
      let receipt:(Option<chrono::DateTime<Utc>>,Option<Uuid>) = sqlx::query_as("SELECT advanced_at,successor_occurrence_id FROM task_recurrence_members WHERE id=$1")
        .bind(initial_member).fetch_one(&pool).await.unwrap();
      assert!(receipt.0.is_some());
      assert_eq!(receipt.1,Some(first_successor));
      myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(&pool,&scheduler,event).await.unwrap();
      run_ids.push(Uuid::new_v5(&first_successor,b"run"));
      wait_for_effects(&pool,&run_ids,9).await;
      let next_row = Uuid::new_v5(&first_successor,b"row");
      let next = services.views.get_row(actor,database,next_row).await.unwrap().unwrap();
      let next_due = next.cells.iter().find(|cell|cell.field_id==due_field).unwrap().value.clone();
      assert_eq!(next_due,DatabaseCellValueData::DateTime(DatabaseDateTimeValue {
        start:tomorrow.and_time(chrono::NaiveTime::MIN).and_utc(),end:None,all_day:true,time_zone:String::from(relative_zone) }));
      services.editing.update_cell_value(actor,database,original.row.id,status_field,DatabaseCellValueData::Status(open.clone())).await.unwrap();
      services.editing.update_cell_value(actor,database,original.row.id,status_field,DatabaseCellValueData::Status(complete.clone())).await.unwrap();
      myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(&pool,&scheduler,event).await.unwrap();
      let retained:Vec<Uuid> = sqlx::query_scalar("SELECT id FROM task_recurrence_members WHERE series_id=$1 ORDER BY created_at,id")
        .bind(relative_id).fetch_all(&pool).await.unwrap();
      assert_eq!(retained.len(),2,"reopening/recompleting an older member cannot advance again");
      services.editing.update_cell_value_with_precondition(actor,database,next_row,status_field,DatabaseCellValueData::Status(complete.clone()),
        Some(next.cells.iter().find(|cell|cell.field_id==status_field).unwrap().edit_revision),false).await.unwrap();
      let second_successor = task_occurrence_id(relative_id,ScheduleValue::Date(tomorrow),Some(first_successor));
      assert_ne!(first_successor,second_successor);
      myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(&pool,&scheduler,
        Uuid::new_v5(&first_successor,b"completion-wake")).await.unwrap();
      run_ids.push(Uuid::new_v5(&second_successor,b"run"));
      wait_for_effects(&pool,&run_ids,10).await;
      let final_row = services.views.get_row(actor,database,Uuid::new_v5(&second_successor,b"row")).await.unwrap().unwrap();
      assert_eq!(final_row.cells.iter().find(|cell|cell.field_id==due_field).unwrap().value,next_due);
      let current:Option<Uuid> = sqlx::query_scalar("SELECT current_member_id FROM task_recurrence_series WHERE id=$1")
        .bind(relative_id).fetch_one(&pool).await.unwrap();
      assert_eq!(current,Some(second_successor),"only the designated current completion member advances");

      // A paused Complete retains its first receipt, but Resume, not the old
      // completion timestamp, anchors the deferred successor.
      let control=|id,revision,change|TaskRecurrenceControl{workspace_id:workspace,series_id:id,
        actor_id:actor,expected_revision:revision,change};
      let paused=control_graphql(&app,&state,actor_session,control(relative_id,1,TaskRecurrenceChange::Pause)).await.unwrap();
      assert_eq!(paused.schedule.lifecycle,ScheduleLifecycle::Paused);
      let stale=control_graphql(&app,&state,actor_session,control(relative_id,1,TaskRecurrenceChange::Resume)).await.unwrap_err();
      assert_eq!(stale["errors"][0]["extensions"]["code"],"MIX_DATABASE_CONFLICT");
      services.editing.update_cell_value(actor,database,final_row.row.id,status_field,
        DatabaseCellValueData::Status(complete.clone())).await.unwrap();
      let paused=source.native.read(actor,workspace,relative_id).await.unwrap().unwrap();
      assert!(paused.schedule.next.is_none());
      let deferred=paused.members.iter().find(|member|member.id==second_successor).unwrap();
      assert!(deferred.advanced_at.is_some() && deferred.successor_occurrence_id.is_none());
      let resumed=control_graphql(&app,&state,actor_session,control(relative_id,paused.schedule.revision,TaskRecurrenceChange::Resume)).await.unwrap();
      let cause=resumed.members.iter().find(|member|member.id==second_successor).unwrap();
      let resumed_occurrence=cause.successor_occurrence_id.unwrap();
      let resumed_run=task_run_id(resumed_occurrence,resumed.schedule.generation);
      run_ids.push(resumed_run);
      myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(&pool,&scheduler,
        Uuid::new_v5(&second_successor,b"completion-wake")).await.unwrap();
      wait_for_effects(&pool,&[resumed_run],1).await;
      let next=services.views.get_row(actor,database,Uuid::new_v5(&resumed_occurrence,b"row")).await.unwrap().unwrap();
      let reference:chrono::DateTime<Utc>=sqlx::query_scalar("SELECT successor_reference_at FROM task_recurrence_members WHERE id=$1")
        .bind(second_successor).fetch_one(&pool).await.unwrap();
      assert!(reference>=deferred.advanced_at.unwrap(),"Resume must not backdate its deferred successor");

      // Ordinary Archived does not advance. Explicit Skip does, atomically with
      // native Archived and reminder invalidation, even while pause is retained.
      let archived=status.options.iter().find(|option|option.group==DatabaseStatusGroup::Archived).unwrap().id.clone();
      services.editing.update_cell_value(actor,database,next.row.id,status_field,DatabaseCellValueData::Status(archived.clone())).await.unwrap();
      let ordinary=source.native.read(actor,workspace,relative_id).await.unwrap().unwrap();
      assert!(ordinary.members.iter().find(|member|member.id==resumed_occurrence).unwrap().advanced_at.is_none());
      services.editing.update_cell_value(actor,database,next.row.id,status_field,DatabaseCellValueData::Status(open.clone())).await.unwrap();
      let paused=control_graphql(&app,&state,actor_session,control(relative_id,resumed.schedule.revision,TaskRecurrenceChange::Pause)).await.unwrap();
      // The ordinary reminder API requires a future instant, independently of
      // the series' pinned all-day kind. This occurrence-only edit stays local.
      services.editing.update_cell_value(actor,database,next.row.id,due_field,
        DatabaseCellValueData::DateTime(DatabaseDateTimeValue{start:Utc::now()+Duration::days(2),end:None,
          all_day:false,time_zone:String::from(relative_zone)})).await.unwrap();
      let next=services.views.get_row(actor,database,next.row.id).await.unwrap().unwrap();
      let reminder=services.reminders.set_database_row_reminder(actor,database,next.row.id,due_field,10).await.unwrap();
      let skip=TaskRecurrenceSkip{workspace_id:workspace,series_id:relative_id,member_id:resumed_occurrence,actor_id:actor,
        expected_revision:paused.schedule.revision,expected_row_revision:next.row.edit_revision,
        expected_status_revision:next.cells.iter().find(|cell|cell.field_id==status_field).unwrap().edit_revision};
      let skip_event=Uuid::new_v5(&resumed_occurrence,b"completion-wake");
      sqlx::query(&format!("CREATE FUNCTION {failure}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='{skip_event}' THEN RAISE EXCEPTION 'owned recurrence Skip intent failure'; END IF; RETURN NEW; END $$"))
        .execute(&pool).await.unwrap();
      sqlx::query(&format!("CREATE TRIGGER {failure} BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION {failure}()"))
        .execute(&pool).await.unwrap();
      assert!(skip_graphql(&app,&state,actor_session,skip.clone()).await.is_err());
      let unchanged=services.views.get_row(actor,database,next.row.id).await.unwrap().unwrap();
      assert_eq!(unchanged.cells.iter().find(|cell|cell.field_id==status_field).unwrap().value,DatabaseCellValueData::Status(open.clone()));
      sqlx::query(&format!("DROP TRIGGER {failure} ON outbox_events")).execute(&pool).await.unwrap();
      sqlx::query(&format!("DROP FUNCTION {failure}()")).execute(&pool).await.unwrap();
      let (a,b)=tokio::join!(skip_graphql(&app,&state,actor_session,skip.clone()),skip_graphql(&app,&state,actor_session,skip.clone()));
      assert!(a.is_ok() || b.is_ok());
      let skipped=skip_graphql(&app,&state,actor_session,skip).await.unwrap();
      assert_eq!(skipped.schedule.lifecycle,ScheduleLifecycle::Paused);
      let receipt=skipped.members.iter().find(|member|member.id==resumed_occurrence).unwrap();
      assert_eq!(receipt.advance_kind.as_deref(),Some("skip"));
      let successor=receipt.successor_occurrence_id.unwrap();
      let skip_run=task_run_id(successor,skipped.schedule.generation);
      run_ids.push(skip_run);
      myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(&pool,&scheduler,skip_event).await.unwrap();
      wait_for_effects(&pool,&[skip_run],1).await;
      let skipped_row=services.views.get_row(actor,database,next.row.id).await.unwrap().unwrap();
      assert_eq!(skipped_row.cells.iter().find(|cell|cell.field_id==status_field).unwrap().value,DatabaseCellValueData::Status(archived));
      let reminder_state:(String,i64)=sqlx::query_as("SELECT r.status,s.generation FROM database_row_reminders r JOIN scheduling_schedules s ON s.id=r.id WHERE r.id=$1")
        .bind(reminder.id).fetch_one(&pool).await.unwrap();
      assert_eq!(reminder_state.0,"cancelled");
      assert!(reminder_state.1>reminder.schedule_revision,"Skip invalidates any queued reminder generation");
      assert!(!skipped_row.cells.iter().any(|cell|cell.field_id==field("task.completedAt")),
        "Skip never marks the member Complete");
      let successor_row=services.views.get_row(actor,database,Uuid::new_v5(&successor,b"row")).await.unwrap().unwrap();
      let skip_due=myoxus_application::scheduling::relative_after(
        ScheduleValue::Date(receipt.advanced_at.unwrap().with_timezone(&relative_zone.timezone()).date_naive()),
        RelativeInterval{amount:std::num::NonZeroU32::new(1).unwrap(),unit:RelativeUnit::Days},relative_zone).unwrap();
      assert_eq!(successor_row.cells.iter().find(|cell|cell.field_id==due_field).unwrap().value,
        DatabaseCellValueData::DateTime(recurring_task::due_value(skip_due,relative_zone)));
      services.editing.update_cell_value(actor,database,next.row.id,status_field,DatabaseCellValueData::Status(complete.clone())).await.unwrap();
      let resumed=control_graphql(&app,&state,actor_session,control(relative_id,skipped.schedule.revision,TaskRecurrenceChange::Resume)).await.unwrap();
      assert_eq!(resumed.series.current_member_id,Some(successor));
      assert!(resumed.schedule.next.is_none(),"Resume cannot create a second Skip successor");
      let race=TaskRecurrenceSkip{workspace_id:workspace,series_id:relative_id,member_id:successor,actor_id:actor,
        expected_revision:resumed.schedule.revision,expected_row_revision:successor_row.row.edit_revision,
        expected_status_revision:successor_row.cells.iter().find(|cell|cell.field_id==status_field).unwrap().edit_revision};
      let (skipping,completing)=tokio::join!(skip_graphql(&app,&state,actor_session,race.clone()),
        services.editing.update_cell_value_with_precondition(actor,database,successor_row.row.id,status_field,
          DatabaseCellValueData::Status(complete),Some(race.expected_status_revision),false));
      assert!(skipping.is_ok() || completing.is_ok());
      let raced=source.native.read(actor,workspace,relative_id).await.unwrap().unwrap();
      let race_receipt=raced.members.iter().find(|member|member.id==successor).unwrap();
      let race_successor=race_receipt.successor_occurrence_id.unwrap();
      let race_run=task_run_id(race_successor,raced.schedule.generation);
      run_ids.push(race_run);
      myoxus_api::workspace_automation_worker::dispatch_recurring_task_completion(&pool,&scheduler,
        Uuid::new_v5(&successor,b"completion-wake")).await.unwrap();
      wait_for_effects(&pool,&[race_run],1).await;
      let duplicates:i64=sqlx::query_scalar("SELECT count(*) FROM task_recurrence_members m JOIN scheduling_occurrences o ON o.id=m.occurrence_id WHERE o.schedule_id=$1 AND o.cause_member_id=$2")
        .bind(relative_id).bind(successor).fetch_one(&pool).await.unwrap();
      assert_eq!(duplicates,1,"racing Skip/Complete shares one native successor");
      let ended=control_graphql(&app,&state,actor_session,control(relative_id,raced.schedule.revision,TaskRecurrenceChange::End)).await.unwrap();
      assert_eq!(ended.schedule.lifecycle,ScheduleLifecycle::Ended);
      assert!(skip_graphql(&app,&state,actor_session,TaskRecurrenceSkip{workspace_id:workspace,series_id:relative_id,member_id:successor,
        actor_id:actor,expected_revision:ended.schedule.revision,expected_row_revision:successor_row.row.edit_revision,
        expected_status_revision:successor_row.cells.iter().find(|cell|cell.field_id==status_field).unwrap().edit_revision}).await.is_err());

      // Freeze an unstarted fixed dispatch, then fence it with Pause. The same
      // slot can later be confirmed under a new generation, without losing its
      // old frozen Run or changing the already-created first Task.
      runtime.shutdown(StdDuration::from_secs(10)).await.unwrap();
      runtime=Arc::new(GlirulusWorkspaceAutomationRuntime::new(pool.clone(),state.workspace_automation_service().unwrap().native_executor())
        .with_optional_automations_enabled(false));
      let scheduler=PgSchedulingRepository::new(pool.clone(),runtime.clone()).with_task_source(source.clone());
      let start=Utc::now().trunc_subsecs(6)-Duration::seconds(1);
      let rule=RecurrenceRule{start:ScheduleValue::LocalDateTime(start.with_timezone(&zone.timezone()).naive_local()),..rule};
      let original=services.editing.create_row(actor,database,Some("Preserved next Task".into()),vec![]).await.unwrap();
      let fixed=configure(&app,&state,actor_session,ConfigureTaskRecurrence{workspace_id:workspace,actor_id:actor,
        database_id:database,row_id:original.row.id,expected_row_revision:original.row.edit_revision,expected_due_revision:0,
        rule:ScheduleRule::Fixed{rule:rule.clone()},zone,recipe:recipe.clone()}).await.unwrap();
      let id=fixed.series.id;
      let second=myoxus_application::scheduling::next_after(&rule,start,CalculationBudget::default()).unwrap().unwrap();
      let occurrence=occurrence_id(id,second.nominal);
      let old_run=task_run_id(occurrence,1);
      run_ids.push(old_run);
      scheduler.dispatch_due(Utc::now(),50).await.unwrap();
      helpers::add_workspace_member(&pool,workspace,observer).await;
      sqlx::query("UPDATE workspace_memberships SET role='Reader' WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace).bind(observer).execute(&pool).await.unwrap();
      assert!(source.native.read(observer,workspace,id).await.unwrap().is_some());
      assert!(source.native.read(observer,Uuid::new_v4(),id).await.is_err(),"scope checks precede recipe disclosure");
      assert!(control_graphql(&app,&state,observer_session,TaskRecurrenceControl{actor_id:observer,..control(id,1,TaskRecurrenceChange::Pause)}).await.is_err());
      sqlx::query("UPDATE workspace_memberships SET role='Collaborator' WHERE workspace_id=$1 AND user_id=$2")
        .bind(workspace).bind(observer).execute(&pool).await.unwrap();
      let paused=control_graphql(&app,&state,observer_session,TaskRecurrenceControl{actor_id:observer,..control(id,1,TaskRecurrenceChange::Pause)}).await.unwrap();
      runtime.start().await.unwrap();
      tokio::time::timeout(StdDuration::from_secs(30),async {
        loop {
          let status=runtime.status(old_run).await.unwrap();
          if matches!(status.status,WorkspaceAutomationRunStatus::Failed|WorkspaceAutomationRunStatus::DeadLetter|WorkspaceAutomationRunStatus::Succeeded) {
            assert!(matches!(status.status,WorkspaceAutomationRunStatus::Failed|WorkspaceAutomationRunStatus::DeadLetter),
              "Pause fences accepted but unstarted effects");break;
          }
          tokio::time::sleep(StdDuration::from_millis(50)).await;
        }
      }).await.unwrap();
      assert!(services.views.get_row(actor,database,Uuid::new_v5(&occurrence,b"row")).await.unwrap().is_none());
      let resumed=control_graphql(&app,&state,actor_session,control(id,paused.schedule.revision,TaskRecurrenceChange::Resume)).await.unwrap();
      let mut changed_recipe=recipe.clone();changed_recipe.title="Changed series recipe".into();
      let changed=control_graphql(&app,&state,actor_session,control(id,resumed.schedule.revision,TaskRecurrenceChange::Update{
        rule:ScheduleRule::Fixed{rule:rule.clone()},zone,recipe:changed_recipe.clone()})).await.unwrap();
      let preserved=services.views.get_row(actor,database,original.row.id).await.unwrap().unwrap();
      let before_due=fixed.member.cells.iter().find(|cell|cell.field_id==due_field).unwrap();
      let after_due=preserved.cells.iter().find(|cell|cell.field_id==due_field).unwrap();
      assert_eq!((&after_due.value,after_due.edit_revision),(&before_due.value,before_due.edit_revision));
      let new_run=task_run_id(occurrence,changed.schedule.generation);
      run_ids.push(new_run);
      scheduler.dispatch_due(Utc::now(),50).await.unwrap();
      wait_for_effects(&pool,&[new_run],1).await;
      let created=services.views.get_row(actor,database,Uuid::new_v5(&occurrence,b"row")).await.unwrap().unwrap();
      assert_eq!(created.row.title,changed_recipe.title);
      let change_preview=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "query Preview($workspace:String!,$input:RecurrencePreviewInput!){workspace(id:$workspace){recurrencePreview(input:$input){occurrence{dueAt}}}}",
        "variables":{"workspace":workspace,"input":{"seriesId":id,"expectedRevision":changed.schedule.revision,
          "rule":rule_input(&ScheduleRule::Fixed{rule:RecurrenceRule{interval:std::num::NonZeroU32::new(2).unwrap(),..rule.clone()}},zone),"count":5}}})).await;
      assert!(change_preview.get("errors").is_none(),"{change_preview:?}");
      let first_affected=chrono::DateTime::parse_from_rfc3339(change_preview["data"]["workspace"]["recurrencePreview"][0]["occurrence"]["dueAt"].as_str().unwrap()).unwrap().with_timezone(&Utc);
      let changed=control_graphql(&app,&state,actor_session,control(id,changed.schedule.revision,TaskRecurrenceChange::Update{
        rule:ScheduleRule::Fixed{rule:RecurrenceRule{interval:std::num::NonZeroU32::new(2).unwrap(),..rule.clone()}},zone,
        recipe:changed_recipe})).await.unwrap();
      assert_eq!(changed.effective_after.as_ref().unwrap().row_id,created.row.id);
      assert!(changed.schedule.next.unwrap().nominal.local_datetime()>second.nominal.local_datetime());
      assert_eq!(changed.schedule.next.unwrap().due_at,first_affected,"the displayed change preview uses the native preserved-member boundary");
      assert_eq!(services.views.get_row(actor,database,created.row.id).await.unwrap().unwrap().cells.iter()
        .find(|cell|cell.field_id==due_field).unwrap().value,DatabaseCellValueData::DateTime(recurring_task::due_value(second,zone)));
      let original=services.views.get_row(actor,database,original.row.id).await.unwrap().unwrap();
      let before_skip=source.native.read(actor,workspace,id).await.unwrap().unwrap().schedule.next;
      let skipped=skip_graphql(&app,&state,actor_session,TaskRecurrenceSkip{workspace_id:workspace,series_id:id,
        member_id:occurrence_id(id,rule.start),actor_id:actor,expected_revision:changed.schedule.revision,
        expected_row_revision:original.row.edit_revision,
        expected_status_revision:original.cell_revisions.iter().find(|cell|cell.field_id==status_field).map_or(0,|cell|cell.edit_revision)}).await.unwrap();
      assert_eq!(skipped.schedule.next,before_skip,
        "fixed Skip does not shift the fixed rule");
      services.editing.delete_row(actor,database,created.row.id).await.unwrap();
      sqlx::query("UPDATE users SET status='disabled' WHERE id=$1").bind(actor).execute(&pool).await.unwrap();
      let blocked=source.native.read(observer,workspace,id).await.unwrap().unwrap();
      assert_eq!(blocked.schedule.blocked_reason.as_deref(),Some("taskPermissionUnavailable"),
        "a disabled confirming actor cannot be presented as ready");
      sqlx::query("UPDATE users SET status='active' WHERE id=$1").bind(actor).execute(&pool).await.unwrap();
      assert!(source.native.read(observer,workspace,id).await.unwrap().unwrap().schedule.blocked_reason.is_none());
      // Purged-history receipts intentionally retain no native Row/Run. They
      // exercise readback beyond its recent-history budget, not Task creation.
      let history=(1..=101).map(|offset|{
        let due=start-Duration::days(i64::from(offset));
        let nominal=ScheduleValue::LocalDateTime(due.with_timezone(&zone.timezone()).naive_local());
        let occurrence=occurrence_id(id,nominal);
        serde_json::json!({"id":occurrence,"nominal":nominal,"due":due,"dispatch":task_run_id(occurrence,1),
          "row_id":Uuid::new_v5(&occurrence,b"row")})
      }).collect::<Vec<_>>();
      sqlx::query("WITH source AS (SELECT * FROM jsonb_to_recordset($1) AS x(id uuid,nominal jsonb,due timestamptz,dispatch uuid,row_id uuid)), slots AS (INSERT INTO scheduling_occurrences(id,schedule_id,nominal_json,nominal_due_at,generation,dispatch_id) SELECT id,$2,nominal,due,1,dispatch FROM source RETURNING id) INSERT INTO task_recurrence_members(id,occurrence_id,series_id,row_id,database_id) SELECT slots.id,slots.id,$2,source.row_id,$3 FROM slots JOIN source USING(id)")
        .bind(serde_json::to_value(history).unwrap()).bind(id).bind(database).execute(&pool).await.unwrap();
      let replay=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "mutation Skip($input:SkipTaskRecurrenceInput!){skipTaskRecurrence(input:$input){members{id advanceKind}}}","variables":{"input":{
          "workspaceId":workspace,"seriesId":id,"memberId":occurrence_id(id,rule.start),"expectedRevision":skipped.schedule.revision,
          "expectedRowRevision":original.row.edit_revision,"expectedStatusRevision":0}}})).await;
      assert!(replay.get("errors").is_none(),"{replay:?}");
      assert!(replay["data"]["skipTaskRecurrence"]["members"].as_array().unwrap().iter().any(|member|
        member["id"]==occurrence_id(id,rule.start).to_string()&&member["advanceKind"]=="skip"),
        "explicit Skip readback retains the old winning receipt beyond recent history");
      let ended=control_graphql(&app,&state,actor_session,control(id,skipped.schedule.revision,TaskRecurrenceChange::End)).await.unwrap();
      assert_eq!(ended.schedule.lifecycle,ScheduleLifecycle::Ended,"deletion does not prevent series management");
      let retained=helpers::gql(&app,actor_session,serde_json::json!({"query":
        "query Read($workspace:String!,$older:TaskRecurrenceLookupInput!,$deleted:TaskRecurrenceLookupInput!){workspace(id:$workspace){older:taskRecurrence(input:$older){id lifecycle members{rowId advanceKind}} deleted:taskRecurrence(input:$deleted){id lifecycle members{rowId}}}}",
        "variables":{"workspace":workspace,"older":{"rowId":original.row.id},"deleted":{"rowId":created.row.id}}})).await;
      assert!(retained.get("errors").is_none(),"{retained:?}");
      let older=&retained["data"]["workspace"]["older"];
      assert_eq!(older["id"],id.to_string());
      assert_eq!(older["lifecycle"],"Ended");
      assert!(older["members"].as_array().unwrap().iter().any(|member|
        member["rowId"]==original.row.id.to_string() && member["advanceKind"]=="skip"),
        "the requested old archived Task remains manageable beyond recent history");
      assert!(retained["data"]["workspace"]["deleted"]["members"].as_array().unwrap().iter()
        .any(|member|member["rowId"]==created.row.id.to_string()),"a retained deleted member also stays addressable");
    }).catch_unwind().await;
    runtime.shutdown(StdDuration::from_secs(10)).await.unwrap();
    sqlx::query(&format!("DROP TRIGGER IF EXISTS {failure} ON outbox_events"))
      .execute(&pool)
      .await
      .unwrap();
    sqlx::query(&format!(
      "DROP TRIGGER IF EXISTS {failure} ON sayiir_workflow_snapshots"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(&format!("DROP FUNCTION IF EXISTS {failure}()"))
      .execute(&pool)
      .await
      .unwrap();
    helpers::cleanup_users(&pool, &[actor, observer]).await;
    let remaining:(i64,i64,i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM users WHERE id=$1 OR id=$4),(SELECT count(*) FROM workspaces WHERE id=$2),(SELECT count(*) FROM sayiir_workflow_snapshots WHERE instance_id=ANY($3)),(SELECT count(*) FROM outbox_events WHERE event_type='task_recurrence_due' AND payload->>'workspaceId'=$2::text)")
      .bind(actor).bind(workspace).bind(run_ids.iter().map(Uuid::to_string).collect::<Vec<_>>()).bind(observer).fetch_one(&pool).await.unwrap();
    assert_eq!(
      remaining,
      (0, 0, 0, 0),
      "fixture cleanup must not silently leave durable data"
    );
    if let Err(panic) = outcome {
      std::panic::resume_unwind(panic);
    }
  });
}
