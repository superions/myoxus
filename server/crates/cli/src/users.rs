//! `users` subcommand — user management via the application service layer.

use std::fs::File;
use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

use anyhow::Context;
use clap::{Args, Subcommand};
use serde::Serialize;
use tabled::Tabled;
use uuid::Uuid;

use crate::output::{print_json, print_output, print_single};
use crate::services::Services;

const MAX_PASSWORD_INPUT_BYTES: u64 = 16 * 1024;

/// Subcommands for `users`.
#[derive(Subcommand)]
pub enum UsersCommand {
  /// List all users with an optional email/name substring filter.
  List(UserListArgs),
  /// Show detailed information for a single user (by UUID or email).
  Get(UserGetArgs),
  /// Create a new user account.
  Create(UserCreateArgs),
  /// Reset a user's password.
  SetPassword(UserSetPasswordArgs),
  /// Create a one-time password-reset link.
  ResetLink(UserResetLinkArgs),
  /// Grant or revoke admin privileges for a user.
  SetAdmin(UserSetAdminArgs),
  /// Administratively disable a user account (prevents login).
  Disable(UserDisableEnableArgs),
  /// Re-enable a previously disabled user account.
  Enable(UserDisableEnableArgs),
  /// Delete a user (requires --confirm).
  Delete(UserDeleteArgs),
}

/// Arguments for `users list`.
#[derive(Args)]
pub struct UserListArgs {
  /// Substring filter applied to email and name (case-insensitive).
  #[arg(long)]
  pub filter: Option<String>,
}

/// Arguments for `users get`.
#[derive(Args)]
pub struct UserGetArgs {
  /// UUID or email address of the user.
  pub id_or_email: String,
}

/// Arguments for `users create`.
#[derive(Args)]
pub struct UserCreateArgs {
  /// Email address for the new user.
  #[arg(long)]
  pub email: String,
  /// Display name for the new user.
  #[arg(long)]
  pub name: String,
}

/// Arguments for `users set-password`.
#[derive(Args)]
pub struct UserSetPasswordArgs {
  /// UUID or email address of the user.
  pub id_or_email: String,
  /// Read the new password from standard input.
  #[arg(long, conflicts_with = "password_file")]
  pub password_stdin: bool,
  /// Read the new password from an owner-only regular file.
  #[arg(long, value_name = "PATH", conflicts_with = "password_stdin")]
  pub password_file: Option<PathBuf>,
}

/// Arguments for `users reset-link`.
#[derive(Args)]
pub struct UserResetLinkArgs {
  /// UUID or email address of the user.
  pub id_or_email: String,
}

/// Arguments for `users set-admin`.
#[derive(Args)]
pub struct UserSetAdminArgs {
  /// UUID or email address of the user.
  pub id_or_email: String,
  /// Grant admin privileges by default; use `--admin false` to revoke.
  #[arg(long, default_value = "true", default_missing_value = "true", num_args = 0..=1, action = clap::ArgAction::Set)]
  pub admin: bool,
}

/// Arguments for `users disable` / `users enable`.
#[derive(Args)]
pub struct UserDisableEnableArgs {
  /// UUID or email address of the user.
  pub id_or_email: String,
}

/// Arguments for `users delete`.
#[derive(Args)]
pub struct UserDeleteArgs {
  /// UUID or email address of the user.
  pub id_or_email: String,
  /// Confirm the destructive operation.
  #[arg(long)]
  pub confirm: bool,
}

// ---------------------------------------------------------------------------
// Row types for display
// ---------------------------------------------------------------------------

/// Compact row for list output.
#[derive(Tabled, Serialize)]
pub struct UserRow {
  /// User UUID.
  pub id: String,
  /// User email address.
  pub email: String,
  /// Display name.
  pub name: String,
  /// Account status (active / disabled).
  pub status: String,
  /// Whether the user has admin privileges.
  pub is_admin: bool,
  /// RFC-3339 creation timestamp.
  pub created_at: String,
}

