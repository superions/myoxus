//! Output rendering helpers — pretty tables or JSON depending on global `--json` flag.

use serde::Serialize;
use tabled::{Table, Tabled};

/// Render a slice of tabled rows as a pretty ASCII table to stdout.
pub fn print_table<T: Tabled>(rows: &[T]) {
  if rows.is_empty() {
    println!("(no rows)");
    return;
  }
  println!("{}", Table::new(rows));
}

/// Serialize value as pretty JSON to stdout.
pub fn print_json<T: Serialize + ?Sized>(value: &T) {
  match serde_json::to_string_pretty(value) {
    Ok(s) => println!("{}", s),
    Err(e) => eprintln!("JSON serialization error: {e}"),
  }
}

/// Print either a table or JSON depending on the `--json` flag.
pub fn print_output<T: Tabled + Serialize>(rows: &[T], json: bool) {
  if json {
    print_json(rows);
  } else {
    print_table(rows);
  }
}

/// Print a single item as table (single-row) or JSON.
pub fn print_single<T: Tabled + Serialize>(item: &T, json: bool) {
  if json {
    print_json(item);
  } else {
    print_table(std::slice::from_ref(item));
  }
}
