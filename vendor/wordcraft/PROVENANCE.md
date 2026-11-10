# WordCraft codec provenance

Upstream release: `v0.16.0`.

Source: https://github.com/storytold/wordcraft at commit
`02a802cbafe45b5c8fecc00490c8f6b78c5ba251`.

Only `crates/geom`, `crates/doc`, and `crates/docx` are retained. The upstream
MIT/Apache-2.0 licences, NOTICE and attribution are preserved alongside them.
The root Cargo manifest is reduced to dependencies of these three crates; it
does not include the WordCraft application, layout engine, font assets or UI.

Local source modification: `crates/docx/src/package.rs` uses the fallible ZIP
9.0.5 filename API instead of the upstream ZIP 3 `name()` accessor. The root
manifest selects ZIP 9.0.5 with the same deflate feature used by the server.
The DOCX integration test helpers likewise unwrap the fallible `name()` and
`file_names()` results for their generated fixtures; their assertions are unchanged.
