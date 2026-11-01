// SPDX-License-Identifier: AGPL-3.0-or-later
use serde::Serialize;
use tera::Context;

use crate::HtmlRenderer;

/// Metadata only: authorization and indexability remain the handler's decision.
#[derive(Serialize)]
pub struct WorkspacePageContext<'a> {
  pub title: Option<&'a str>,
  pub summary: Option<&'a str>,
  pub avatar: Option<&'a str>,
  pub indexable: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RsvpPageState {
  Success,
  InvalidLink,
  InvalidStatus,
  Unavailable,
  UpdateFailure,
}

/// Credential-free display values. Token validation and participant writes must
/// finish in the handler; neither tokens nor storage errors belong in this view.
#[derive(Serialize)]
pub struct RsvpPageContext<'a> {
  pub state: RsvpPageState,
  pub status: Option<&'a str>,
  pub event_title: Option<&'a str>,
  pub failure: Option<&'a str>,
}

pub fn render_workspace_page(renderer: &HtmlRenderer, context: &WorkspacePageContext<'_>) -> Result<String, String> {
  let context = Context::from_serialize(context).map_err(|err| err.to_string())?;
  renderer.render("workspace_page.html.tera", &context)
}

pub fn render_rsvp_page(renderer: &HtmlRenderer, context: &RsvpPageContext<'_>) -> Result<String, String> {
  let mut context = Context::from_serialize(context).map_err(|err| err.to_string())?;
  // Only the catalog stylesheet is trusted markup; all display values autoescape.
  context.insert("public_css", renderer.public_css());
  renderer.render("rsvp_page.html.tera", &context)
}

pub(crate) fn validate_catalog(renderer: &HtmlRenderer) -> Result<(), String> {
  for indexable in [false, true] {
    for populated in [false, true] {
      render_workspace_page(
        renderer,
        &WorkspacePageContext {
          title: populated.then_some("<Workspace & title>"),
          summary: populated.then_some("<Summary & description>"),
          avatar: populated.then_some("/avatar?a=1&b=2"),
          indexable,
        },
      )?;
    }
  }
  for state in [
    RsvpPageState::Success,
    RsvpPageState::InvalidLink,
    RsvpPageState::InvalidStatus,
    RsvpPageState::Unavailable,
    RsvpPageState::UpdateFailure,
  ] {
    for status in [
      None,
      Some("accepted"),
      Some("declined"),
      Some("tentative"),
      Some("needs_action"),
    ] {
      for populated in [false, true] {
        render_rsvp_page(
          renderer,
          &RsvpPageContext {
            state,
            status,
            event_title: populated.then_some("<Event & title>"),
            failure: populated.then_some("<Failure & detail>"),
          },
        )?;
      }
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn response_pages_escape_display_values_and_keep_noindex_policy() {
    let renderer = crate::catalog::test_renderer();
    for indexable in [false, true] {
      let html = render_workspace_page(
        renderer,
        &WorkspacePageContext {
          title: Some("<script>&title"),
          summary: Some("\"&summary"),
          avatar: Some("/avatar?a=1&b=2"),
          indexable,
        },
      )
      .unwrap();
      assert!(html.contains("&lt;script&gt;&amp;title"));
      assert!(!html.contains("&amp;lt;"));
      assert_eq!(html.contains("content=\"noindex\""), !indexable);
      assert!(html.contains("avatar?a=1&amp;b=2"));
    }
    for state in [
      RsvpPageState::Success,
      RsvpPageState::InvalidLink,
      RsvpPageState::InvalidStatus,
      RsvpPageState::Unavailable,
      RsvpPageState::UpdateFailure,
    ] {
      let html = render_rsvp_page(
        renderer,
        &RsvpPageContext {
          state,
          status: Some("<status>"),
          event_title: Some("<event>"),
          failure: Some("<failure>"),
        },
      )
      .unwrap();
      assert!(html.starts_with("<!doctype html>"));
      assert!(html.contains("noindex,nofollow"));
      assert!(html.contains("/api/branding/theme.css"));
      assert!(!html.contains("<status>") && !html.contains("<event>") && !html.contains("<failure>"));
      assert!(!html.contains("&amp;lt;"));
    }
  }
}
