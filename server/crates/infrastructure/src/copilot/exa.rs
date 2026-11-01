// SPDX-License-Identifier: AGPL-3.0-or-later
//! Exa web-search and crawl HTTP client (P100-SRV-H-10b).
//!
//! [`ExaToolExecutor`] owns one HTTP client for both search and crawl calls so
//! connection pooling and transport policy survive across tool invocations.

use async_trait::async_trait;
use myoxus_application::copilot::provider::{LlmToolDefinition, LlmToolExecutor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tracing::{debug, instrument, trace, warn};

const EXA_API_ORIGIN: &str = "https://api.exa.ai";

/// A single web-search result returned by the Exa search API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExaSearchResult {
  /// The canonical URL of the result document.
  pub url: String,
  /// Document title as returned by Exa.
  pub title: String,
  /// Cleaned text excerpt, if content retrieval was requested.
  pub text: Option<String>,
  /// Relevance score assigned by the Exa ranking model.
  pub score: Option<f64>,
}

/// Cleaned text content returned by the Exa contents (crawl) API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExaCrawlResult {
  /// The canonical URL that was crawled.
  pub url: String,
  /// Document title.
  pub title: String,
  /// Full cleaned text extracted from the page.
  pub text: String,
}

// ---------------------------------------------------------------------------
// Internal Exa API response shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ExaSearchResponse {
  results: Vec<ExaSearchResultRaw>,
}

#[derive(Debug, Deserialize)]
struct ExaSearchResultRaw {
  url: String,
  title: String,
  text: Option<String>,
  score: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct ExaContentsResponse {
  results: Vec<ExaContentsResultRaw>,
}

#[derive(Debug, Deserialize)]
struct ExaContentsResultRaw {
  url: String,
  title: Option<String>,
  text: Option<String>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Search the web using the Exa API.
///
/// # Arguments
/// * `client` — Executor-owned HTTP client shared across tool calls.
/// * `api_origin` — Exa API origin, replaceable only by local tests.
/// * `api_key` — Exa API key (Bearer token).
/// * `query` — Free-text search query.
/// * `mode` — Search mode: `"auto"`, `"neural"`, or `"keyword"`.
///
/// Returns up to 5 ranked [`ExaSearchResult`] items, or an error if the
/// request failed or the response could not be parsed.
#[instrument(skip(api_key), fields(mode, query_len = query.len()))]
async fn exa_search(
  client: &reqwest::Client,
  api_origin: &str,
  api_key: &str,
  query: &str,
  mode: &str,
) -> Result<Vec<ExaSearchResult>, anyhow::Error> {
  trace!(mode, "exa_search: building request");

  let body = serde_json::json!({
    "query": query,
    "type": mode,
    "numResults": 5,
    "contents": { "text": true },
  });

  debug!(mode, "exa_search: sending request to Exa API");
  let response = client
    .post(format!("{api_origin}/search"))
    .bearer_auth(api_key)
    .json(&body)
    .send()
    .await
    .map_err(|e| anyhow::anyhow!("exa_search: request failed: {e}"))?;

  let status = response.status();
  if !status.is_success() {
    let body_text = response.text().await.unwrap_or_default();
    warn!(status = %status, body = %body_text, "exa_search: non-success HTTP status");
    return Err(anyhow::anyhow!("exa_search: HTTP {status}: {body_text}"));
  }

  let parsed: ExaSearchResponse = response
    .json()
    .await
    .map_err(|e| anyhow::anyhow!("exa_search: failed to parse response: {e}"))?;

  let results = parsed
    .results
    .into_iter()
    .map(|r| ExaSearchResult {
      url: r.url,
      title: r.title,
      text: r.text,
      score: r.score,
    })
    .collect();

  debug!("exa_search: completed successfully");
  Ok(results)
}

/// Crawl a URL using the Exa contents API.
///
/// # Arguments
/// * `client` — Executor-owned HTTP client shared across tool calls.
/// * `api_origin` — Exa API origin, replaceable only by local tests.
/// * `api_key` — Exa API key (Bearer token).
/// * `url` — The URL to crawl.
///
/// Returns an [`ExaCrawlResult`] with the cleaned text extracted from the
/// page, or an error if the request failed.
#[instrument(skip(api_key), fields(url))]
async fn exa_crawl(
  client: &reqwest::Client,
  api_origin: &str,
  api_key: &str,
  url: &str,
) -> Result<ExaCrawlResult, anyhow::Error> {
  trace!("exa_crawl: building request");

  let body = serde_json::json!({
    "ids": [url],
    "text": true,
  });

  debug!("exa_crawl: sending request to Exa API");
  let response = client
    .post(format!("{api_origin}/contents"))
    .bearer_auth(api_key)
    .json(&body)
    .send()
    .await
    .map_err(|e| anyhow::anyhow!("exa_crawl: request failed: {e}"))?;

  let status = response.status();
  if !status.is_success() {
    let body_text = response.text().await.unwrap_or_default();
    warn!(status = %status, body = %body_text, "exa_crawl: non-success HTTP status");
    return Err(anyhow::anyhow!("exa_crawl: HTTP {status}: {body_text}"));
  }

  let parsed: ExaContentsResponse = response
    .json()
    .await
    .map_err(|e| anyhow::anyhow!("exa_crawl: failed to parse response: {e}"))?;

  let first = parsed
    .results
    .into_iter()
    .next()
    .ok_or_else(|| anyhow::anyhow!("exa_crawl: no results returned for URL: {url}"))?;

  debug!("exa_crawl: completed successfully");
  Ok(ExaCrawlResult {
    url: first.url,
    title: first.title.unwrap_or_default(),
    text: first.text.unwrap_or_default(),
  })
}

// ---------------------------------------------------------------------------
// Tool definitions and executor
// ---------------------------------------------------------------------------

/// Return the [`LlmToolDefinition`] list for the Exa tools.
///
/// Call this when building an `LlmRequest` to tell the model which Exa tools
/// are available.  The definitions are only added when an Exa API key is
/// configured; callers should check `exa_key.is_some()` before calling.
pub fn exa_tool_definitions() -> Vec<LlmToolDefinition> {
  vec![
    LlmToolDefinition {
      name: "web_search_exa".to_string(),
      description: Some(
        "Search the web using the Exa AI-native search engine. Returns relevant web pages \
         with titles, URLs, and text snippets."
          .to_string(),
      ),
      input_schema: serde_json::json!({
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "The search query."
          },
          "mode": {
            "type": "string",
            "enum": ["auto", "neural", "keyword"],
            "description": "Search mode. Use 'auto' unless you have a specific reason to prefer neural or keyword.",
            "default": "auto"
          }
        },
        "required": ["query"]
      }),
    },
    LlmToolDefinition {
      name: "web_crawl_exa".to_string(),
      description: Some("Fetch and extract the full text content of a web page using the Exa crawl API.".to_string()),
      input_schema: serde_json::json!({
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "The URL of the page to crawl."
          }
        },
        "required": ["url"]
      }),
    },
  ]
}

