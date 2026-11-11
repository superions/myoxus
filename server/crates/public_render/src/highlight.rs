use std::sync::OnceLock;

use syntect::{
  easy::HighlightLines,
  highlighting::ThemeSet,
  html::{IncludeBackground, styled_line_to_highlighted_html},
  parsing::{SyntaxReference, SyntaxSet},
  util::LinesWithEndings,
};

/// A literal source slice and its syntax colour, independent of HTML markup.
pub struct CodeSpan<'a> {
  pub text: &'a str,
  pub color: [u8; 3],
}

/// Highlight editable exports without an HTML roundtrip. Unknown languages or
/// parser failures return `None`; callers must retain the complete plain source.
pub fn highlight_code<'a>(language: Option<&str>, text: &'a str, dark_background: bool) -> Option<Vec<CodeSpan<'a>>> {
  let syntax = find_syntax(language)?;
  let theme = theme_set().themes.get(if dark_background {
    "base16-ocean.dark"
  } else {
    "InspiredGitHub"
  })?;
  let mut highlighter = HighlightLines::new(syntax, theme);
  let mut spans = Vec::new();
  for line in LinesWithEndings::from(text) {
    for (style, text) in highlighter.highlight_line(line, syntax_set()).ok()? {
      spans.push(CodeSpan {
        text,
        color: [style.foreground.r, style.foreground.g, style.foreground.b],
      });
    }
  }
  Some(spans)
}

/// Render a public code block.
///
/// Highlighting is best-effort: unknown languages and syntect failures fall
/// back to escaped plain text so a single malformed code fence cannot break a
/// public page.
pub fn render_code_html(language: Option<&str>, text: &str, enabled: bool) -> String {
  if !enabled {
    return escaped_plain_code(text);
  }
  let Some(syntax) = find_syntax(language) else {
    return escaped_plain_code(text);
  };
  let theme_set = theme_set();
  let Some(theme) = theme_set
    .themes
    .get("base16-ocean.dark")
    .or_else(|| theme_set.themes.values().next())
  else {
    return escaped_plain_code(text);
  };

  // syntect's `highlighted_html_for_string` intentionally emits a complete
  // `<pre>` snippet. Public rendering owns the outer accessible code-block
  // chrome, so use line-level highlighting and keep only library-generated
  // spans inside our `<code>` element.
  let syntax_set = syntax_set();
  let mut highlighter = HighlightLines::new(syntax, theme);
  let mut html = String::new();
  for line in LinesWithEndings::from(text) {
    let Ok(regions) = highlighter.highlight_line(line, syntax_set) else {
      return escaped_plain_code(text);
    };
    let Ok(line_html) = styled_line_to_highlighted_html(&regions, IncludeBackground::No) else {
      return escaped_plain_code(text);
    };
    html.push_str(&line_html);
  }
  html
}

fn find_syntax(language: Option<&str>) -> Option<&'static SyntaxReference> {
  let language = language.map(str::trim).filter(|value| !value.is_empty())?;
  let syntax_set = syntax_set();
  syntax_set
    .find_syntax_by_token(language)
    .or_else(|| syntax_set.find_syntax_by_extension(language))
}

fn syntax_set() -> &'static SyntaxSet {
  static SYNTAX_SET: OnceLock<SyntaxSet> = OnceLock::new();
  SYNTAX_SET.get_or_init(two_face::syntax::extra_newlines)
}

fn theme_set() -> &'static ThemeSet {
  static THEME_SET: OnceLock<ThemeSet> = OnceLock::new();
  THEME_SET.get_or_init(ThemeSet::load_defaults)
}

fn escaped_plain_code(text: &str) -> String {
  v_htmlescape::escape(text).to_string()
}
