// SPDX-License-Identifier: AGPL-3.0-or-later
//! Resolve SVG paint before converting colours, preserving geometry and text.

use std::path::PathBuf;

use base64::Engine as _;
use quick_xml::{
  Reader, Writer,
  events::{BytesStart, Event},
};

use super::image_pipeline::CompressionError;

pub(super) fn convert(
  bytes: &[u8],
  fonts: &[PathBuf],
  family: &str,
  depth: usize,
) -> Result<Vec<u8>, CompressionError> {
  if depth > 8 {
    return Err(CompressionError::Decode("nested SVG image limit exceeded".into()));
  }
  // Reuse Typst's own resolver: it normalizes font-family names and applies
  // the same approved font inventory and fallback as the final SVG placement.
  use comemo::Track as _;
  let world = crate::typst_engine::world::TypstWorld::new(String::new(), Default::default(), fonts);
  let world: &dyn typst::World = &world;
  let image = typst::visualize::SvgImage::with_fonts_images(
    typst::foundations::Bytes::new(bytes.to_vec()),
    world.track(),
    &[family],
    None,
  )
  .map_err(|error| decode_error(format!("{error:?}")))?;
  let canonical = image.tree().to_string(&resvg::usvg::WriteOptions {
    preserve_text: true,
    ..Default::default()
  });
  let mut reader = Reader::from_str(&canonical);
  let mut writer = Writer::new(Vec::new());
  loop {
    let event = reader.read_event().map_err(decode_error)?;
    match event {
      Event::Start(element) => {
        writer.write_event(Event::Start(convert_element(&element, &reader, fonts, family, depth)?))
      }
      Event::Empty(element) => {
        writer.write_event(Event::Empty(convert_element(&element, &reader, fonts, family, depth)?))
      }
      Event::End(element) if element.name().as_ref() == b"filter" => {
        // An authored filter may generate new colour independently of its input
        // paints. Limit its output too; do not add a filter to vector geometry.
        let mut gray = BytesStart::new("feColorMatrix");
        gray.push_attribute(("type", "saturate"));
        gray.push_attribute(("values", "0"));
        writer.write_event(Event::Empty(gray)).map_err(decode_error)?;
        writer.write_event(Event::End(element))
      }
      Event::Eof => break,
      event => writer.write_event(event),
    }
    .map_err(decode_error)?;
  }
  Ok(writer.into_inner())
}

fn convert_element(
  element: &BytesStart<'_>,
  reader: &Reader<&[u8]>,
  fonts: &[PathBuf],
  family: &str,
  depth: usize,
) -> Result<BytesStart<'static>, CompressionError> {
  let name = std::str::from_utf8(element.name().as_ref())
    .map_err(decode_error)?
    .to_owned();
  let mut result = BytesStart::new(name);
  for attribute in element.attributes() {
    let attribute = attribute.map_err(decode_error)?;
    let key = std::str::from_utf8(attribute.key.as_ref()).map_err(decode_error)?;
    let value = attribute
      .decoded_and_normalized_value(quick_xml::XmlVersion::Implicit1_0, reader.decoder())
      .map_err(decode_error)?;
    let value = match key {
      "fill" | "stroke" | "stop-color" | "flood-color" | "lighting-color" => gray_paint(&value),
      "href" | "xlink:href" if value.starts_with("data:image/") => {
        let (prefix, payload) = value
          .split_once(",")
          .ok_or_else(|| decode_error("invalid embedded image"))?;
        if !prefix.ends_with(";base64") {
          return Err(decode_error("invalid canonical image encoding"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
          .decode(payload.bytes().filter(|b| !b.is_ascii_whitespace()).collect::<Vec<_>>())
          .map_err(decode_error)?;
        let converted = super::image_pipeline::grayscale_at_depth(&bytes, fonts, family, depth + 1)?;
        format!(
          "{prefix},{}",
          base64::engine::general_purpose::STANDARD.encode(converted)
        )
      }
      _ => value.into_owned(),
    };
    result.push_attribute((key, value.as_str()));
  }
  Ok(result)
}

fn gray_paint(value: &str) -> String {
  let Some(hex) = value.strip_prefix('#').filter(|v| v.len() == 6) else {
    return value.to_owned();
  };
  let rgb = [0, 2, 4].map(|i| u8::from_str_radix(&hex[i..i + 2], 16));
  if let [Ok(r), Ok(g), Ok(b)] = rgb {
    let gray = ((2126 * u32::from(r) + 7152 * u32::from(g) + 722 * u32::from(b) + 5000) / 10000) as u8;
    format!("#{gray:02x}{gray:02x}{gray:02x}")
  } else {
    value.to_owned()
  }
}

fn decode_error(error: impl std::fmt::Display) -> CompressionError {
  CompressionError::Decode(error.to_string())
}
