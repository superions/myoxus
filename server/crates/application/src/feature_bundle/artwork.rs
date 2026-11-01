// SPDX-License-Identifier: AGPL-3.0-or-later
//! Immutable artwork is validated, never sanitized into different pinned bytes.
use myoxus_domain::feature_bundle::FeatureArtwork;
use quick_xml::{Reader, events::Event};
use std::io::Cursor;

const MAX_DIMENSION: u32 = 8192;
const MAX_PIXELS: u64 = 16 * 1024 * 1024;

pub(super) fn validate_artwork(bytes: &[u8], metadata: &FeatureArtwork) -> Result<(), String> {
  if metadata.width == 0
    || metadata.height == 0
    || metadata.width > MAX_DIMENSION
    || metadata.height > MAX_DIMENSION
    || u64::from(metadata.width) * u64::from(metadata.height) > MAX_PIXELS
    || [
      &metadata.alternative.en,
      &metadata.alternative.de,
      &metadata.alternative.fr,
      &metadata.alternative.es,
    ]
    .iter()
    .any(|value| value.trim().is_empty() || value.len() > 8192)
    || metadata.caption.as_ref().is_some_and(|caption| {
      [&caption.en, &caption.de, &caption.fr, &caption.es]
        .iter()
        .any(|value| value.trim().is_empty() || value.len() > 8192)
    })
  {
    return Err("invalid Artwork dimensions or localized metadata".into());
  }
  let actual = match metadata.media_type.as_str() {
    "image/svg+xml" => validate_svg(bytes)?,
    "image/png" | "image/webp" => {
      let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| "invalid Artwork raster format")?;
      let expected = if metadata.media_type == "image/png" {
        image::ImageFormat::Png
      } else {
        image::ImageFormat::WebP
      };
      if reader.format() != Some(expected) {
        return Err("Artwork MIME differs from actual raster format".into());
      }
      let mut limits = image::Limits::default();
      limits.max_image_width = Some(metadata.width);
      limits.max_image_height = Some(metadata.height);
      limits.max_alloc = Some(MAX_PIXELS * 8);
      reader.limits(limits);
      let decoded = reader
        .decode()
        .map_err(|_| "invalid or oversized Artwork raster payload")?;
      (decoded.width(), decoded.height())
    }
    _ => return Err("unsupported Artwork MIME".into()),
  };
  if actual != (metadata.width, metadata.height) {
    return Err("Artwork dimensions differ from its native image".into());
  }
  Ok(())
}

