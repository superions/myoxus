// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded Authentik/Keycloak group reads. No persistence or login side effects.

use std::{
  collections::{HashMap, HashSet, VecDeque},
  time::Duration,
};

use async_trait::async_trait;
use myoxus_application::organization::oidc_directory::{
  MAX_DIRECTORY_GROUPS, OidcDirectoryError, OidcDirectoryGroup, OidcGroupDirectoryCatalog, OidcGroupDirectoryPort,
  project_directory,
};
use myoxus_contracts::oauth_config::{
  OAuthDirectoryClaimValueMode, OAuthGroupDirectoryConfig, parse_safe_oidc_config_url,
};
use reqwest::{Client, RequestBuilder, Url};
use serde::{Deserialize, de::DeserializeOwned};

use crate::tls::ValidatedCaBundle;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_TOTAL_BYTES: usize = 8 * MAX_RESPONSE_BYTES;
const MAX_PAGES: usize = 100;
const PAGE_SIZE: usize = 100;

pub struct HttpOidcGroupDirectory {
  client: Client,
}

impl HttpOidcGroupDirectory {
  /// Reuse the immutable global CA snapshot. Requests are on demand and never
  /// follow redirects, even to the same host, so credentials cannot escape.
  pub fn new(additional_ca: Option<&ValidatedCaBundle>) -> Result<Self, OidcDirectoryError> {
    let client = crate::tls::build_http_client(
      Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none()),
      additional_ca,
    )
    .map_err(|_| OidcDirectoryError::InvalidConfiguration)?;
    Ok(Self { client })
  }

  async fn authentik(&self, base_url: &str, token: &str) -> Result<OidcGroupDirectoryCatalog, OidcDirectoryError> {
    let mut base = parse_safe_oidc_config_url(base_url).map_err(|_| OidcDirectoryError::InvalidConfiguration)?;
    base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
    let endpoint = base
      .join("api/v3/core/groups/")
      .map_err(|_| OidcDirectoryError::InvalidConfiguration)?;
    let mut page = 1usize;
    let mut visited = HashSet::new();
    let mut expected_inventory = None;
    let mut total_bytes = 0usize;
    let mut groups = Vec::new();
    loop {
      if visited.len() >= MAX_PAGES {
        return Err(OidcDirectoryError::LimitExceeded);
      }
      if !visited.insert(page) {
        return Err(OidcDirectoryError::InvalidResponse);
      }
      // Authentik's next cursor is a page number, not a provider-controlled URL.
      // Construct every request from the validated endpoint, preserving its base path.
      let mut url = endpoint.clone();
      url
        .query_pairs_mut()
        .append_pair("page", &page.to_string())
        .append_pair("page_size", &PAGE_SIZE.to_string())
        .append_pair("include_users", "false")
        .append_pair("include_children", "false")
        .append_pair("include_parents", "false");
      let remaining = MAX_TOTAL_BYTES.saturating_sub(total_bytes).min(MAX_RESPONSE_BYTES);
      if remaining == 0 {
        return Err(OidcDirectoryError::LimitExceeded);
      }
      let (response, bytes) = tokio::time::timeout(REQUEST_TIMEOUT, self.authentik_page(url, token, remaining))
        .await
        .map_err(|_| OidcDirectoryError::Timeout)??;
      total_bytes += bytes;
      if total_bytes > MAX_TOTAL_BYTES {
        return Err(OidcDirectoryError::LimitExceeded);
      }
      let pagination = response.pagination;
      if pagination.count > MAX_DIRECTORY_GROUPS || pagination.total_pages > MAX_PAGES {
        return Err(OidcDirectoryError::LimitExceeded);
      }
      if pagination.current != page || pagination.total_pages == 0 || page > pagination.total_pages {
        return Err(OidcDirectoryError::InvalidResponse);
      }
      let inventory = (pagination.count, pagination.total_pages);
      if expected_inventory.is_some_and(|expected| expected != inventory) {
        return Err(OidcDirectoryError::InvalidResponse);
      }
      expected_inventory = Some(inventory);
      if groups.len().saturating_add(response.results.len()) > MAX_DIRECTORY_GROUPS {
        return Err(OidcDirectoryError::LimitExceeded);
      }
      groups.extend(response.results.into_iter().map(|group| OidcDirectoryGroup {
        id: group.pk.to_string(),
        display_name: group.name.clone(),
        path: None,
        claim_value: group.name,
      }));
      if page == pagination.total_pages {
        if pagination.next != 0 {
          return Err(OidcDirectoryError::InvalidResponse);
        }
        let catalog = project_directory(groups)?;
        if catalog.entries.len() != pagination.count {
          return Err(OidcDirectoryError::InvalidResponse);
        }
        tracing::debug!(
          pages = visited.len(),
          groups = catalog.entries.len(),
          "Authentik visible group catalog retrieved"
        );
        return Ok(catalog);
      }
      if pagination.next != page + 1 {
        return Err(OidcDirectoryError::InvalidResponse);
      }
      page = pagination.next;
    }
  }

  async fn authentik_page(
    &self,
    url: Url,
    token: &str,
    byte_limit: usize,
  ) -> Result<(AuthentikPage, usize), OidcDirectoryError> {
    read_json(self.client.get(url).bearer_auth(token), byte_limit).await
  }

  async fn keycloak(
    &self,
    base_url: &str,
    realm: &str,
    client_id: &str,
    client_secret: &str,
    mode: OAuthDirectoryClaimValueMode,
  ) -> Result<OidcGroupDirectoryCatalog, OidcDirectoryError> {
    let base = parse_safe_oidc_config_url(base_url).map_err(|_| OidcDirectoryError::InvalidConfiguration)?;
    let token_url = keycloak_url(&base, &["realms", realm, "protocol", "openid-connect", "token"])?;
    let mut budget = KeycloakBudget::default();
    // This token lives only for this retrieval. Redirects, error bodies and
    // request errors never expose it or the client secret; no refresh/cache path.
    let token: KeycloakToken = budget
      .read(self.client.post(token_url).form(&[
        ("grant_type", "client_credentials"),
        ("client_id", client_id),
        ("client_secret", client_secret),
      ]))
      .await?;
    if !token.token_type.eq_ignore_ascii_case("bearer")
      || token.access_token.trim().is_empty()
      || token.access_token.chars().any(char::is_whitespace)
      || token.access_token.chars().any(char::is_control)
      || token.expires_in == 0
    {
      return Err(OidcDirectoryError::InvalidResponse);
    }
    let groups_url = keycloak_url(&base, &["admin", "realms", realm, "groups"])?;
    let mut count_url = keycloak_url(&base, &["admin", "realms", realm, "groups", "count"])?;
    count_url.query_pairs_mut().append_pair("top", "true");
    let count: KeycloakCount = budget
      .read(self.client.get(count_url).bearer_auth(&token.access_token))
      .await?;
    if count.count > MAX_DIRECTORY_GROUPS {
      return Err(OidcDirectoryError::LimitExceeded);
    }
    // Root paging precedes permission filtering in Keycloak. Count bounds every
    // window even if a visible page is short/empty. Children filter first, but
    // their reported count also lets us reject a silently incomplete read.
    let mut pending = VecDeque::from([(groups_url, Some(count.count), None::<String>)]);
    let mut unique = HashMap::<String, KeycloakGroup>::new();
    let mut parents = HashMap::<String, Option<String>>::new();
    let mut records = 0usize;
    while let Some((endpoint, expected, parent)) = pending.pop_front() {
      if expected == Some(0) {
        continue;
      }
      let mut first = 0usize;
      let mut siblings = HashSet::new();
      loop {
        if budget.pages >= MAX_PAGES {
          return Err(OidcDirectoryError::LimitExceeded);
        }
        budget.pages += 1;
        let mut url = endpoint.clone();
        url
          .query_pairs_mut()
          .append_pair("first", &first.to_string())
          .append_pair("max", &PAGE_SIZE.to_string())
          .append_pair("briefRepresentation", "true")
          .append_pair("populateHierarchy", "false")
          .append_pair("subGroupsCount", "true");
        let page: Vec<KeycloakGroup> = budget
          .read(self.client.get(url).bearer_auth(&token.access_token))
          .await?;
        let length = page.len();
        records += length;
        if records > MAX_DIRECTORY_GROUPS {
          return Err(OidcDirectoryError::LimitExceeded);
        }
        if length > PAGE_SIZE {
          return Err(OidcDirectoryError::InvalidResponse);
        }
        for group in page {
          if group.id.trim().is_empty()
            || matches!(group.id.as_str(), "." | "..")
            || group.id.chars().any(char::is_control)
            || !group.path.starts_with('/')
            || group.parent_id.as_ref().is_some_and(|id| Some(id) != parent.as_ref())
          {
            return Err(OidcDirectoryError::InvalidResponse);
          }
          siblings.insert(group.id.clone());
          if let Some(previous) = unique.get(&group.id) {
            if previous != &group || parents.get(&group.id) != Some(&parent) {
              return Err(OidcDirectoryError::InvalidResponse);
            }
            continue;
          }
          if group.sub_group_count.is_some_and(|count| count > MAX_DIRECTORY_GROUPS) {
            return Err(OidcDirectoryError::LimitExceeded);
          }
          if group.sub_group_count != Some(0) {
            let children = keycloak_url(&base, &["admin", "realms", realm, "groups", &group.id, "children"])?;
            pending.push_back((children, group.sub_group_count, Some(group.id.clone())));
          }
          parents.insert(group.id.clone(), parent.clone());
          unique.insert(group.id.clone(), group);
        }
        first += PAGE_SIZE;
        if expected.is_some_and(|count| first >= count) || expected.is_none() && length < PAGE_SIZE {
          break;
        }
      }
      if expected.is_some_and(|count| siblings.len() != count) {
        return Err(OidcDirectoryError::InvalidResponse);
      }
    }
    let catalog = project_directory(
      unique
        .into_values()
        .map(|group| OidcDirectoryGroup {
          id: group.id,
          display_name: group.name.clone(),
          claim_value: match mode {
            OAuthDirectoryClaimValueMode::Name => group.name,
            OAuthDirectoryClaimValueMode::Path => group.path.clone(),
          },
          path: Some(group.path),
        })
        .collect(),
    )?;
    tracing::debug!(
      pages = budget.pages,
      groups = catalog.entries.len(),
      "Keycloak group catalog retrieved"
    );
    Ok(catalog)
  }
}

