# WordCraft codec provenance

Upstream release: `v0.18.1`.

Source: https://github.com/storytold/wordcraft at commit
`079f478bd85df7bcc567e3bafa7d7219096f9c3c`.

Only `crates/geom`, `crates/doc`, and `crates/docx` are retained. The upstream
MIT/Apache-2.0 licences, NOTICE and attribution are preserved alongside them.
The root Cargo manifest is reduced to dependencies of these three crates; it
does not include the WordCraft application, layout engine, font assets or UI.

Local source modification: `crates/docx/src/package.rs` uses the fallible ZIP
9.0.5 filename API instead of the upstream ZIP 3 `name()` accessor. The root
manifest selects ZIP 9.0.5 with the same deflate feature used by the server.
The DOCX integration test helpers likewise unwrap the fallible `name()` and
`file_names()` results for their generated fixtures; their assertions are unchanged.

Myoxus also exposes a small font-table authoring helper using the existing
embedded-part writer, including OOXML font obfuscation and full-font save
settings. Font selection, validation and embedding permissions remain with the
server adapter; no WordCraft font assets or layout code are included.

The picture codec also retains optional SVG media beside each raster fallback,
reading/writing Office's standard `asvg:svgBlip` relationship. The document model
keeps that pairing through native JSON and document merge; raster-only consumers
continue to use the original picture media.

The v0.18.1 merge retains upstream missing-picture diagnostics alongside the SVG
pairing; linked pictures are reported without fetching external content. All
other upstream codec/model changes are retained.

The section-metadata roundtrip test checks the required ignorable namespace
prefixes as a set, allowing the additional `asvg` prefix from the SVG patch.
