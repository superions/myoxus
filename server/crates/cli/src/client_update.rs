// SPDX-License-Identifier: AGPL-3.0-or-later

use anyhow::Context;
use async_trait::async_trait;
use clap::{Args, Subcommand, ValueEnum};
use myoxus_application::client_update::{ClientUpdateCommand as ApplicationCommand, ClientUpdateTransition};
use myoxus_contracts::client_update::{ClientUpdateCompletionAction, ClientUpdateControlV1, ClientUpdatePhase};
use myoxus_infrastructure::client_update::PgClientUpdateRepository;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::output::print_json;

#[derive(Subcommand)]
pub enum ClientUpdateCommand {
  /// Show the current server-owned Browser Web update state.
  Status,
  /// Start an operation with a bounded automatic retry budget.
  LimitRetry(LimitRetryArgs),
  /// Suspend all automatic Browser Web data retries.
  NoRetry(OperationArgs),
  /// Complete an operation and optionally request a browser action.
  UpdateSuccess(UpdateSuccessArgs),
  /// Keep an operation in a visible retry-free failure state.
  UpdateFailed(OperationArgs),
  /// Return to normal operation without an update action.
  UpdateAbort(OperationArgs),
}

#[derive(Args)]
pub struct OperationArgs {
  /// Operator-owned UUID-v4 identifying this update operation.
  #[arg(long)]
  operation_id: Uuid,
}

#[derive(Args)]
pub struct LimitRetryArgs {
  /// Operator-owned UUID-v4 identifying this update operation.
  #[arg(long)]
  operation_id: Uuid,
  /// Maximum automatic data retry attempts for this browser runtime.
  #[arg(long, value_parser = clap::value_parser!(u8).range(0..=100))]
  max_attempts: u8,
  /// Delay between retry attempts in milliseconds.
  #[arg(long, value_parser = clap::value_parser!(u32).range(1_000..=300_000))]
  retry_after_ms: u32,
}

#[derive(Args)]
pub struct UpdateSuccessArgs {
  /// Operator-owned UUID-v4 identifying this update operation.
  #[arg(long)]
  operation_id: Uuid,
  /// Browser action requested after successful completion.
  #[arg(long, value_enum)]
  action: CompletionActionArg,
  /// Existing service-worker build ID required by Browser Web.
  #[arg(long)]
  required_web_build_id: Option<String>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
#[clap(rename_all = "kebab-case")]
enum CompletionActionArg {
  None,
  Reload,
  ResetLocalCache,
}

impl From<CompletionActionArg> for ClientUpdateCompletionAction {
  fn from(value: CompletionActionArg) -> Self {
    match value {
      CompletionActionArg::None => Self::None,
      CompletionActionArg::Reload => Self::Reload,
      CompletionActionArg::ResetLocalCache => Self::ResetLocalCache,
    }
  }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MutationOutput {
  committed: bool,
  changed: bool,
  wakeup_sent: bool,
  wakeup_error: Option<&'static str>,
  state: ClientUpdateControlV1,
}

#[async_trait]
trait ClientUpdateBackend {
  async fn apply(&self, command: ApplicationCommand) -> anyhow::Result<ClientUpdateTransition>;
  async fn notify(&self, state_id: Uuid) -> anyhow::Result<()>;
}

#[async_trait]
impl ClientUpdateBackend for PgClientUpdateRepository {
  async fn apply(&self, command: ApplicationCommand) -> anyhow::Result<ClientUpdateTransition> {
    self.apply(command).await.map_err(Into::into)
  }

