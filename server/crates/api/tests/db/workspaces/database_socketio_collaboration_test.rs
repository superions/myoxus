//! P-DB-29B live Socket.IO collaboration contract.
//!
//! This test uses two authenticated Engine.IO polling clients against a real
//! TCP listener. It exercises the production Database handlers, SQL-backed
//! permissions, Redis presence adapter and committed GraphQL change publisher
//! without introducing a second Socket.IO client dependency.

use std::time::Duration;

use futures_util::FutureExt;
use reqwest::header::{CONTENT_TYPE, COOKIE};
use serde_json::{Value, json};
use tokio::time::{Instant, sleep, timeout};
use uuid::Uuid;

use crate::helpers;

struct PollingSocketClient {
  base_url: String,
  client: reqwest::Client,
  cookie: String,
  engine_sid: String,
  next_ack_id: u64,
}

impl PollingSocketClient {
  async fn connect(base_url: &str, session_id: Uuid) -> Self {
    let client = reqwest::Client::new();
    let cookie = format!("affine_session={session_id}");
    let open = client
      .get(format!("{base_url}/socket.io/?EIO=4&transport=polling"))
      .header(COOKIE, &cookie)
      .send()
      .await
      .expect("Engine.IO handshake")
      .error_for_status()
      .expect("Engine.IO handshake status")
      .text()
      .await
      .expect("Engine.IO handshake body");
    let json_start = open.find('{').expect("Engine.IO open JSON start");
    let json_end = open.rfind('}').expect("Engine.IO open JSON end") + 1;
    let open_payload: Value = serde_json::from_str(&open[json_start..json_end]).expect("Engine.IO open JSON");
    let engine_sid = open_payload["sid"].as_str().expect("Engine.IO sid").to_string();
    let socket = Self {
      base_url: base_url.to_string(),
      client,
      cookie,
      engine_sid,
      next_ack_id: 1,
    };
    socket.post_packet("40").await;
    socket
      .wait_for_packet(Duration::from_secs(2), |packet| packet.contains("40{"))
      .await
      .expect("Socket.IO namespace connect acknowledgement");
    socket
  }

  fn polling_url(&self) -> String {
    format!(
      "{}/socket.io/?EIO=4&transport=polling&sid={}",
      self.base_url, self.engine_sid
    )
  }

  async fn post_packet(&self, packet: &str) {
    self
      .client
      .post(self.polling_url())
      .header(COOKIE, &self.cookie)
      .header(CONTENT_TYPE, "text/plain;charset=UTF-8")
      .body(packet.to_string())
      .send()
      .await
      .expect("Socket.IO polling POST")
      .error_for_status()
      .expect("Socket.IO polling POST status");
  }

  async fn poll_once(&self, wait: Duration) -> Option<String> {
    let response = timeout(
      wait,
      self.client.get(self.polling_url()).header(COOKIE, &self.cookie).send(),
    )
    .await
    .ok()?
    .expect("Socket.IO polling GET")
    .error_for_status()
    .expect("Socket.IO polling GET status");
    Some(response.text().await.expect("Socket.IO polling body"))
  }

  async fn wait_for_packet(&self, wait: Duration, predicate: impl Fn(&str) -> bool) -> Option<String> {
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
      let remaining = deadline.saturating_duration_since(Instant::now());
      let response = self.poll_once(remaining).await?;
      for packet in response.split('\u{1e}') {
        if predicate(packet) {
          return Some(packet.to_string());
        }
        if packet == "2" {
          self.post_packet("3").await;
        }
      }
    }
    None
  }

  async fn emit_with_ack(&mut self, event: &str, payload: Value) -> String {
    let ack_id = self.next_ack_id;
    self.next_ack_id += 1;
    let packet = format!("42{ack_id}{}", json!([event, payload]));
    self.post_packet(&packet).await;
    self
      .wait_for_packet(Duration::from_secs(2), |response| {
        response.starts_with(&format!("43{ack_id}"))
      })
      .await
      .unwrap_or_else(|| panic!("Socket.IO acknowledgement {ack_id} for {event}"))
  }

  async fn emit(&self, event: &str, payload: Value) {
    self.post_packet(&format!("42{}", json!([event, payload]))).await;
  }

  async fn disconnect(&self) {
    self.post_packet("41").await;
  }
}