/// Server-side executor for Exa tools.
///
/// Implements [`LlmToolExecutor`] for the `web_search_exa` and `web_crawl_exa`
/// tools.  When the Exa key is absent both tools return an error message so
/// the model can inform the user.
pub struct ExaToolExecutor {
  /// Exa API key. `None` means the tools are disabled.
  api_key: Option<String>,
  client: reqwest::Client,
  api_origin: String,
}

impl ExaToolExecutor {
  /// Build an executor whose search and crawl calls share one HTTP client.
  pub fn new(api_key: Option<String>, additional_ca: Option<&crate::tls::ValidatedCaBundle>) -> Result<Self, String> {
    Ok(Self {
      api_key,
      client: crate::tls::build_http_client(reqwest::Client::builder(), additional_ca)?,
      api_origin: EXA_API_ORIGIN.to_string(),
    })
  }

  #[cfg(test)]
  fn with_client(api_key: Option<String>, client: reqwest::Client, api_origin: String) -> Self {
    Self {
      api_key,
      client,
      api_origin,
    }
  }
}

#[async_trait]
impl LlmToolExecutor for ExaToolExecutor {
  async fn execute(&self, tool_name: &str, arguments: &Value) -> Result<Value, String> {
    let key = self
      .api_key
      .as_deref()
      .ok_or_else(|| "Exa API key is not configured on this server".to_string())?;

    match tool_name {
      "web_search_exa" => {
        let query = arguments
          .get("query")
          .and_then(|v| v.as_str())
          .ok_or_else(|| "web_search_exa: missing required argument 'query'".to_string())?;
        let mode = arguments.get("mode").and_then(|v| v.as_str()).unwrap_or("auto");

        match exa_search(&self.client, &self.api_origin, key, query, mode).await {
          Ok(results) => {
            let json_results: Vec<Value> = results
              .into_iter()
              .map(|r| {
                serde_json::json!({
                  "url": r.url,
                  "title": r.title,
                  "text": r.text,
                  "score": r.score,
                })
              })
              .collect();
            Ok(serde_json::json!({ "results": json_results }))
          }
          Err(e) => Err(format!("web_search_exa failed: {e}")),
        }
      }
      "web_crawl_exa" => {
        let url = arguments
          .get("url")
          .and_then(|v| v.as_str())
          .ok_or_else(|| "web_crawl_exa: missing required argument 'url'".to_string())?;

        match exa_crawl(&self.client, &self.api_origin, key, url).await {
          Ok(result) => Ok(serde_json::json!({
            "url": result.url,
            "title": result.title,
            "text": result.text,
          })),
          Err(e) => Err(format!("web_crawl_exa failed: {e}")),
        }
      }
      other => Err(format!("ExaToolExecutor: unknown tool '{other}'")),
    }
  }
}

