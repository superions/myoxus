# WordCraft codec provenance

Upstream release: `v0.19.1`.

Source: https://github.com/storytold/wordcraft at commit
`5d658dc033f3139926839bffd6ae0eef558c210c`.

Upstream `v0.19.1` extracts the OOXML/DOCX codec, word model, XML/OPC/ZIP
layers, Office cryptography, math, DrawingML and legacy codepage tables into
https://github.com/storytold/craft-libs at commit
`93dac78c93a7f1fd66e2022edeb089233b1dc45a`.

Retained crates:

- `crates/geom`, `crates/doc`, and `crates/docx` from `storytold/wordcraft`
  (with upstream MIT/Apache-2.0 licences, NOTICE and attribution preserved).
- `craft-libs/crates/{cfb,codepage,zip,xml,math,drawingml,offcrypto,opc,wordmodel,docx}`
  plus dev-only test helpers `craft-libs/crates/{media-testkit,testkit}` from
  `storytold/craft-libs` (with upstream MIT/Apache-2.0 licences, NOTICE and
  attribution preserved under `craft-libs/`).

The root Cargo manifests are reduced to these retained crates and exclude the
WordCraft application, layout engine, font assets, UI and unrelated media/image
codec crates. `crates/geom` omits the optional `image` feature (`picture.rs`),
which is unused by Myoxus; six DOCX integration test PNG helpers encode test
fixtures directly through the existing `image` dev-dependency instead.

Upstream `craft-zip` natively uses the `zip` 9 API; no custom ZIP filename patch
is required. `craft-libs/Cargo.toml` selects `zip = "9.8.2"` with the same
`deflate-flate2-zlib-rs` feature used by the server.

Retained local Myoxus patches:

1. **Full theme-font embedding** (`craft-wordmodel`, `craft-docx`,
   `wordcraft-doc`, `wordcraft-docx`): exposes `FontToEmbed` and `embed_fonts`
   using the existing embedded-part writer, including OOXML font obfuscation and
   `w:embedTrueTypeFonts` / `w:saveSubsetFonts` settings persistence. Font
   selection, validation and embedding permissions remain with the server
   adapter; no WordCraft font assets or layout code are included.
2. **Paired SVG/PNG pictures** (`craft-wordmodel`, `craft-docx`,
   `wordcraft-doc`, `wordcraft-docx`): retains optional SVG media beside each
   raster fallback (`svg_images` / `pair_svg`), reading and writing Office's
   standard `asvg:svgBlip` relationship while preserving upstream
   missing-picture diagnostics without fetching external content. The
   section-metadata roundtrip tests check the required ignorable namespace
   prefixes as a set, allowing the additional `asvg` prefix.