async fn insert_database(pool: &sqlx::PgPool, workspace_id: Uuid, owner_id: Uuid, title: &str) -> Uuid {
  let database_id = Uuid::new_v4();
  sqlx::query(
    r#"INSERT INTO workspace_databases
         (id, workspace_id, title, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4)"#,
  )
  .bind(database_id)
  .bind(workspace_id)
  .bind(title)
  .bind(owner_id)
  .execute(pool)
  .await
  .expect("insert Socket.IO test database");
  database_id
}

fn join_payload(workspace_id: Uuid, database_id: Uuid) -> Value {
  json!({
    "workspaceId": workspace_id,
    "databaseId": database_id,
    "viewId": Value::Null,
  })
}

#[test]
fn pdb29b_two_authenticated_sockets_receive_presence_and_committed_changes() {
  helpers::block_on_large_stack("pdb29b-socketio-collaboration", || async {
    let (router, pool, auth_store, redis_presence) = helpers::setup_app_with_database_socket_runtime().await;
    let (owner_id, owner_session) =
      helpers::seed_user_with_name(&pool, &auth_store, "pdb29b-socket-owner", "Alice").await;
    let (member_id, member_session) =
      helpers::seed_user_with_name(&pool, &auth_store, "pdb29b-socket-member", "Bob").await;
    let (outsider_id, outsider_session) =
      helpers::seed_user_with_name(&pool, &auth_store, "pdb29b-socket-outsider", "Mallory").await;
    let workspace_id = helpers::create_workspace(&pool, owner_id).await;
    let other_workspace = helpers::create_workspace(&pool, outsider_id).await;
    let mut server_task = None;
    let result = std::panic::AssertUnwindSafe(async {
    helpers::add_workspace_member(&pool, workspace_id, member_id).await;
    let created_database = helpers::gql(
      &router,
      owner_session,
      json!({
        "query": r#"mutation($input: CreateDatabaseInput!) {
          createDatabase(input: $input) {
            database { id }
            fields { id fieldType }
          }
        }"#,
        "variables": { "input": {
          "workspaceId": workspace_id,
          "title": "Collaboration",
          "initialViewKind": "Table"
        }}
      }),
    )
    .await;
    assert!(
      created_database.get("errors").is_none(),
      "create collaboration Database: {created_database}"
    );
    let database_id = created_database["data"]["createDatabase"]["database"]["id"]
      .as_str()
      .expect("created Database id")
      .parse::<Uuid>()
      .expect("created Database UUID");
    let title_field_id = created_database["data"]["createDatabase"]["fields"]
      .as_array()
      .expect("created fields")
      .iter()
      .find(|field| field["fieldType"] == "Title")
      .and_then(|field| field["id"].as_str())
      .expect("title field id")
      .parse::<Uuid>()
      .expect("title field UUID");
    let created_row = helpers::gql(
      &router,
      owner_session,
      json!({
        "query": r#"mutation($input: CreateDatabaseRowInput!) {
          createDatabaseRow(input: $input) { row { id editRevision } }
        }"#,
        "variables": { "input": {
          "databaseId": database_id,
          "title": "Collaborative row"
        }}
      }),
    )
    .await;
    assert!(
      created_row.get("errors").is_none(),
      "create collaboration row: {created_row}"
    );
    let database_row_id = created_row["data"]["createDatabaseRow"]["row"]["id"]
      .as_str()
      .expect("created row id")
      .parse::<Uuid>()
      .expect("created row UUID");
    let isolated_database_id = insert_database(&pool, workspace_id, owner_id, "Isolated").await;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
      .await
      .expect("bind Socket.IO integration listener");
    let address = listener.local_addr().expect("Socket.IO integration address");
    let served_router = router.clone();
    server_task = Some(tokio::spawn(async move {
      axum::serve(listener, served_router)
        .await
        .expect("serve Socket.IO integration router");
    }));
    let base_url = format!("http://{address}");

    let workspace_join =
      |id: Uuid| json!({"spaceType":"workspace","spaceId":id,"clientVersion":env!("CARGO_PKG_VERSION")});
    let mut tasks = PollingSocketClient::connect(&base_url, member_session).await;
    let ack = tasks.emit_with_ack("space:join", workspace_join(workspace_id)).await;
    assert!(ack.contains("\"success\":true"), "Task-only workspace join: {ack}");
    let mut other_tasks = PollingSocketClient::connect(&base_url, outsider_session).await;
    let denied = other_tasks
      .emit_with_ack("space:join", workspace_join(workspace_id))
      .await;
    assert!(denied.contains("\"success\":false"), "outsider workspace join denied: {denied}");
    let ack = other_tasks
      .emit_with_ack("space:join", workspace_join(other_workspace))
      .await;
    assert!(ack.contains("\"success\":true"), "unrelated authorized workspace join: {ack}");
    let mut alice = PollingSocketClient::connect(&base_url, owner_session).await;
    let mut bob = PollingSocketClient::connect(&base_url, member_session).await;
    let alice_join = alice
      .emit_with_ack("database:join", join_payload(workspace_id, database_id))
      .await;
    assert!(
      alice_join.contains(&owner_id.to_string()),
      "owner join acknowledgement: {alice_join}"
    );

    let bob_join = bob
      .emit_with_ack("database:join", join_payload(workspace_id, database_id))
      .await;
    assert!(
      bob_join.contains(&owner_id.to_string()),
      "member snapshot must include owner: {bob_join}"
    );
    assert!(
      bob_join.contains(&member_id.to_string()),
      "member snapshot must include member: {bob_join}"
    );
    let member_joined = alice
      .wait_for_packet(Duration::from_secs(2), |packet| {
        packet.contains("database:presence-update") && packet.contains(&member_id.to_string())
      })
      .await
      .expect("owner receives member join presence");
    assert!(member_joined.contains("Bob"));

    let redis_snapshot = redis_presence.list_database_presence(workspace_id, database_id).await;
    assert_eq!(
      redis_snapshot.len(),
      2,
      "both authenticated sockets must be persisted in Redis"
    );

    let row_id = Uuid::new_v4();
    let field_id = Uuid::new_v4();
    alice
      .emit(
        "database:update-presence",
        json!({
          "workspaceId": workspace_id,
          "databaseId": database_id,
          "viewId": Value::Null,
          "rowId": row_id,
          "fieldId": field_id,
          "dragging": false,
        }),
      )
      .await;
    let focus_update = bob
      .wait_for_packet(Duration::from_secs(2), |packet| {
        packet.contains("database:presence-update") && packet.contains(&row_id.to_string())
      })
      .await
      .expect("member receives owner focus update");
    assert!(focus_update.contains(&field_id.to_string()));

    let mut outsider = PollingSocketClient::connect(&base_url, outsider_session).await;
    let denied = outsider
      .emit_with_ack("database:join", join_payload(workspace_id, database_id))
      .await;
    assert!(
      denied.contains("DATABASE_FORBIDDEN"),
      "outsider join must be denied: {denied}"
    );
    let wrong_workspace = alice
      .emit_with_ack("database:join", join_payload(Uuid::new_v4(), database_id))
      .await;
    assert!(
      wrong_workspace.contains("DATABASE_FORBIDDEN"),
      "a Database cannot be joined through a different workspace: {wrong_workspace}"
    );

    let mut isolated = PollingSocketClient::connect(&base_url, owner_session).await;
    isolated
      .emit_with_ack("database:join", join_payload(workspace_id, isolated_database_id))
      .await;
    alice
      .emit(
        "database:update-presence",
        json!({
          "workspaceId": workspace_id,
          "databaseId": database_id,
          "viewId": Value::Null,
          "rowId": Uuid::new_v4(),
          "fieldId": Value::Null,
          "dragging": false,
        }),
      )
      .await;
    assert!(
      isolated
        .wait_for_packet(Duration::from_millis(300), |packet| {
          packet.contains("database:presence-update")
        })
        .await
        .is_none(),
      "presence must not cross Database rooms"
    );

    let update = helpers::gql(
    &router,
    owner_session,
    json!({
      "query": "mutation($input: UpdateDatabaseInput!) { updateDatabase(input: $input) { database { id title editRevision } } }",
      "variables": {
        "input": {
          "databaseId": database_id,
          "title": "Committed collaboration update",
          "expectedEditRevision": 1,
          "force": false,
        }
      }
    }),
  )
  .await;
    assert!(update.get("errors").is_none(), "committed update failed: {update}");
    let task_hint = tasks
      .wait_for_packet(Duration::from_secs(2), |packet| {
        packet.contains("database:tasks-changed")
      })
      .await
      .expect("Task-only room receives local committed hint despite Redis own-origin suppression");
    let hint_json: Value =
      serde_json::from_str(task_hint.strip_prefix("42").expect("Socket.IO event")).expect("Task hint event JSON");
    let hint = &hint_json[1];
    assert_eq!(hint["workspaceId"], workspace_id.to_string());
    assert_eq!(hint["databaseId"], database_id.to_string());
    assert_eq!(
      hint.as_object().expect("hint object").len(),
      3,
      "no titles or Cell data"
    );
    assert!(
      other_tasks
        .wait_for_packet(Duration::from_millis(300), |packet| packet
          .contains("database:tasks-changed"))
        .await
        .is_none(),
      "workspace hint isolation"
    );
    let change = bob
      .wait_for_packet(Duration::from_secs(2), |packet| {
        packet.contains("database:change") && packet.contains(&database_id.to_string())
      })
      .await
      .expect("member receives committed Database change");
    assert!(
      change.contains("database_updated"),
      "unexpected change payload: {change}"
    );

    while bob
      .wait_for_packet(Duration::from_millis(100), |packet| packet.contains("database:change"))
      .await
      .is_some()
    {}
    let stale = helpers::gql(
      &router,
      owner_session,
      json!({
        "query": "mutation($input: UpdateDatabaseInput!) { updateDatabase(input: $input) { database { id } } }",
        "variables": {
          "input": {
            "databaseId": database_id,
            "title": "Rejected stale update",
            "expectedEditRevision": 1,
            "force": false,
          }
        }
      }),
    )
    .await;
    assert_eq!(stale["errors"][0]["extensions"]["code"], "MIX_DATABASE_CONFLICT");
    assert!(
      bob
        .wait_for_packet(Duration::from_millis(300), |packet| packet.contains("database:change"))
        .await
        .is_none(),
      "failed writes must not emit a Database change"
    );

    assert!(
      tasks
        .wait_for_packet(Duration::from_millis(300), |packet| packet
          .contains("database:tasks-changed"))
        .await
        .is_none(),
      "rejected stale write emits no workspace hint"
    );

    let forced_title = helpers::gql(
      &router,
      owner_session,
      json!({
        "query": r#"mutation($input: UpdateDatabaseRowTitleInput!) {
          updateDatabaseRowTitle(input: $input) { rowId editRevision }
        }"#,
        "variables": { "input": {
          "databaseId": database_id,
          "rowId": database_row_id,
          "titleFieldId": title_field_id,
          "title": "Forced collaborative title",
          "expectedEditRevision": 0,
          "force": true
        }}
      }),
    )
    .await;
    assert!(
      forced_title.get("errors").is_none(),
      "forced title update failed: {forced_title}"
    );
    let title_change = bob
      .wait_for_packet(Duration::from_secs(2), |packet| {
        packet.contains("database:change") && packet.contains(&database_row_id.to_string())
      })
      .await
      .expect("member receives forced row-title change");
    assert!(
      title_change.contains("row_updated"),
      "unexpected title change payload: {title_change}"
    );
    assert!(
      title_change.contains(&title_field_id.to_string()),
      "title change must identify the edited field: {title_change}"
    );

    alice
      .emit("database:leave", join_payload(workspace_id, database_id))
      .await;
    let left = bob
      .wait_for_packet(Duration::from_secs(2), |packet| {
        packet.contains("database:presence-update") && packet.contains("\"left\":true")
      })
      .await
      .expect("member receives explicit leave");
    assert!(left.contains(&alice.engine_sid) || left.contains("left"));

    bob.disconnect().await;
    let cleanup_deadline = Instant::now() + Duration::from_secs(2);
    loop {
      let remaining = redis_presence.list_database_presence(workspace_id, database_id).await;
      if remaining.is_empty() {
        break;
      }
      assert!(
        Instant::now() < cleanup_deadline,
        "disconnect presence remained in Redis: {remaining:?}"
      );
      sleep(Duration::from_millis(25)).await;
    }

    let mut reconnected = PollingSocketClient::connect(&base_url, member_session).await;
    let rejoin = reconnected
      .emit_with_ack("database:join", join_payload(workspace_id, database_id))
      .await;
    assert!(
      rejoin.contains(&member_id.to_string()),
      "reconnected member must rejoin: {rejoin}"
    );

    tasks.disconnect().await;
    other_tasks.disconnect().await;
    reconnected.disconnect().await;
    isolated.disconnect().await;
    outsider.disconnect().await;
    }).catch_unwind().await;
    let server_result = if let Some(server) = server_task {
      server.abort();
      Some(server.await)
    } else {
      None
    };
    helpers::cleanup_workspaces(&pool, &[workspace_id, other_workspace]).await;
    helpers::cleanup_users(&pool, &[owner_id, member_id, outsider_id]).await;
    if let Some(Err(error)) = server_result {
      assert!(error.is_cancelled(), "Socket.IO fixture server failed: {error}");
    }
    if let Err(panic) = result {
      std::panic::resume_unwind(panic);
    }
  });
}
