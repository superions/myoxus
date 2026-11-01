use std::fs;

use client_schema::get_migrator;
use sqlx::sqlite::SqliteConnectOptions;

#[tokio::main]
async fn main() -> Result<(), std::io::Error> {
  napi_build::setup();

  // SQLx checks use a fresh schema database isolated in Cargo's build output.
  let build_dir = std::env::var("OUT_DIR").unwrap();
  let db_path = format!("{build_dir}/schema.db");

  if fs::metadata(&db_path).is_ok() {
    fs::remove_file(&db_path)?;
  }

  let options = SqliteConnectOptions::new()
    .filename(&db_path)
    .journal_mode(sqlx::sqlite::SqliteJournalMode::Off)
    .locking_mode(sqlx::sqlite::SqliteLockingMode::Exclusive)
    .create_if_missing(true);
  let pool = sqlx::sqlite::SqlitePoolOptions::new()
    .max_connections(1)
    .connect_with(options)
    .await
    .unwrap();

  get_migrator().run(&pool).await.unwrap();

  println!("cargo::rustc-env=DATABASE_URL=sqlite://{db_path}");

  Ok(())
}