fn validate_svg(bytes: &[u8]) -> Result<(u32, u32), String> {
  std::str::from_utf8(bytes).map_err(|_| "Artwork SVG must be UTF-8")?;
  let mut reader = Reader::from_reader(bytes);
  let mut events = 0usize;
  loop {
    events += 1;
    if events > 100_000 {
      return Err("Artwork SVG element limit exceeded".into());
    }
    match reader.read_event().map_err(|_| "invalid Artwork SVG XML")? {
      Event::Eof => break,
      Event::DocType(_) | Event::PI(_) => return Err("Artwork SVG cannot declare active or external resources".into()),
      Event::Start(element) | Event::Empty(element) => {
        let name = element.name();
        let name = std::str::from_utf8(name.as_ref()).map_err(|_| "invalid Artwork SVG element")?;
        // A finite static SVG vocabulary avoids animation, embedded documents,
        // stylesheets and resource loaders before parsing the renderer tree.
        if !matches!(
          name,
          "svg"
            | "g"
            | "defs"
            | "use"
            | "symbol"
            | "clipPath"
            | "mask"
            | "path"
            | "rect"
            | "circle"
            | "ellipse"
            | "line"
            | "polyline"
            | "polygon"
            | "text"
            | "tspan"
            | "textPath"
            | "linearGradient"
            | "radialGradient"
            | "stop"
            | "title"
            | "desc"
            | "pattern"
            | "marker"
        ) {
          return Err(format!("unsupported active Artwork SVG element {name}"));
        }
        for attribute in element.attributes() {
          let attribute = attribute.map_err(|_| "invalid Artwork SVG attribute")?;
          let key = std::str::from_utf8(attribute.key.as_ref())
            .map_err(|_| "invalid Artwork SVG attribute name")?
            .to_ascii_lowercase();
          let value = attribute
            .decoded_and_normalized_value(quick_xml::XmlVersion::Explicit1_0, reader.decoder())
            .map_err(|_| "invalid Artwork SVG attribute value")?;
          let normalized = value.trim().to_ascii_lowercase();
          if key.starts_with("on") || matches!(key.as_str(), "style" | "xml:base") || normalized.contains('\\') {
            return Err("Artwork SVG cannot contain active attributes or CSS".into());
          }
          if matches!(key.as_str(), "href" | "xlink:href") && !normalized.starts_with('#') {
            return Err("Artwork SVG references must be local fragments".into());
          }
          if normalized.contains("url(")
            && !(normalized.starts_with("url(#")
              && normalized.ends_with(')')
              && !normalized[5..normalized.len() - 1].contains(['(', ')', '\'', '"']))
          {
            return Err("Artwork SVG paint references must be local fragments".into());
          }
        }
      }
      _ => {}
    }
  }
  // Reuse the existing native SVG renderer with external/file resolution
  // disabled. The authored bytes, including their immutable digest, survive.
  let options = usvg::Options {
    image_href_resolver: usvg::ImageHrefResolver {
      resolve_string: Box::new(|_, _| None),
      ..Default::default()
    },
    ..Default::default()
  };
  let tree = usvg::Tree::from_data(bytes, &options).map_err(|_| "invalid Artwork SVG render tree")?;
  let width = tree.size().width();
  let height = tree.size().height();
  if width.fract() != 0.0 || height.fract() != 0.0 || width > MAX_DIMENSION as f32 || height > MAX_DIMENSION as f32 {
    return Err("Artwork SVG requires bounded whole-pixel dimensions".into());
  }
  Ok((width as u32, height as u32))
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_domain::assistant_package::AssistantLocalizedText;
  fn metadata() -> FeatureArtwork {
    FeatureArtwork {
      role: None,
      media_type: "image/svg+xml".into(),
      width: 12,
      height: 8,
      alternative: AssistantLocalizedText {
        en: "Project".into(),
        de: "Projekt".into(),
        fr: "Projet".into(),
        es: "Proyecto".into(),
      },
      caption: None,
    }
  }
  #[test]
  fn artwork_rejects_active_external_or_false_image_metadata_without_changing_bytes() {
    let safe=br##"<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><path d="M0 0L12 8"/><use href="#local"/></svg>"##;
    validate_artwork(safe, &metadata()).unwrap();
    for body in [
      "<script/>",
      "<foreignObject/>",
      "<style/>",
      "<animate/>",
      "<use href='https://example.invalid/a'/>",
      "<path onclick='run()'/>",
      "<path fill='url(https://example.invalid/a)'/>",
    ] {
      let svg = format!("<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8'>{body}</svg>");
      assert!(validate_artwork(svg.as_bytes(), &metadata()).is_err(), "{body}");
    }
    let mut mismatch = metadata();
    mismatch.width = 11;
    assert!(validate_artwork(safe, &mismatch).is_err());
    mismatch = metadata();
    mismatch.media_type = "image/png".into();
    assert!(validate_artwork(safe, &mismatch).is_err());
  }

  #[test]
  fn raster_admission_decodes_the_actual_png_and_webp_with_bounded_dimensions() {
    for (format, mime) in [
      (image::ImageFormat::Png, "image/png"),
      (image::ImageFormat::WebP, "image/webp"),
    ] {
      let mut output = Cursor::new(Vec::new());
      image::DynamicImage::ImageRgba8(image::RgbaImage::new(2, 3))
        .write_to(&mut output, format)
        .unwrap();
      let mut declared = metadata();
      declared.width = 2;
      declared.height = 3;
      declared.media_type = mime.into();
      validate_artwork(output.get_ref(), &declared).unwrap();
      declared.width = 1;
      assert!(validate_artwork(output.get_ref(), &declared).is_err());
      declared.width = 2;
      declared.media_type = if mime == "image/png" { "image/webp" } else { "image/png" }.into();
      assert!(validate_artwork(output.get_ref(), &declared).is_err());
    }
    let mut declared = metadata();
    declared.media_type = "image/png".into();
    assert!(validate_artwork(b"\x89PNG\r\n\x1a\n", &declared).is_err());
  }
}
