//! Fonts a file embeds through its font table (#1171).
//!
//! The reader keeps the font table and its font parts as opaque passthrough parts, for writing
//! back. [`embedded_fonts`] hands their font files to whoever lays the document out, undoing the
//! obfuscation Word applies to them (ECMA-376 Part 1, 17.8.1).

use std::collections::HashSet;

use wordcraft_doc::Document;

use crate::package::{EMBEDDED_PARTS, EmbeddedManifest};

/// Most font files taken from one document.
const MAX_FONTS: usize = 64;

/// Most bytes of font files copied out of one document: one part's limit, however many
/// references the font table makes (each reference is a copy; 64 of them to one large part
/// were 64 copies, #3692).
const MAX_FONT_BYTES: u64 = crate::package::MAX_PART;

/// The font table's references to embedded font files, one per style.
const EMBEDS: [&str; 4] = ["w:embedRegular", "w:embedBold", "w:embedItalic", "w:embedBoldItalic"];

/// A font file a document embeds, and the name its font table gives the font: the name the text
/// asks for, which a subset Word embeds doesn't carry inside (#2240).
#[derive(Clone, Debug, PartialEq)]
pub struct EmbeddedFont {
    /// `w:font/@w:name`.
    pub name: String,
    /// The font file, de-obfuscated.
    pub data: Vec<u8>,
}

/// A complete static font face to embed. The caller validates the font and its
/// embedding rights; this codec only packages and obfuscates its bytes.
#[derive(Clone, Debug)]
pub struct FontToEmbed {
    pub name: String,
    pub bold: bool,
    pub italic: bool,
    pub data: std::sync::Arc<Vec<u8>>,
}

/// Replace the font table with full editable faces, using the same part writer
/// as imported fonts. Existing unrelated embedded parts are retained.
pub fn embed_fonts(doc: &mut Document, fonts: &[FontToEmbed]) -> Result<(), crate::DocxError> {
    use crate::package::{EmbeddedPart, FONT_TABLE_PART, Rel};
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, sync::Arc};

    if fonts.is_empty() {
        return Ok(());
    }
    if fonts.len() > MAX_FONTS || fonts.iter().map(|f| f.data.len() as u64).sum::<u64>() > MAX_FONT_BYTES {
        return Err(crate::DocxError::Limit("embedded fonts".into()));
    }
    let mut manifest = doc
        .passthrough
        .get(EMBEDDED_PARTS)
        .map(|m| EmbeddedManifest::parse(m))
        .unwrap_or_default();
    let mut part = EmbeddedPart {
        content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml".into(),
        rels: Vec::new(),
    };
    let mut table = crate::xml::W::new();
    table.open(
        "w:fonts",
        &[
            ("xmlns:w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main"),
            ("xmlns:r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"),
        ],
    );
    let mut families: BTreeMap<&str, Vec<&FontToEmbed>> = BTreeMap::new();
    for font in fonts {
        families.entry(&font.name).or_default().push(font);
    }
    for (family, faces) in families {
        table.open("w:font", &[("w:name", family)]);
        for font in faces {
            if font.data.len() < 32 {
                return Err(crate::DocxError::Limit("embedded font is too short".into()));
            }
            // Obfuscation is OOXML packaging, not encryption. A content key also
            // deduplicates faces shared by more than one font-table entry.
            let digest = Sha256::digest(&*font.data);
            let hex: String = digest.iter().map(|b| format!("{b:02X}")).collect();
            let key = format!(
                "{{{}-{}-{}-{}-{}}}",
                &hex[..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..32]
            );
            let target = format!("word/fonts/{hex}.odttf");
            let id = format!("rId{}", part.rels.len() + 1);
            let mut data = font.data.as_ref().clone();
            for (i, byte) in data.iter_mut().take(32).enumerate() {
                *byte ^= digest[15 - i % 16];
            }
            doc.passthrough.insert(target.clone(), Arc::new(data));
            manifest.parts.insert(
                target.clone(),
                EmbeddedPart {
                    content_type: "application/vnd.openxmlformats-officedocument.obfuscatedFont".into(),
                    rels: Vec::new(),
                },
            );
            part.rels.push(Rel {
                id: id.clone(),
                kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font".into(),
                target,
                external: false,
            });
            let tag = match (font.bold, font.italic) {
                (false, false) => EMBEDS[0],
                (true, false) => EMBEDS[1],
                (false, true) => EMBEDS[2],
                (true, true) => EMBEDS[3],
            };
            table.empty(tag, &[("r:id", &id), ("w:fontKey", &key), ("w:subsetted", "0")]);
        }
        table.close("w:font");
    }
    table.close("w:fonts");
    manifest.parts.insert(FONT_TABLE_PART.into(), part);
    doc.passthrough.insert(FONT_TABLE_PART.into(), Arc::new(table.s.into_bytes()));
    doc.passthrough.insert(EMBEDDED_PARTS.into(), Arc::new(manifest.to_bytes()));
    doc.settings.embed_fonts = true;
    doc.settings.save_subset_fonts = false;
    Ok(())
}

/// The font files `doc`'s font table embeds, de-obfuscated, in table order. Not checked to be
/// fonts: that is up to the font database. Empty for a document read from anything but a package
/// with a font table.
pub fn embedded_fonts(doc: &Document) -> Vec<EmbeddedFont> {
    fonts_within(doc, MAX_FONT_BYTES)
}

