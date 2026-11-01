// SPDX-License-Identifier: AGPL-3.0-or-later
fn main() {
  // Panic payloads may contain template/document text. The parent receives a
  // structured failure; neither the hook nor stderr may disclose that text.
  std::panic::set_hook(Box::new(|_| {}));
  if myoxus_pdf_export::execution::compiler_main().is_err() {
    std::process::exit(1);
  }
}
