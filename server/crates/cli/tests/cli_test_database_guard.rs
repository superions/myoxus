// SPDX-License-Identifier: AGPL-3.0-or-later

mod support;

use support::{REQUIRED_TEST_PORT, database_url, validate_database_url};

#[test]
fn cli_test_database_guard_accepts_the_isolated_test_stack() {
  assert!(validate_database_url(&database_url()).is_ok());
}

#[test]
fn cli_test_database_guard_rejects_the_historical_development_database() {
  let error = validate_database_url("postgres://myoxus:myoxus@localhost:5432/myoxus")
    .expect_err("the development database must be rejected before connecting");
  assert_eq!(
    error,
    format!("TEST_DATABASE_URL must select the isolated 'myoxus_test' database")
  );
}

#[test]
fn cli_test_database_guard_rejects_other_database_names_and_malformed_urls() {
  assert!(validate_database_url("postgres://user:secret@localhost:5434/another_test").is_err());
  assert!(validate_database_url("not a postgres url").is_err());
}

#[test]
fn cli_test_database_guard_rejects_the_development_port_even_with_isolated_database_name() {
  let error = validate_database_url("postgres://myoxus_test:myoxus_test@localhost:5432/myoxus_test")
    .expect_err("the development port must be rejected even when the database name is isolated");
  assert_eq!(
    error,
    format!("TEST_DATABASE_URL must point at the isolated test stack on port {REQUIRED_TEST_PORT}")
  );
}

#[test]
fn cli_test_database_guard_rejects_an_omitted_port_defaulting_to_the_development_stack() {
  let error = validate_database_url("postgres://myoxus_test:myoxus_test@localhost/myoxus_test")
    .expect_err("an omitted port resolves to the PostgreSQL default 5432 and must be rejected");
  assert_eq!(
    error,
    format!("TEST_DATABASE_URL must point at the isolated test stack on port {REQUIRED_TEST_PORT}")
  );
}