/// Push encoded realm/group segments rather than interpolating URL paths.
fn keycloak_url(base: &Url, segments: &[&str]) -> Result<Url, OidcDirectoryError> {
  let mut url = base.clone();
  url
    .path_segments_mut()
    .map_err(|_| OidcDirectoryError::InvalidConfiguration)?
    .pop_if_empty()
    .extend(segments.iter().copied());
  Ok(url)
}

#[derive(Default)]
struct KeycloakBudget {
  bytes: usize,
  pages: usize,
}

impl KeycloakBudget {
  async fn read<T: DeserializeOwned>(&mut self, request: RequestBuilder) -> Result<T, OidcDirectoryError> {
    let remaining = MAX_TOTAL_BYTES.saturating_sub(self.bytes).min(MAX_RESPONSE_BYTES);
    if remaining == 0 {
      return Err(OidcDirectoryError::LimitExceeded);
    }
    let (value, bytes) = tokio::time::timeout(REQUEST_TIMEOUT, read_json(request, remaining))
      .await
      .map_err(|_| OidcDirectoryError::Timeout)??;
    self.bytes += bytes;
    Ok(value)
  }
}

async fn read_json<T: DeserializeOwned>(
  request: RequestBuilder,
  byte_limit: usize,
) -> Result<(T, usize), OidcDirectoryError> {
  let mut response = request.send().await.map_err(transport_error)?;
  let status = response.status();
  if matches!(status.as_u16(), 401 | 403) {
    return Err(OidcDirectoryError::AccessDenied(status.as_u16()));
  }
  if status.is_redirection() {
    return Err(OidcDirectoryError::RedirectRejected);
  }
  if status != reqwest::StatusCode::OK {
    return Err(OidcDirectoryError::HttpStatus(status.as_u16()));
  }
  if response
    .content_length()
    .is_some_and(|length| length > byte_limit as u64)
  {
    return Err(OidcDirectoryError::LimitExceeded);
  }
  let mut body = Vec::new();
  while let Some(chunk) = response.chunk().await.map_err(transport_error)? {
    if chunk.len() > byte_limit.saturating_sub(body.len()) {
      return Err(OidcDirectoryError::LimitExceeded);
    }
    body.extend_from_slice(&chunk);
  }
  let page = serde_json::from_slice(&body).map_err(|_| OidcDirectoryError::InvalidResponse)?;
  Ok((page, body.len()))
}