/// [`embedded_fonts`], copying at most `budget` bytes of font files.
fn fonts_within(doc: &Document, mut budget: u64) -> Vec<EmbeddedFont> {
    let budget_total = budget;
    let manifest = doc.passthrough.get(EMBEDDED_PARTS).map(|m| EmbeddedManifest::parse(m)).unwrap_or_default();
    // The table is kept under the spelling the package stores it as (#3872).
    let Some(key) = crate::package::font_table_key(&doc.passthrough) else {
        return Vec::new();
    };
    let Some(table) = doc.passthrough.get(key).and_then(|b| crate::xml::parse(b).ok()) else {
        return Vec::new();
    };
    let Some(part) = manifest.parts.get(key) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // A reference repeating one already taken (same file, key and name) gives the same font.
    let mut taken: HashSet<(&str, [u8; 16], &str)> = HashSet::new();
    let mut over_budget = 0usize;
    let embeds = table
        .children("w:font")
        .flat_map(|f| f.els().filter(|e| EMBEDS.contains(&e.name.as_str())).map(move |e| (f.attr("w:name").unwrap_or(""), e)));
    for (name, embed) in embeds {
        if out.len() >= MAX_FONTS {
            log::warn!("docx: more than {MAX_FONTS} embedded fonts; the rest are not loaded");
            break;
        }
        let Some(rel) = embed.attr("r:id").and_then(|id| part.rels.iter().find(|r| r.id == id && !r.external)) else {
            continue;
        };
        let Some(bytes) = doc.passthrough.get(&rel.target) else {
            continue;
        };
        // No key: the file is stored as is, as with the all-zero key.
        let key = match embed.attr("w:fontKey") {
            Some(k) => match font_key(k) {
                Some(key) => key,
                None => {
                    log::warn!("docx: embedded font {} has an unreadable key {k:?}", rel.target);
                    continue;
                }
            },
            None => [0; 16],
        };
        if !taken.insert((rel.target.as_str(), key, name)) {
            continue;
        }
        // Checked before the copy is made.
        let Some(left) = budget.checked_sub(bytes.len() as u64) else {
            over_budget += 1;
            continue;
        };
        budget = left;
        let mut data = bytes.to_vec();
        for (i, b) in data.iter_mut().take(32).enumerate() {
            *b ^= key.get(i % 16).copied().unwrap_or(0);
        }
        out.push(EmbeddedFont { name: name.to_string(), data });
    }
    if over_budget > 0 {
        // Once for the document, not once per font.
        log::warn!("docx: embedded fonts past the {budget_total} byte budget; {over_budget} of them are not loaded");
    }
    out
}

/// The obfuscation key of a `w:fontKey` GUID (`{XXXXXXXX-XXXX-…}`): its 16 bytes, reversed.
fn font_key(guid: &str) -> Option<[u8; 16]> {
    let digits: Vec<u8> = guid.bytes().filter(|c| !matches!(c, b'{' | b'}' | b'-')).collect();
    if digits.len() != 32 {
        return None;
    }
    let mut key = [0u8; 16];
    for (i, pair) in digits.chunks(2).enumerate() {
        let byte = u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok()?;
        *key.get_mut(15 - i)? = byte;
    }
    Some(key)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::package::FONT_TABLE_PART;

    /// A document whose font table makes `refs` references (`(font name, part)`) to font parts
    /// `parts` (`(name, size)`).
    fn doc_with(refs: &[(&str, &str)], parts: &[(&str, usize)]) -> Document {
        let mut table = String::from(
            r#"<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
        );
        let mut manifest = format!("P\t{FONT_TABLE_PART}\tapplication/xml\n");
        for (i, (font, part)) in refs.iter().enumerate() {
            table.push_str(&format!(r#"<w:font w:name="{font}"><w:embedRegular r:id="rId{i}"/></w:font>"#));
            manifest.push_str(&format!("R\t{FONT_TABLE_PART}\trId{i}\tfont\t{part}\tI\n"));
        }
        table.push_str("</w:fonts>");
        let mut doc = Document::default();
        doc.passthrough.insert(FONT_TABLE_PART.into(), Arc::new(table.into_bytes()));
        doc.passthrough.insert(EMBEDDED_PARTS.into(), Arc::new(manifest.into_bytes()));
        for (part, size) in parts {
            doc.passthrough.insert((*part).into(), Arc::new(vec![7u8; *size]));
        }
        doc
    }

    #[test]
    fn a_font_referenced_again_is_copied_once() {
        // Each reference was its own copy: the 64 references allowed to one 256 MB part were
        // 16 GB of copies (#3692).
        let refs = vec![("Body", "word/fonts/a.odttf"); MAX_FONTS];
        let fonts = embedded_fonts(&doc_with(&refs, &[("word/fonts/a.odttf", 1000)]));
        assert_eq!(fonts.len(), 1);
    }

    #[test]
    fn font_copies_stop_at_the_byte_budget() {
        let refs: Vec<(String, &str)> = (0..MAX_FONTS).map(|i| (format!("Font {i}"), "word/fonts/a.odttf")).collect();
        let refs: Vec<(&str, &str)> = refs.iter().map(|(n, p)| (n.as_str(), *p)).collect();
        let doc = doc_with(&refs, &[("word/fonts/a.odttf", 1000)]);
        let (fonts, warned) = crate::test_log::warnings(|| fonts_within(&doc, 3500));
        assert_eq!(fonts.len(), 3, "three copies fit");
        let budget: Vec<_> = warned.iter().filter(|w| w.contains("byte budget")).collect();
        assert_eq!(budget.len(), 1, "one warning for the document, not one per font: {warned:?}");
        assert!(budget.iter().all(|w| w.contains(&format!("{} of them", MAX_FONTS - 3))), "{budget:?}");
        assert_eq!(embedded_fonts(&doc).len(), MAX_FONTS, "well within the real budget");
    }
}
