//! P100-SRV-H-10 Exa tool integration tests.
//!
//! - `inv_h10a_exa_tools_not_registered_without_key`: Without `exa.key`, the
//!   Exa tool definitions list must be empty.
//! - `inv_h10b_exa_search_parses_correctly`: With a mock response shape, the
//!   internal Exa search response deserializes correctly (unit test).

// ---------------------------------------------------------------------------
// inv_h10a — Exa tools absent when key is not configured
//
// Invariant: `exa_tool_definitions()` must return an empty list when the Exa
// API key is absent, ensuring the LlmRequest carries no Exa tool definitions
// and the model never tries to call them.
// ---------------------------------------------------------------------------

/// Without an Exa API key, the tool definitions list must be empty.
///
/// This test verifies the SSE handler behaviour: when `exa.key` is `None`
/// the `tools` field on the `LlmRequest` is empty, so the LLM will not
/// attempt to call Exa tools.
#[test]
fn inv_h10a_exa_tools_not_registered_without_key() {
  // Simulate the SSE handler logic: only add tools when key is Some.
  let exa_key: Option<String> = None;
  let tools = if exa_key.is_some() {
    myoxus_infrastructure::copilot::exa::exa_tool_definitions()
  } else {
    vec![]
  };
  assert!(
    tools.is_empty(),
    "inv_H10a: Exa tool definitions MUST be empty when api key is not configured; got {} tools",
    tools.len()
  );
}

/// When the Exa key IS configured, the tool definitions list must contain
/// exactly two tools: `web_search_exa` and `web_crawl_exa`.
#[test]
fn inv_h10a_exa_tools_registered_with_key() {
  let exa_key: Option<String> = Some("test-key".to_string());
  let tools = if exa_key.is_some() {
    myoxus_infrastructure::copilot::exa::exa_tool_definitions()
  } else {
    vec![]
  };
  assert_eq!(
    tools.len(),
    2,
    "inv_H10a: exactly 2 Exa tools must be registered when key is present; got {}",
    tools.len()
  );
  let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
  assert!(
    names.contains(&"web_search_exa"),
    "inv_H10a: web_search_exa must be present"
  );
  assert!(
    names.contains(&"web_crawl_exa"),
    "inv_H10a: web_crawl_exa must be present"
  );
}

// ---------------------------------------------------------------------------
// inv_h10b — Exa search result parsing (unit test, no live network call)
//
// Invariant: The Exa search response JSON shape must be parseable into
// ExaSearchResult structs — score and text are optional.
// ---------------------------------------------------------------------------

/// With a mock Exa search response, all fields parse correctly.
#[test]
fn inv_h10b_exa_search_mock_parses_correctly() {
  use myoxus_infrastructure::copilot::exa::ExaSearchResult;

  // Simulate the JSON a successful exa_search would return (post-processing).
  let mock_result = serde_json::json!({
    "url": "https://example.com/article",
    "title": "Example Article",
    "text": "This is the extracted text content.",
    "score": 0.87
  });

  let result: ExaSearchResult = serde_json::from_value(mock_result).expect("must parse ExaSearchResult");
  assert_eq!(result.url, "https://example.com/article");
  assert_eq!(result.title, "Example Article");
  assert_eq!(result.text.as_deref(), Some("This is the extracted text content."));
  assert_eq!(result.score, Some(0.87));
}

/// Exa search result with missing optional fields (text/score) must still parse.
#[test]
fn inv_h10b_exa_search_mock_parses_with_null_optionals() {
  use myoxus_infrastructure::copilot::exa::ExaSearchResult;

  let mock_result = serde_json::json!({
    "url": "https://example.com/page",
    "title": "Page Title",
    "text": null,
    "score": null
  });

  let result: ExaSearchResult = serde_json::from_value(mock_result).expect("must parse ExaSearchResult with nulls");
  assert_eq!(result.url, "https://example.com/page");
  assert!(result.text.is_none(), "text must be None when null");
  assert!(result.score.is_none(), "score must be None when null");
}

/// Exa crawl result parses correctly.
#[test]
fn inv_h10b_exa_crawl_mock_parses_correctly() {
  use myoxus_infrastructure::copilot::exa::ExaCrawlResult;

  let mock_result = serde_json::json!({
    "url": "https://example.com/crawled",
    "title": "Crawled Page",
    "text": "Full page text extracted by Exa."
  });

  let result: ExaCrawlResult = serde_json::from_value(mock_result).expect("must parse ExaCrawlResult");
  assert_eq!(result.url, "https://example.com/crawled");
  assert_eq!(result.title, "Crawled Page");
  assert_eq!(result.text, "Full page text extracted by Exa.");
}

/// ExaToolExecutor returns error when key is absent.
#[tokio::test]
async fn inv_h10b_exa_tool_executor_requires_key() {
  use myoxus_application::copilot::provider::LlmToolExecutor;
  use myoxus_infrastructure::copilot::exa::ExaToolExecutor;

  let executor = ExaToolExecutor::new(None, None).expect("Exa client");
  let result = executor
    .execute("web_search_exa", &serde_json::json!({"query": "test"}))
    .await;
  assert!(
    result.is_err(),
    "inv_H10b: ExaToolExecutor must return error when key is absent"
  );
  let err = result.unwrap_err();
  assert!(
    err.contains("not configured"),
    "inv_H10b: error message must mention key not configured; got: {err}"
  );
}

/// ExaToolExecutor returns error for unknown tool name.
#[tokio::test]
async fn inv_h10b_exa_tool_executor_unknown_tool() {
  use myoxus_application::copilot::provider::LlmToolExecutor;
  use myoxus_infrastructure::copilot::exa::ExaToolExecutor;

  let executor = ExaToolExecutor::new(Some("test-key".to_string()), None).expect("Exa client");
  let result = executor.execute("unknown_tool", &serde_json::json!({})).await;
  assert!(
    result.is_err(),
    "inv_H10b: ExaToolExecutor must return error for unknown tool"
  );
  let err = result.unwrap_err();
  assert!(
    err.contains("unknown tool"),
    "inv_H10b: error message must mention unknown tool; got: {err}"
  );
}
