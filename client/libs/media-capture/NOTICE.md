# Media Capture Provenance

The outer NAPI wrapper in this directory is Myoxus code licensed under
`AGPL-3.0-or-later`.

The Rust implementation under `media_capture/` descends from AFFiNE's
`packages/frontend/native/media_capture` implementation. It was introduced in
AFFiNE commit `5dbffba08dd6459b6d7314c497bcf14714cb9ae7` and moved without a
source rewrite into the current package by Myoxus commit
`fc38858d8899dcff47b990737fb4ec8ca81e85fe`. Retained source keeps the MIT grant; its original license text is preserved
in `media_capture/LICENSE`. The retained files remain MIT, including Myoxus
changes within those files. Independently authored new inner-crate files are
AGPL-3.0-or-later, as recorded per file in `client/REUSE.toml`.
A Cargo/npm package label does not determine source licensing.

Myoxus modifications to the MIT component do not remove the original
copyright or license grant.