  async fn notify(&self, state_id: Uuid) -> anyhow::Result<()> {
    self.notify(state_id).await.map_err(Into::into)
  }
}

pub async fn run(command: ClientUpdateCommand, pool: &PgPool, json: bool) -> anyhow::Result<()> {
  let backend = PgClientUpdateRepository::new(pool.clone());
  match command {
    ClientUpdateCommand::Status => render_status(backend.read().await?, json),
    ClientUpdateCommand::LimitRetry(args) => {
      mutate(
        &backend,
        ApplicationCommand::LimitRetry {
          operation_id: args.operation_id,
          max_attempts: args.max_attempts,
          retry_after_ms: args.retry_after_ms,
        },
        json,
      )
      .await
    }
    ClientUpdateCommand::NoRetry(args) => {
      mutate(
        &backend,
        ApplicationCommand::NoRetry {
          operation_id: args.operation_id,
        },
        json,
      )
      .await
    }
    ClientUpdateCommand::UpdateSuccess(args) => {
      mutate(
        &backend,
        ApplicationCommand::UpdateSuccess {
          operation_id: args.operation_id,
          action: args.action.into(),
          required_web_build_id: args.required_web_build_id,
        },
        json,
      )
      .await
    }
    ClientUpdateCommand::UpdateFailed(args) => {
      mutate(
        &backend,
        ApplicationCommand::UpdateFailed {
          operation_id: args.operation_id,
        },
        json,
      )
      .await
    }
    ClientUpdateCommand::UpdateAbort(args) => {
      mutate(
        &backend,
        ApplicationCommand::UpdateAbort {
          operation_id: args.operation_id,
        },
        json,
      )
      .await
    }
  }
}

async fn mutate(backend: &impl ClientUpdateBackend, command: ApplicationCommand, json: bool) -> anyhow::Result<()> {
  let (output, wakeup_error) = execute_mutation(backend, command).await?;
  render_mutation(&output, json);

  if let Some(error) = wakeup_error {
    return Err(error).context("client update state committed, but API wake-up notification failed");
  }
  Ok(())
}

async fn execute_mutation(
  backend: &impl ClientUpdateBackend,
  command: ApplicationCommand,
) -> anyhow::Result<(MutationOutput, Option<anyhow::Error>)> {
  let transition = backend.apply(command).await?;
  let wakeup_error = if transition.changed {
    backend.notify(transition.state.state_id).await.err()
  } else {
    None
  };
  let output = MutationOutput {
    committed: true,
    changed: transition.changed,
    wakeup_sent: transition.changed && wakeup_error.is_none(),
    wakeup_error: wakeup_error
      .as_ref()
      .map(|_| "database commit succeeded but API wake-up notification failed"),
    state: transition.state,
  };
  Ok((output, wakeup_error))
}

fn render_status(state: ClientUpdateControlV1, json: bool) -> anyhow::Result<()> {
  if json {
    print_json(&state);
  } else {
    println!("Phase: {}", phase_label(state.phase));
    println!("State ID: {}", state.state_id);
    println!(
      "Operation ID: {}",
      state
        .operation_id
        .map(|value| value.to_string())
        .unwrap_or_else(|| "-".to_string())
    );
    println!("Cache epoch: {}", state.cache_epoch);
    println!("Updated at: {}", state.updated_at);
  }
  Ok(())
}

fn render_mutation(output: &MutationOutput, json: bool) {
  if json {
    print_json(output);
  } else {
    println!(
      "Client update state {} (phase={}, stateId={}, wakeupSent={})",
      if output.changed { "updated" } else { "unchanged" },
      phase_label(output.state.phase),
      output.state.state_id,
      output.wakeup_sent
    );
  }
}

fn phase_label(phase: ClientUpdatePhase) -> &'static str {
  match phase {
    ClientUpdatePhase::Normal => "normal",
    ClientUpdatePhase::Limited => "limited",
    ClientUpdatePhase::Suspended => "suspended",
    ClientUpdatePhase::Failed => "failed",
  }
}

#[cfg(test)]
mod tests {
  use std::sync::Mutex;

  use myoxus_application::client_update::baseline_client_update_control;

  use super::*;

  struct NotifyFailureBackend {
    state: Mutex<ClientUpdateControlV1>,
  }

  #[async_trait]
  impl ClientUpdateBackend for NotifyFailureBackend {
    async fn apply(&self, command: ApplicationCommand) -> anyhow::Result<ClientUpdateTransition> {
      let current = self.state.lock().expect("state lock").clone();
      let transition = myoxus_application::client_update::transition_client_update_control(
        &current,
        command,
        Uuid::new_v4(),
        chrono::Utc::now(),
      )?;
      *self.state.lock().expect("state lock") = transition.state.clone();
      Ok(transition)
    }

    async fn notify(&self, _state_id: Uuid) -> anyhow::Result<()> {
      anyhow::bail!("simulated wake-up outage")
    }
  }

  #[tokio::test]
  async fn committed_state_survives_a_wakeup_failure() {
    let backend = NotifyFailureBackend {
      state: Mutex::new(baseline_client_update_control()),
    };
    let operation_id = Uuid::new_v4();

    let (output, wakeup_error) = execute_mutation(
      &backend,
      ApplicationCommand::LimitRetry {
        operation_id,
        max_attempts: 2,
        retry_after_ms: 1_000,
      },
    )
    .await
    .expect("committed mutation result");
    let persisted = backend.state.lock().expect("state lock").clone();

    assert!(output.committed);
    assert!(output.changed);
    assert!(!output.wakeup_sent);
    assert_eq!(
      output.wakeup_error,
      Some("database commit succeeded but API wake-up notification failed")
    );
    assert!(wakeup_error.is_some());
    assert_eq!(persisted.phase, ClientUpdatePhase::Limited);
    assert_eq!(persisted.operation_id, Some(operation_id));
  }
}
