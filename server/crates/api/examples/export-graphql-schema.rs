// SPDX-License-Identifier: AGPL-3.0-or-later

//! Export GraphQL SDL for documentation without starting the server or connecting to services.

use std::io::{self, Write};

fn main() -> io::Result<()> {
  io::stdout()
    .lock()
    .write_all(myoxus_api::export_graphql_schema().as_bytes())
}