/// Detailed single-user view.
#[derive(Tabled, Serialize)]
pub struct UserDetail {
  /// User UUID.
  pub id: String,
  /// Email address.
  pub email: String,
  /// Display name.
  pub name: String,
  /// Account status.
  pub status: String,
  /// Whether the user has admin privileges.
  pub is_admin: bool,
  /// When the email was verified (empty if unverified).
  pub email_verified_at: String,
  /// RFC-3339 creation timestamp.
  pub created_at: String,
  /// RFC-3339 last-updated timestamp.
  pub updated_at: String,
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Dispatch a `users` subcommand via the service layer.
pub async fn run(cmd: UsersCommand, svc: &Services, json: bool) -> anyhow::Result<()> {
  match cmd {
    UsersCommand::List(args) => list(args, svc, json).await,
    UsersCommand::Get(args) => get(args, svc, json).await,
    UsersCommand::Create(args) => create(args, svc, json).await,
    UsersCommand::SetPassword(args) => set_password(args, svc).await,
    UsersCommand::ResetLink(args) => reset_link(args, svc, json).await,
    UsersCommand::SetAdmin(args) => set_admin(args, svc).await,
    UsersCommand::Disable(args) => set_disabled(args, svc, true).await,
    UsersCommand::Enable(args) => set_disabled(args, svc, false).await,
    UsersCommand::Delete(args) => delete(args, svc).await,
  }
}

// ---------------------------------------------------------------------------
// Implementations
// ---------------------------------------------------------------------------

async fn list(args: UserListArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let users = svc
    .admin_users
    .list_all(args.filter)
    .await
    .map_err(|e| anyhow::anyhow!("{e}"))?;

  let display: Vec<UserRow> = users
    .into_iter()
    .map(|u| UserRow {
      id: u.id.to_string(),
      email: u.email.clone(),
      name: u.name.clone(),
      status: if u.disabled {
        "disabled".to_string()
      } else {
        format!("{:?}", u.status).to_lowercase()
      },
      is_admin: u.is_admin,
      created_at: u.created_at.to_rfc3339(),
    })
    .collect();

  print_output(&display, json);
  Ok(())
}

async fn get(args: UserGetArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let user = resolve_user(svc, &args.id_or_email).await?;

  let detail = UserDetail {
    id: user.id.to_string(),
    email: user.email.clone(),
    name: user.name.clone(),
    status: if user.disabled {
      "disabled".to_string()
    } else {
      format!("{:?}", user.status).to_lowercase()
    },
    is_admin: user.is_admin,
    email_verified_at: user.email_verified_at.map(|t| t.to_rfc3339()).unwrap_or_default(),
    created_at: user.created_at.to_rfc3339(),
    updated_at: user.updated_at.to_rfc3339(),
  };

  print_single(&detail, json);
  Ok(())
}

async fn create(args: UserCreateArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let user = svc
    .admin_users
    .create(
      &args.email,
      Some(&args.name),
      None,
      myoxus_domain::audit::AuditActor::system(),
      "cli",
    )
    .await
    .map_err(|error| match error {
      myoxus_application::admin::AdminUserCreationError::DuplicateEmail => anyhow::anyhow!(
        "User with email '{}' already exists. Use `users set-password` to change their password.",
        args.email
      ),
      error => anyhow::Error::new(error),
    })?;

  let display = UserRow {
    id: user.id.to_string(),
    email: user.email.clone(),
    name: user.name.clone(),
    status: if user.disabled {
      "disabled".to_string()
    } else {
      "active".to_string()
    },
    is_admin: user.is_admin,
    created_at: user.created_at.to_rfc3339(),
  };

  if json {
    #[derive(Serialize)]
    struct CreateResult {
      user: UserRow,
    }
    print_json(&CreateResult { user: display });
  } else {
    print_single(&display, false);
  }
  Ok(())
}

async fn set_password(args: UserSetPasswordArgs, svc: &Services) -> anyhow::Result<()> {
  let user = resolve_user(svc, &args.id_or_email).await?;
  let password = read_password(&args)?;
  svc
    .auth
    .set_user_password(user.id, &password)
    .await
    .map_err(|e| anyhow::anyhow!("Failed to set password: {e}"))?;

  println!("Password updated for user {}", user.id);
  Ok(())
}

async fn reset_link(args: UserResetLinkArgs, svc: &Services, json: bool) -> anyhow::Result<()> {
  let user = resolve_user(svc, &args.id_or_email).await?;
  let reset_link = svc
    .admin_users
    .reset_link(
      user.id,
      svc.server_origin(),
      None,
      myoxus_domain::audit::AuditActor::system(),
      "cli",
    )
    .await?
    .url;
  if json {
    #[derive(Serialize)]
    struct ResetLinkResult {
      user_id: Uuid,
      reset_link: String,
    }
    print_json(&ResetLinkResult {
      user_id: user.id,
      reset_link,
    });
  } else {
    println!("{reset_link}");
  }
  Ok(())
}

async fn set_admin(args: UserSetAdminArgs, svc: &Services) -> anyhow::Result<()> {
  let user = resolve_user(svc, &args.id_or_email).await?;
  svc
    .admin_users
    .set_admin(user.id, args.admin, myoxus_domain::audit::AuditActor::system(), "cli")
    .await
    .map_err(|e| anyhow::anyhow!("Failed to set admin status: {e}"))?;
  let action = if args.admin { "granted" } else { "revoked" };
  println!("Admin privileges {action} for {} ({})", user.email, user.id);
  Ok(())
}

async fn set_disabled(args: UserDisableEnableArgs, svc: &Services, disabled: bool) -> anyhow::Result<()> {
  let user = resolve_user(svc, &args.id_or_email).await?;

  let actor = myoxus_domain::audit::AuditActor::system();
  if disabled {
    svc.admin_users.suspend(user.id, actor, "cli").await?;
  } else {
    svc.admin_users.enable(user.id, actor, "cli").await?;
  }

  let action = if disabled { "disabled" } else { "enabled" };
  println!("User {} ({}) has been {action}.", user.email, user.id);
  Ok(())
}

async fn delete(args: UserDeleteArgs, svc: &Services) -> anyhow::Result<()> {
  if !args.confirm {
    eprintln!("Are you sure? Pass --confirm to proceed.");
    std::process::exit(1);
  }

  let user = resolve_user(svc, &args.id_or_email).await?;
  let id = user.id;

  svc
    .admin_users
    .delete(id, myoxus_domain::audit::AuditActor::system(), "cli")
    .await
    .map_err(|e| anyhow::anyhow!("Failed to delete user: {e}"))?;

  println!("User {id} permanently deleted; UUID and display name retained for historical attribution.");
  Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Resolve an exact identity without inventory scan limits; storage errors remain errors.
pub async fn resolve_user(
  svc: &Services,
  id_or_email: &str,
) -> anyhow::Result<myoxus_application::admin::AdminUserProfile> {
  let user = if let Ok(id) = id_or_email.parse::<Uuid>() {
    svc.admin_users.get_by_id(id).await
  } else {
    svc.admin_users.get_by_email(id_or_email).await
  }
  .map_err(|e| anyhow::anyhow!("{e}"))?;
  user.ok_or_else(|| anyhow::anyhow!("User not found: {id_or_email}"))
}

#[derive(Debug, Eq, PartialEq)]
enum PasswordInputSource {
  Stdin,
  File(PathBuf),
  Tty,
}

fn select_password_source(args: &UserSetPasswordArgs, stdin_is_terminal: bool) -> anyhow::Result<PasswordInputSource> {
  match (args.password_stdin, args.password_file.as_ref()) {
    (true, None) => Ok(PasswordInputSource::Stdin),
    (false, Some(path)) => Ok(PasswordInputSource::File(path.clone())),
    (false, None) if stdin_is_terminal => Ok(PasswordInputSource::Tty),
    (false, None) => anyhow::bail!(
      "no password source selected; use --password-stdin or --password-file when standard input is not a terminal"
    ),
    (true, Some(_)) => anyhow::bail!("select exactly one password source"),
  }
}

fn read_password(args: &UserSetPasswordArgs) -> anyhow::Result<String> {
  let source = select_password_source(args, std::io::stdin().is_terminal())?;
  let raw = match source {
    PasswordInputSource::Stdin => read_bounded_password(std::io::stdin().lock())?,
    PasswordInputSource::File(path) => read_password_file(&path)?,
    PasswordInputSource::Tty => rpassword::prompt_password("New password: ").context("read password from terminal")?,
  };
  normalize_password_input(raw)
}

fn read_bounded_password(reader: impl Read) -> anyhow::Result<String> {
  let mut input = String::new();
  reader
    .take(MAX_PASSWORD_INPUT_BYTES + 1)
    .read_to_string(&mut input)
    .context("read password input")?;
  if input.len() as u64 > MAX_PASSWORD_INPUT_BYTES {
    anyhow::bail!("password input exceeds the supported size");
  }
  Ok(input)
}

fn read_password_file(path: &Path) -> anyhow::Result<String> {
  let metadata = std::fs::symlink_metadata(path).context("inspect password file")?;
  if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
    anyhow::bail!("password file must be a regular file");
  }
  if metadata.len() > MAX_PASSWORD_INPUT_BYTES {
    anyhow::bail!("password file exceeds the supported size");
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    if metadata.permissions().mode() & 0o077 != 0 {
      anyhow::bail!("password file must not be accessible by group or other users");
    }
  }
  read_bounded_password(File::open(path).context("open password file")?)
}

fn normalize_password_input(mut password: String) -> anyhow::Result<String> {
  if password.ends_with('\n') {
    password.pop();
    if password.ends_with('\r') {
      password.pop();
    }
  }
  if password.is_empty() {
    anyhow::bail!("password input must not be empty");
  }
  if password.contains('\r') || password.contains('\n') {
    anyhow::bail!("password input must contain exactly one line");
  }
  Ok(password)
}

#[cfg(test)]
mod tests {
  use std::io::Write;