// ---------------------------------------------------------------------------
// Unit tests (parse shape only — no live network calls)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_application::copilot::provider::LlmToolExecutor;
  use reqwest::header::{HeaderMap, HeaderValue};
  use std::io::{Read, Write};
  use std::net::TcpListener;
  use std::thread;

  /// Verify that [`ExaSearchResult`] round-trips through JSON correctly.
  #[test]
  fn exa_search_result_json_roundtrip() {
    let result = ExaSearchResult {
      url: "https://example.com".to_string(),
      title: "Example".to_string(),
      text: Some("Some text".to_string()),
      score: Some(0.95),
    };
    let json = serde_json::to_string(&result).expect("serialize");
    let decoded: ExaSearchResult = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(decoded.url, result.url);
    assert_eq!(decoded.title, result.title);
    assert_eq!(decoded.score, result.score);
  }

  /// Verify that [`ExaCrawlResult`] round-trips through JSON correctly.
  #[test]
  fn exa_crawl_result_json_roundtrip() {
    let result = ExaCrawlResult {
      url: "https://example.com".to_string(),
      title: "Example Page".to_string(),
      text: "Body text here.".to_string(),
    };
    let json = serde_json::to_string(&result).expect("serialize");
    let decoded: ExaCrawlResult = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(decoded.url, result.url);
    assert_eq!(decoded.text, result.text);
  }

  /// Verify that the internal search response shape deserializes correctly.
  #[test]
  fn exa_search_response_deserializes() {
    let raw = r#"{
      "results": [
        {"url": "https://a.com", "title": "A", "text": "content", "score": 0.9},
        {"url": "https://b.com", "title": "B", "text": null, "score": null}
      ]
    }"#;
    let parsed: ExaSearchResponse = serde_json::from_str(raw).expect("deserialize");
    assert_eq!(parsed.results.len(), 2);
    assert_eq!(parsed.results[0].score, Some(0.9));
    assert!(parsed.results[1].score.is_none());
  }

  /// Verify that the internal contents response shape deserializes correctly.
  #[test]
  fn exa_contents_response_deserializes() {
    let raw = r#"{
      "results": [
        {"url": "https://a.com", "title": "A", "text": "page text"}
      ]
    }"#;
    let parsed: ExaContentsResponse = serde_json::from_str(raw).expect("deserialize");
    assert_eq!(parsed.results.len(), 1);
    assert_eq!(parsed.results[0].text.as_deref(), Some("page text"));
  }

  #[tokio::test]
  async fn search_and_crawl_use_the_executor_http_client() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind Exa stub");
    let origin = format!("http://{}", listener.local_addr().expect("Exa stub address"));
    let server = thread::spawn(move || {
      let mut requests = Vec::new();
      for _ in 0..2 {
        let (mut stream, _) = listener.accept().expect("accept Exa request");
        let mut bytes = [0_u8; 8192];
        let length = stream.read(&mut bytes).expect("read Exa request");
        let request = String::from_utf8_lossy(&bytes[..length]).to_string();
        let body = if request.starts_with("POST /search ") {
          r#"{"results":[{"url":"https://example.test/search","title":"Search","text":"result","score":0.9}]}"#
        } else if request.starts_with("POST /contents ") {
          r#"{"results":[{"url":"https://example.test/crawl","title":"Crawl","text":"page"}]}"#
        } else {
          panic!("unexpected Exa stub request: {request}");
        };
        write!(
          stream,
          "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
          body.len(),
          body
        )
        .expect("write Exa response");
        requests.push(request);
      }
      requests
    });

    let mut headers = HeaderMap::new();
    headers.insert(
      "x-myoxus-client-instance",
      HeaderValue::from_static("shared-exa-client"),
    );
    let client = reqwest::Client::builder()
      .default_headers(headers)
      .build()
      .expect("build test HTTP client");
    let executor = ExaToolExecutor::with_client(Some("test-key".to_string()), client, origin);

    let search = executor
      .execute("web_search_exa", &serde_json::json!({"query": "Myoxus"}))
      .await
      .expect("execute Exa search");
    let crawl = executor
      .execute(
        "web_crawl_exa",
        &serde_json::json!({"url": "https://example.test/crawl"}),
      )
      .await
      .expect("execute Exa crawl");
    assert_eq!(search["results"][0]["title"], "Search");
    assert_eq!(crawl["title"], "Crawl");

    let requests = server.join().expect("join Exa stub");
    assert_eq!(requests.len(), 2);
    for request in requests {
      assert!(
        request
          .to_ascii_lowercase()
          .contains("x-myoxus-client-instance: shared-exa-client"),
        "Exa request did not use the executor-owned HTTP client: {request}"
      );
    }
  }
}