#[async_trait]
impl OidcGroupDirectoryPort for HttpOidcGroupDirectory {
  #[tracing::instrument(skip_all, err)]
  async fn retrieve(
    &self,
    connection: &OAuthGroupDirectoryConfig,
  ) -> Result<OidcGroupDirectoryCatalog, OidcDirectoryError> {
    connection
      .validate()
      .map_err(|_| OidcDirectoryError::InvalidConfiguration)?;
    tokio::time::timeout(TOTAL_TIMEOUT, async {
      match connection {
        OAuthGroupDirectoryConfig::Authentik { base_url, token } => self.authentik(base_url, token).await,
        OAuthGroupDirectoryConfig::Keycloak {
          base_url,
          realm,
          client_id,
          client_secret,
          claim_value_mode,
        } => {
          self
            .keycloak(base_url, realm, client_id, client_secret, *claim_value_mode)
            .await
        }
      }
    })
    .await
    .map_err(|_| OidcDirectoryError::Timeout)?
  }
}

fn transport_error(error: reqwest::Error) -> OidcDirectoryError {
  if error.is_timeout() {
    OidcDirectoryError::Timeout
  } else {
    OidcDirectoryError::Transport(crate::tls::http_error::reason(&error))
  }
}

#[derive(Deserialize)]
struct AuthentikPage {
  pagination: AuthentikPagination,
  results: Vec<AuthentikGroup>,
}

