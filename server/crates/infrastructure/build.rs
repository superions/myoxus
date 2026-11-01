// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

fn main() {
  // SQLx tracks existing embedded SQL files, but adding a migration must also
  // invalidate cached binaries so startup executes the complete forward chain.
  println!("cargo:rerun-if-changed=migrations");
}