  use super::*;

  fn args() -> UserSetPasswordArgs {
    UserSetPasswordArgs {
      id_or_email: "user@example.test".to_string(),
      password_stdin: false,
      password_file: None,
    }
  }

  #[test]
  fn source_selection_requires_explicit_input_for_non_tty_usage() {
    let default_args = args();
    assert!(select_password_source(&default_args, false).is_err());
    assert_eq!(
      select_password_source(&default_args, true).expect("interactive source"),
      PasswordInputSource::Tty
    );

    let mut stdin_args = args();
    stdin_args.password_stdin = true;
    assert_eq!(
      select_password_source(&stdin_args, false).expect("stdin source"),
      PasswordInputSource::Stdin
    );
  }

  #[test]
  fn normalization_removes_only_one_transport_newline() {
    assert_eq!(
      normalize_password_input("  valid secret  \r\n".to_string()).expect("password"),
      "  valid secret  "
    );
    assert!(normalize_password_input("\n".to_string()).is_err());
    assert!(normalize_password_input("first\nsecond\n".to_string()).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn password_file_must_be_owner_only_and_regular() {
    use std::os::unix::fs::PermissionsExt;

    let mut file = tempfile::NamedTempFile::new().expect("password file");
    writeln!(file, "valid-password").expect("write password");
    std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o600)).expect("secure mode");
    assert_eq!(
      read_password_file(file.path()).expect("read password"),
      "valid-password\n"
    );

    std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o640)).expect("insecure mode");
    assert!(read_password_file(file.path()).is_err());
  }
}