#[derive(Deserialize)]
struct AuthentikPagination {
  next: usize,
  current: usize,
  count: usize,
  total_pages: usize,
}

#[derive(Deserialize)]
struct AuthentikGroup {
  pk: uuid::Uuid,
  name: String,
}

#[derive(Deserialize)]
struct KeycloakToken {
  access_token: String,
  token_type: String,
  expires_in: u64,
}

#[derive(Deserialize)]
struct KeycloakCount {
  count: usize,
}

/// Embedded subGroups and membership/attribute fields are deliberately ignored.
#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct KeycloakGroup {
  id: String,
  name: String,
  path: String,
  parent_id: Option<String>,
  sub_group_count: Option<usize>,
}

#[cfg(test)]
mod tests {
  use std::sync::Arc;

  use myoxus_application::organization::oidc_directory::OidcDirectoryEntryState;
  use serde_json::{Value, json};
  use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
    task::JoinHandle,
  };

  use super::*;

  struct Fixture {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    task: JoinHandle<()>,
  }

  impl Drop for Fixture {
    fn drop(&mut self) {
      self.task.abort();
    }
  }

  impl Fixture {
    async fn new(responses: Vec<String>) -> Self {
      Self::with_kind(responses, false).await
    }

    async fn with_kind(responses: Vec<String>, keycloak: bool) -> Self {
      let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
      let base = format!("http://{}/provider-prefix", listener.local_addr().unwrap());
      let requests = Arc::new(Mutex::new(Vec::new()));
      let received = requests.clone();
      let task = tokio::spawn(async move {
        for response in responses {
          let (mut stream, _) = listener.accept().await.unwrap();
          let mut request = Vec::new();
          while !request.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).await.unwrap();
            request.extend_from_slice(&byte);
            assert!(request.len() <= 8192, "unexpected oversized fixture request");
          }
          let request = std::str::from_utf8(&request).unwrap();
          let target = request
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_string();
          if keycloak && request.starts_with("POST ") {
            assert_eq!(
              target,
              "/provider-prefix/realms/team%2Frealm%20%3F/protocol/openid-connect/token"
            );
            assert!(!request.to_ascii_lowercase().contains("authorization:"));
            let length: usize = request
              .lines()
              .find_map(|line| {
                line
                  .to_ascii_lowercase()
                  .strip_prefix("content-length:")
                  .map(|value| value.trim().parse().unwrap())
              })
              .unwrap();
            let mut body = vec![0; length];
            stream.read_exact(&mut body).await.unwrap();
            assert_eq!(
              std::str::from_utf8(&body).unwrap(),
              "grant_type=client_credentials&client_id=directory-client&client_secret=directory-secret%26%3D"
            );
          } else {
            assert!(
              request
                .lines()
                .any(|line| line.eq_ignore_ascii_case("authorization: Bearer directory-test-token"))
            );
            if keycloak {
              assert!(target.starts_with("/provider-prefix/admin/realms/team%2Frealm%20%3F/groups"));
            } else {
              assert!(target.starts_with("/provider-prefix/api/v3/core/groups/?"));
              assert!(target.contains("include_users=false"));
            }
          }
          received.lock().await.push(target);
          stream.write_all(response.as_bytes()).await.unwrap();
        }
      });
      Self { base, requests, task }
    }

    fn connection(&self) -> OAuthGroupDirectoryConfig {
      OAuthGroupDirectoryConfig::Authentik {
        base_url: self.base.clone(),
        token: "directory-test-token".into(),
      }
    }

    fn keycloak_connection(&self, mode: OAuthDirectoryClaimValueMode) -> OAuthGroupDirectoryConfig {
      OAuthGroupDirectoryConfig::Keycloak {
        base_url: self.base.clone(),
        realm: "team/realm ?".into(),
        client_id: "directory-client".into(),
        client_secret: "directory-secret&=".into(),
        claim_value_mode: mode,
      }
    }
  }

  fn response(status: u16, body: Value) -> String {
    let body = body.to_string();
    format!(
      "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
      body.len()
    )
  }

  fn group(id: u128, name: &str) -> Value {
    json!({"pk":uuid::Uuid::from_u128(id), "name":name, "users_obj":[{"email":"must-not-retain"}], "attributes":{"private":"must-not-retain"}})
  }

  fn page(current: usize, next: usize, total_pages: usize, count: usize, results: Vec<Value>) -> String {
    response(
      200,
      json!({"pagination":{"current":current,"next":next,"total_pages":total_pages,"count":count},"results":results}),
    )
  }

  #[tokio::test]
  async fn authentik_reads_all_visible_pages_with_prefix_and_projects_only_group_choices() {
    let fixture = Fixture::new(vec![
      page(
        1,
        2,
        2,
        3,
        vec![group(1, "/Engineering//Core/"), group(2, "Engineering/Core")],
      ),
      page(
        2,
        0,
        2,
        3,
        vec![group(1, "/Engineering//Core/"), group(3, "OutsideCurrentPerson")],
      ),
    ])
    .await;
    let catalog = HttpOidcGroupDirectory::new(None)
      .unwrap()
      .retrieve(&fixture.connection())
      .await
      .unwrap();
    assert_eq!(catalog.entries.len(), 3);
    assert_eq!(
      catalog
        .entries
        .iter()
        .filter(|entry| entry.state == OidcDirectoryEntryState::Ambiguous)
        .count(),
      2
    );
    assert!(
      catalog
        .entries
        .iter()
        .any(|entry| entry.claim_value.as_deref() == Some("OutsideCurrentPerson"))
    );
    assert!(!format!("{catalog:?}").contains("must-not-retain"));
    let requests = fixture.requests.lock().await;
    assert_eq!(requests.len(), 2);
    assert!(requests[0].contains("page=1&") && requests[1].contains("page=2&"));
  }

  #[tokio::test]
  async fn authentik_failures_limits_and_looping_pages_never_return_partial_catalogs() {
    let first = || page(1, 2, 2, 2, vec![group(1, "Visible")]);
    let oversized = "x".repeat(MAX_RESPONSE_BYTES + 1);
    let chunked = format!(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{oversized}\r\n0\r\n\r\n",
      oversized.len()
    );
    for (responses, expected) in [
      (vec![first(), response(403, json!({"detail":"private-response-marker"}))], OidcDirectoryError::AccessDenied(403)),
      (vec![response(401, json!({"detail":"private-response-marker"}))], OidcDirectoryError::AccessDenied(401)),
      (vec![page(1, 1, 2, 2, vec![group(1, "Visible")])], OidcDirectoryError::InvalidResponse),
      (vec![page(1, 0, 1, 2, vec![group(1, "Visible")])], OidcDirectoryError::InvalidResponse),
      (vec![page(1, 0, 1, MAX_DIRECTORY_GROUPS + 1, vec![])], OidcDirectoryError::LimitExceeded),
      (vec![format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_RESPONSE_BYTES + 1)], OidcDirectoryError::LimitExceeded),
      (vec![chunked], OidcDirectoryError::LimitExceeded),
      (vec!["HTTP/1.1 302 Found\r\nLocation: http://private-marker:password@foreign.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()], OidcDirectoryError::RedirectRejected),
      (vec![response(200, json!({"pagination":{"current":1,"next":"https://private-marker@foreign.invalid/","count":1,"total_pages":2},"results":[]}))], OidcDirectoryError::InvalidResponse),
    ] {
      let fixture = Fixture::new(responses).await;
      let error = HttpOidcGroupDirectory::new(None).unwrap().retrieve(&fixture.connection()).await.unwrap_err();
      assert_eq!(error, expected);
      assert!(!error.to_string().contains("private-marker") && !error.to_string().contains("private-response-marker"));
    }
  }

  fn keycloak_token() -> String {
    response(
      200,
      json!({"access_token":"directory-test-token", "token_type":"Bearer", "expires_in":60}),
    )
  }

  fn kc_group(id: &str, name: &str, path: &str, children: usize) -> Value {
    json!({"id":id, "name":name, "path":path, "subGroupCount":children})
  }

  #[tokio::test]
  async fn keycloak_pages_roots_and_children_and_matches_explicit_mapper_values() {
    for mode in [OAuthDirectoryClaimValueMode::Name, OAuthDirectoryClaimValueMode::Path] {
      let mut roots = vec![kc_group("parent/one?", "BranchA", "/BranchA", 101)];
      roots.extend((1..100).map(|index| {
        kc_group(
          &format!("root{index}"),
          &format!("Root{index}"),
          &format!("/Root{index}"),
          0,
        )
      }));
      let mut children = vec![kc_group("core-a", "Core", "/BranchA/Core", 1)];
      // Embedded children are not the children endpoint's inventory.
      children[0]["subGroups"] = json!([kc_group("fabricated", "Wrong", "/Wrong", 0)]);
      children.extend((1..100).map(|index| {
        kc_group(
          &format!("child{index}"),
          &format!("Child{index}"),
          &format!("/BranchA/Child{index}"),
          0,
        )
      }));
      let fixture = Fixture::with_kind(
        vec![
          keycloak_token(),
          response(200, json!({"count":101})),
          response(200, json!(roots)),
          response(200, json!([kc_group("branch-b", "BranchB", "/BranchB", 1)])),
          response(200, json!(children)),
          response(
            200,
            json!([
              kc_group("last-child", "Last", "/BranchA/Last", 0),
              kc_group("core-a", "Core", "/BranchA/Core", 1)
            ]),
          ),
          response(200, json!([kc_group("core-b", "Core", "/BranchB/Core", 0)])),
          response(200, json!([kc_group("deep", "Deep", "/BranchA/Core/Deep", 0)])),
        ],
        true,
      )
      .await;
      let catalog = HttpOidcGroupDirectory::new(None)
        .unwrap()
        .retrieve(&fixture.keycloak_connection(mode))
        .await
        .unwrap();
      assert_eq!(catalog.entries.len(), 204);
      assert!(!catalog.entries.iter().any(|entry| entry.id == "fabricated"));
      let entry = catalog.entries.iter().find(|entry| entry.id == "core-a").unwrap();
      assert_eq!(entry.path.as_deref(), Some("/BranchA/Core"));
      assert_eq!(
        entry.claim_value.as_deref(),
        Some(if mode == OAuthDirectoryClaimValueMode::Name {
          "Core"
        } else {
          "BranchA/Core"
        })
      );
      assert_eq!(
        entry.state,
        if mode == OAuthDirectoryClaimValueMode::Name {
          OidcDirectoryEntryState::Ambiguous
        } else {
          OidcDirectoryEntryState::Available
        }
      );
      let deep = catalog.entries.iter().find(|entry| entry.id == "deep").unwrap();
      assert_eq!(
        deep.claim_value.as_deref(),
        Some(if mode == OAuthDirectoryClaimValueMode::Name {
          "Deep"
        } else {
          "BranchA/Core/Deep"
        })
      );
      let requests = fixture.requests.lock().await;
      assert_eq!(requests.len(), 8);
      assert!(requests[3].contains("first=100&"));
      assert!(requests[4].contains("/parent%2Fone%3F/children?first=0&"));
      assert!(requests[5].contains("/parent%2Fone%3F/children?first=100&"));
    }
  }

  #[tokio::test]
  async fn keycloak_denied_incomplete_or_expired_reads_never_become_empty_successes() {
    for (responses, expected) in [
      (vec![response(401, json!({"error":"private-marker"}))], OidcDirectoryError::AccessDenied(401)),
      (vec![keycloak_token(), response(404, json!({"error":"private-marker"}))], OidcDirectoryError::HttpStatus(404)),
      (vec![keycloak_token(), response(200, json!({"count":1})), response(403, json!({"error":"private-marker"}))], OidcDirectoryError::AccessDenied(403)),
      // An empty filtered root window cannot hide a later window.
      (vec![keycloak_token(), response(200, json!({"count":101})), response(200, json!([])), response(401, json!({"error":"expired"}))], OidcDirectoryError::AccessDenied(401)),
      (vec![keycloak_token(), response(200, json!({"count":1})), response(200, json!([]))], OidcDirectoryError::InvalidResponse),
      (vec![keycloak_token(), response(200, json!({"count":1})), response(200, json!([kc_group("parent", "Parent", "/Parent", 1)])), response(200, json!([]))], OidcDirectoryError::InvalidResponse),
      (vec![keycloak_token(), response(200, json!({"count":MAX_DIRECTORY_GROUPS + 1}))], OidcDirectoryError::LimitExceeded),
      (vec!["HTTP/1.1 302 Found\r\nLocation: https://private-marker@foreign.invalid/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()], OidcDirectoryError::RedirectRejected),
    ] {
      let length = responses.len();
      let fixture = Fixture::with_kind(responses, true).await;
      let error = HttpOidcGroupDirectory::new(None).unwrap().retrieve(&fixture.keycloak_connection(OAuthDirectoryClaimValueMode::Name)).await.unwrap_err();
      assert_eq!(error, expected);
      assert_eq!(fixture.requests.lock().await.len(), length);
      assert!(!error.to_string().contains("private-marker"));
    }
  }
}
