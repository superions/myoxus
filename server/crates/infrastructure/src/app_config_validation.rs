// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transport-neutral validation for canonical application configuration.
//!
//! Every writer reaches this module through `app_config::validate_config_value`.
//! Keeping value-shape and security validation below GraphQL prevents trusted
//! CLI, REST, MCP, and internal writers from accepting different states.

use myoxus_application::auth::PasswordPolicy;
use myoxus_contracts::oauth_config::{OAuthProviderConfig, decode_oauth_provider_named};
use myoxus_domain::database::normalize_database_currency_code;

/// Returns `true` if the string is a valid MIME type pattern.
/// Accepts `type/subtype` (e.g. `image/png`) or `type/*` wildcards (e.g. `image/*`).
fn is_valid_mime_pattern(s: &str) -> bool {
  let Some((type_part, subtype_part)) = s.split_once('/') else {
    return false;
  };
  if type_part.is_empty() || subtype_part.is_empty() {
    return false;
  }
  // Type part: lowercase ascii letters, digits, hyphens
  let type_ok = type_part
    .chars()
    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
  // Subtype part: same chars plus '.', '+', '*' (for wildcards)
  let subtype_ok = subtype_part == "*"
    || subtype_part
      .chars()
      .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '.' | '+'));
  type_ok && subtype_ok
}

// --- Hardening helpers ------------------------------------------------------

/// Max lengths for string fields by category.
const MAX_LEN_URL: usize = 2048;
const MAX_LEN_NAME: usize = 256;
const MAX_LEN_IDENTIFIER: usize = 64;
const MAX_LEN_SECRET: usize = 4096;
const MAX_LEN_PATH: usize = 1024;

/// Reject strings containing XSS/injection patterns or null bytes.
///
/// Detected patterns (case-insensitive):
/// - HTML injection: `<script`, `<iframe`, `<img`, `<svg`, `<object`, `<embed`
/// - JS URI scheme: `javascript:`
/// - Inline event handlers: `onerror=`, `onload=`, `onclick=`, `onmouseover=`
/// - Data URIs with executable content: `data:text/html`, `data:application/javascript`
/// - CSS injection: `expression(`, `@import`
/// - Null bytes (binary injection)
fn contains_dangerous_pattern(s: &str) -> bool {
  let lower = s.to_ascii_lowercase();
  lower.contains("<script")
    || lower.contains("<iframe")
    || lower.contains("<img")
    || lower.contains("<svg")
    || lower.contains("<object")
    || lower.contains("<embed")
    || lower.contains("javascript:")
    || lower.contains("onerror=")
    || lower.contains("onload=")
    || lower.contains("onclick=")
    || lower.contains("onmouseover=")
    || lower.contains("data:text/html")
    || lower.contains("data:application/javascript")
    || lower.contains("expression(")
    || lower.contains("@import")
    || s.contains('\0')
}

/// Returns whether a URL contains a literal loopback, private, or link-local host.
///
/// DNS resolution and rebinding protection remain the responsibility of the
/// outbound HTTP client at connection time; validation cannot safely resolve a
/// hostname once and treat that result as authoritative.
fn is_internal_url(s: &str) -> bool {
  let Ok(url) = reqwest::Url::parse(s) else {
    return false;
  };
  let Some(raw_host) = url.host_str() else {
    return false;
  };
  // `url::Url` may preserve the RFC 3986 brackets around an IPv6 literal in
  // `host_str()`. Strip exactly that syntax before `IpAddr` parsing; domain
  // names and unbracketed IPv4 literals remain unchanged.
  let host = raw_host
    .strip_prefix('[')
    .and_then(|host| host.strip_suffix(']'))
    .unwrap_or(raw_host);
  if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
    return true;
  }
  host
    .parse::<std::net::IpAddr>()
    .is_ok_and(|address| address.is_loopback() || address.is_unspecified() || is_non_public_address(address))
}

fn is_non_public_address(address: std::net::IpAddr) -> bool {
  match address {
    std::net::IpAddr::V4(address) => is_non_public_ipv4(address),
    std::net::IpAddr::V6(address) => {
      address.to_ipv4_mapped().is_some_and(is_non_public_ipv4)
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || address.is_multicast()
        || address.segments()[0..2] == [0x2001, 0x0db8]
    }
  }
}

/// Rejects literal IPv4 ranges that cannot identify a public Internet peer.
/// DNS-based rebinding protection still belongs to the connection layer.
fn is_non_public_ipv4(address: std::net::Ipv4Addr) -> bool {
  let [first, second, third, _] = address.octets();
  address.is_loopback()
    || address.is_unspecified()
    || address.is_private()
    || address.is_link_local()
    || address.is_multicast()
    || address.is_broadcast()
    || address.is_documentation()
    || (first == 100 && (64..=127).contains(&second))
    || (first == 192 && second == 0 && third == 0)
    || (first == 198 && matches!(second, 18 | 19))
    || first >= 240
}

/// Validate a string field: check max length and dangerous patterns.
fn validate_string_field(module: &str, key: &str, value: &serde_json::Value, max_len: usize) -> Option<String> {
  if let Some(s) = value.as_str() {
    if s.len() > max_len {
      return Some(format!("{module}.{key} exceeds maximum length of {max_len}"));
    }
    if contains_dangerous_pattern(s) {
      return Some(format!(
        "{module}.{key} contains forbidden content (script tags, javascript: URLs, or null bytes)"
      ));
    }
  }
  None
}

/// Validate a URL string field: max length + dangerous patterns + optional SSRF check.
fn validate_url_field(module: &str, key: &str, value: &serde_json::Value, check_ssrf: bool) -> Option<String> {
  if let Some(err) = validate_string_field(module, key, value, MAX_LEN_URL) {
    return Some(err);
  }
  let url = value.as_str()?;
  if url.is_empty() {
    return None;
  }
  let Ok(parsed) = reqwest::Url::parse(url) else {
    return Some(format!("{module}.{key} must be a valid URL"));
  };
  if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
    return Some(format!("{module}.{key} must be an HTTP or HTTPS URL with a host"));
  }
  if check_ssrf && is_internal_url(url) {
    return Some(format!(
      "{module}.{key} must not point to internal/private network addresses"
    ));
  }
  None
}

/// Validate a number field has min/max bounds.
fn validate_number_bounds(module: &str, key: &str, value: &serde_json::Value, min: i64, max: i64) -> Option<String> {
  let Some(v) = value.as_i64() else {
    return Some(format!("{module}.{key} must be an integer between {min} and {max}"));
  };
  if v < min || v > max {
    return Some(format!("{module}.{key} must be between {min} and {max}"));
  }
  None
}

/// Validate an array field: max entries + all items must be strings + dangerous pattern check.
fn validate_string_array(
  module: &str,
  key: &str,
  value: &serde_json::Value,
  max_entries: usize,
  max_item_len: usize,
) -> Option<String> {
  let Some(arr) = value.as_array() else {
    return Some(format!("{module}.{key} must be an array of strings"));
  };
  if arr.len() > max_entries {
    return Some(format!("{module}.{key} exceeds maximum of {max_entries} entries"));
  }
  for item in arr {
    let Some(s) = item.as_str() else {
      return Some(format!("{module}.{key}: all items must be strings"));
    };
    if s.len() > max_item_len {
      return Some(format!("{module}.{key}: item exceeds maximum length of {max_item_len}"));
    }
    if contains_dangerous_pattern(s) {
      return Some(format!("{module}.{key}: item contains forbidden content"));
    }
  }
  None
}

fn validate_boolean_map(module: &str, key: &str, value: &serde_json::Value) -> Option<String> {
  if let Some(error) = validate_object_bounds(module, key, value, 128, 16_384) {
    return Some(error);
  }
  let object = value.as_object()?;
  for (entry, enabled) in object {
    if entry.trim().is_empty() || entry.len() > MAX_LEN_IDENTIFIER {
      return Some(format!(
        "{module}.{key}: map keys must be non-empty and at most 64 characters"
      ));
    }
    if !enabled.is_boolean() {
      return Some(format!("{module}.{key}.{entry} must be a boolean"));
    }
  }
  None
}

fn validate_sampling_rate_map(module: &str, key: &str, value: &serde_json::Value) -> Option<String> {
  if let Some(error) = validate_object_bounds(module, key, value, 128, 16_384) {
    return Some(error);
  }
  let object = value.as_object()?;
  for (entry, rate) in object {
    let Some(rate) = rate.as_f64() else {
      return Some(format!("{module}.{key}.{entry} must be a number"));
    };
    if !rate.is_finite() || !(0.0..=1.0).contains(&rate) {
      return Some(format!("{module}.{key}.{entry} must be between 0 and 1"));
    }
  }
  None
}

fn validate_optional_integer_field(
  module: &str,
  key: &str,
  object: &serde_json::Map<String, serde_json::Value>,
  field: &str,
  minimum: u64,
  maximum: u64,
) -> Option<String> {
  let value = object.get(field)?;
  let Some(value) = value.as_u64() else {
    return Some(format!("{module}.{key}.{field} must be a non-negative integer"));
  };
  if !(minimum..=maximum).contains(&value) {
    return Some(format!(
      "{module}.{key}.{field} must be between {minimum} and {maximum}"
    ));
  }
  None
}

fn validate_job_object(module: &str, key: &str, value: &serde_json::Value) -> Option<String> {
  if let Some(error) = validate_object_bounds(module, key, value, 20, 8192) {
    return Some(error);
  }
  let object = value.as_object()?;
  match key {
    "queue" => {
      if let Some(error) = validate_optional_integer_field(module, key, object, "attempts", 1, 50) {
        return Some(error);
      }
      if let Some(value) = object.get("removeOnComplete")
        && !value.is_boolean()
      {
        return Some("job.queue.removeOnComplete must be a boolean".to_string());
      }
      if let Some(backoff) = object.get("backoff") {
        let Some(backoff) = backoff.as_object() else {
          return Some("job.queue.backoff must be an object".to_string());
        };
        if let Some(kind) = backoff.get("type")
          && !matches!(kind.as_str(), Some("fixed" | "exponential"))
        {
          return Some("job.queue.backoff.type must be fixed or exponential".to_string());
        }
        if let Some(error) = validate_optional_integer_field(module, "queue.backoff", backoff, "delay", 1, 86_400_000) {
          return Some(error);
        }
      }
      if let Some(remove_on_fail) = object.get("removeOnFail") {
        let Some(remove_on_fail) = remove_on_fail.as_object() else {
          return Some("job.queue.removeOnFail must be an object".to_string());
        };
        if let Some(error) =
          validate_optional_integer_field(module, "queue.removeOnFail", remove_on_fail, "age", 1, u64::MAX)
        {
          return Some(error);
        }
        if let Some(error) = validate_optional_integer_field(
          module,
          "queue.removeOnFail",
          remove_on_fail,
          "count",
          1,
          u32::MAX.into(),
        ) {
          return Some(error);
        }
      }
    }
    "worker" => {
      return validate_optional_integer_field(module, key, object, "pollTimeoutSeconds", 1, 300);
    }
    queue if queue.starts_with("queues.") => {
      return validate_optional_integer_field(module, key, object, "concurrency", 1, 256);
    }
    _ => {}
  }
  None
}

fn validate_copilot_providers(module: &str, key: &str, value: &serde_json::Value) -> Option<String> {
  if let Some(error) = validate_object_bounds(module, key, value, 50, 65_536) {
    return Some(error);
  }
  let providers = value.as_object()?;
  for (provider_name, provider) in providers {
    if provider_name.trim().is_empty() || provider_name.len() > MAX_LEN_IDENTIFIER {
      return Some(format!(
        "{module}.{key}: provider names must be non-empty and at most 64 characters"
      ));
    }
    let Some(provider) = provider.as_object() else {
      return Some(format!("{module}.{key}.{provider_name} must be an object"));
    };
    if !matches!(
      provider.get("kind").and_then(serde_json::Value::as_str),
      Some("openai" | "open-ai" | "local" | "custom")
    ) {
      return Some(format!(
        "{module}.{key}.{provider_name}.kind must be openai, local, or custom"
      ));
    }
    if let Some(enabled) = provider.get("enabled")
      && !enabled.is_boolean()
    {
      return Some(format!("{module}.{key}.{provider_name}.enabled must be a boolean"));
    }
    for field in ["endpoint", "api_key"] {
      if let Some(field_value) = provider.get(field)
        && !field_value.is_null()
        && !field_value.is_string()
      {
        return Some(format!(
          "{module}.{key}.{provider_name}.{field} must be a string or null"
        ));
      }
    }
    if let Some(models) = provider.get("models")
      && validate_string_array(
        module,
        &format!("{key}.{provider_name}.models"),
        models,
        256,
        MAX_LEN_NAME,
      )
      .is_some()
    {
      return Some(format!(
        "{module}.{key}.{provider_name}.models must contain at most 256 safe strings"
      ));
    }
    if let Some(error) = validate_optional_integer_field(
      module,
      &format!("{key}.{provider_name}"),
      provider,
      "timeout_ms",
      100,
      600_000,
    ) {
      return Some(error);
    }
  }
  None
}

/// Validate an Object field: limit total JSON size and key count.
fn validate_object_bounds(
  module: &str,
  key: &str,
  value: &serde_json::Value,
  max_keys: usize,
  max_json_bytes: usize,
) -> Option<String> {
  if let Some(obj) = value.as_object() {
    if obj.len() > max_keys {
      return Some(format!("{module}.{key} exceeds maximum of {max_keys} keys"));
    }
    // Check serialized size to prevent oversized payloads
    let serialized = serde_json::to_string(value).unwrap_or_default();
    if serialized.len() > max_json_bytes {
      return Some(format!(
        "{module}.{key} exceeds maximum JSON size of {max_json_bytes} bytes"
      ));
    }
    // Recursively check all string values for dangerous patterns
    fn check_strings_recursive(val: &serde_json::Value) -> bool {
      match val {
        serde_json::Value::String(s) => contains_dangerous_pattern(s),
        serde_json::Value::Array(arr) => arr.iter().any(check_strings_recursive),
        serde_json::Value::Object(obj) => obj.values().any(check_strings_recursive),
        _ => false,
      }
    }
    if check_strings_recursive(value) {
      return Some(format!("{module}.{key} contains forbidden content in nested values"));
    }
  }
  None
}

/// Validates security constraints and typed JSON shape for one registry leaf.
///
/// Returning an error string lets the public writer map one validation result
/// into the transport-neutral [`super::app_config::ConfigWriteError`].
pub(crate) fn validate_config_value_shape(module: &str, key: &str, value: &serde_json::Value) -> Option<String> {
  // --- Generic string safety checks (applied to ALL string values) -----
  if value.is_string()
    && let Some(s) = value.as_str()
    && contains_dangerous_pattern(s)
  {
    return Some(format!(
      "{module}.{key} contains forbidden content (script tags, javascript: URLs, or null bytes)"
    ));
  }

  match (module, key) {
    ("auth", "password_requirements") => {
      let min = value
        .get("min")
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok());
      let max = value
        .get("max")
        .and_then(|value| value.as_u64())
        .and_then(|value| usize::try_from(value).ok());
      let (Some(min), Some(max)) = (min, max) else {
        return Some("auth.passwordRequirements requires numeric min and max".to_string());
      };
      PasswordPolicy::new(min, max).err().map(|error| error.to_string())
    }
    ("throttle", "default.ttl_ms") | ("throttle", "strict.ttl_ms") => {
      validate_number_bounds(module, key, value, 1, 86_400_000)
    }
    ("throttle", "default.limit") | ("throttle", "strict.limit") => {
      validate_number_bounds(module, key, value, 1, 1_000_000)
    }
    ("job", "queues.copilot.concurrency")
    | ("job", "queues.doc.concurrency")
    | ("job", "queues.indexer.concurrency")
    | ("job", "queues.document-graph.concurrency")
    | ("job", "queues.notification.concurrency")
    | ("job", "queues.nightly.concurrency")
    | ("job", "queues.calendar-reminder.concurrency")
    | ("job", "queues.git-sync.concurrency")
    | ("job", "queues.template-registry.concurrency")
    | ("job", "queues.caldav-sync.concurrency")
    | ("job", "queues.google-calendar-sync.concurrency")
    | ("job", "queues.pdf-export.concurrency")
    | ("job", "queues.database.concurrency")
    | ("job", "queues.workspace-automation.concurrency")
    | ("job", "queues.workspace-content-operation.concurrency") => validate_number_bounds(module, key, value, 1, 256),
    ("document_graph", "enqueue_delay_ms") => validate_number_bounds(module, key, value, 0, 86_400_000),
    ("document_graph", "max_graph_nodes")
    | ("document_graph", "max_graph_edges")
    | ("document_graph", "max_occurrences_per_edge")
    | ("document_graph", "max_reindex_batch")
    | ("document_graph", "max_catch_up_workspaces")
    | ("document_graph", "preview_max_chars")
    | ("document_graph", "stale_after_seconds")
    | ("document_graph", "max_reindex_attempts") => validate_number_bounds(module, key, value, 1, 1_000_000),
    ("pdf_export", "limits.max_concurrent_per_workspace") => validate_number_bounds(module, key, value, 1, 100),
    ("pdf_export", "limits.max_input_blocks") => validate_number_bounds(module, key, value, 1, 1_000_000),
    ("pdf_export", "limits.max_pages") => validate_number_bounds(module, key, value, 1, 10_000),
    ("pdf_export", "limits.render_timeout_seconds") => validate_number_bounds(module, key, value, 1, 3_600),
    ("pdf_export", "limits.max_memory_mb") => validate_number_bounds(module, key, value, 64, 1_048_576),
    ("pdf_export", "sync_threshold_blocks") => validate_number_bounds(module, key, value, 0, 1_000_000),
    ("pdf_export", "max_template_size_mb")
    | ("pdf_export", "max_brand_asset_size_mb")
    | ("pdf_export", "max_font_size_mb") => validate_number_bounds(module, key, value, 1, 1024),
    ("pdf_export", "max_dpi") => validate_number_bounds(module, key, value, 72, 2400),
    ("pdf_export", "verapdf_timeout_seconds") => validate_number_bounds(module, key, value, 1, 300),
    ("pdf_export", "edgeless_snapshot.max_dim_px") => validate_number_bounds(module, key, value, 512, 65536),
    ("pdf_export", "edgeless_snapshot.max_total_px") => {
      validate_number_bounds(module, key, value, 262_144, 1_073_741_824)
    }
    ("pdf_export", "edgeless_snapshot.max_size_mb") => validate_number_bounds(module, key, value, 1, 512),
    ("document_versioning", "default_retention_count") => validate_number_bounds(module, key, value, 1, 50),
    ("databases", "max_fields_per_database") => validate_number_bounds(module, key, value, 1, 1_000),
    ("databases", "max_views_per_database") => validate_number_bounds(module, key, value, 1, 1_000),
    ("databases", "max_rows_per_page") => validate_number_bounds(module, key, value, 1, 1_000),
    ("databases", "max_cell_text_bytes") => validate_number_bounds(module, key, value, 1, 10_485_760),
    ("databases", "csv_max_bytes") => validate_number_bounds(module, key, value, 1, 1_073_741_824),
    ("databases", "csv_max_rows") => validate_number_bounds(module, key, value, 1, 1_000_000),
    ("databases", "csv_max_columns") => validate_number_bounds(module, key, value, 1, 10_000),
    ("databases", "csv_sample_rows_for_type_inference") => validate_number_bounds(module, key, value, 1, 10_000),
    ("databases", "max_reminders_per_user_per_cell") => validate_number_bounds(module, key, value, 1, 20),
    ("databases", "max_reminder_offset_minutes") => validate_number_bounds(module, key, value, 0, 5_256_000),
    ("workspace", "import.max_upload_bytes")
    | ("workspace", "import.max_sqlite_bytes")
    | ("workspace", "import.max_entry_bytes") => validate_number_bounds(module, key, value, 1_048_576, 10_737_418_240),
    ("workspace", "import.max_expanded_bytes") | ("workspace", "import.max_asset_bytes") => {
      validate_number_bounds(module, key, value, 1_048_576, 107_374_182_400)
    }
    ("workspace", "import.max_archive_entries") => validate_number_bounds(module, key, value, 1, 1_000_000),
    ("workspace", "import.max_compression_ratio") => validate_number_bounds(module, key, value, 1, 10_000),
    ("workspace", "import.max_documents") => validate_number_bounds(module, key, value, 1, 1_000_000),
    ("workspace", "import.max_blocks") => validate_number_bounds(module, key, value, 1, 50_000_000),
    ("workspace", "import.max_databases") => validate_number_bounds(module, key, value, 1, 100_000),
    ("workspace", "import.max_rows_per_database") => validate_number_bounds(module, key, value, 1, 10_000_000),
    ("workspace", "import.max_cells_per_database") => validate_number_bounds(module, key, value, 1, 200_000_000),
    ("workspace", "import.max_assets") => validate_number_bounds(module, key, value, 1, 2_500_000),
    ("workspace", "import.staging_retention_hours") => validate_number_bounds(module, key, value, 1, 720),
    ("workspace", "import.job_timeout_seconds") => validate_number_bounds(module, key, value, 60, 86_400),
    ("workspace", "import.worker_concurrency") => validate_number_bounds(module, key, value, 1, 64),
    ("workspace_automation", "max_actions_per_run") => validate_number_bounds(module, key, value, 1, 500),
    ("workspace_automation", "max_runs_per_minute") => validate_number_bounds(module, key, value, 1, 100_000),
    ("workspace_automation", "webhook_timeout_seconds") => validate_number_bounds(module, key, value, 1, 300),
    ("workspace_automation", "max_retry_attempts") => validate_number_bounds(module, key, value, 1, 50),
    ("pdf_export", "default_paper_size") => {
      let s = value.as_str().unwrap_or_default().trim();
      if s.is_empty() || s.len() > MAX_LEN_IDENTIFIER {
        return Some(format!(
          "pdf_export.{key} must be a non-empty string up to {MAX_LEN_IDENTIFIER} chars"
        ));
      }
      None
    }
    ("pdf_export", "default_color_profile") => match value.as_str().unwrap_or_default() {
      "sRGB" | "CMYK_FOGRA39" | "CMYK_SWOP" => None,
      _ => Some("pdf_export.default_color_profile must be one of sRGB|CMYK_FOGRA39|CMYK_SWOP".to_string()),
    },
    ("pdf_export", "default_image_quality") => match value.as_str().unwrap_or_default() {
      "low" | "med" | "high" | "lossless" => None,
      _ => Some("pdf_export.default_image_quality must be one of low|med|high|lossless".to_string()),
    },
    ("pdf_export", "heading_font_scale") | ("pdf_export", "body_font_scale") => {
      let Some(scale) = value.as_f64() else {
        return Some(format!("pdf_export.{key} must be a finite number"));
      };
      if !scale.is_finite() || !(0.5..=1.5).contains(&scale) {
        return Some(format!("pdf_export.{key} must be between 0.5 and 1.5"));
      }
      None
    }
    ("pdf_export", "verapdf_validator_url") => {
      let s = value.as_str().unwrap_or_default().trim();
      if s.is_empty() {
        return Some("pdf_export.verapdf_validator_url must be a non-empty http(s) URL".to_string());
      }
      if s.len() > 2048 || !(s.starts_with("http://") || s.starts_with("https://")) {
        return Some("pdf_export.verapdf_validator_url must be a http(s) URL up to 2048 chars".to_string());
      }
      None
    }
    ("i18n", "available_locales") => {
      if let Some(error) = validate_string_array(module, key, value, 50, MAX_LEN_IDENTIFIER) {
        return Some(error);
      }
      let all_strings = value.as_array().is_some_and(|items| {
        !items.is_empty()
          && items.iter().all(|item| {
            item
              .as_str()
              .is_some_and(|s| !s.trim().is_empty() && s.len() <= MAX_LEN_IDENTIFIER)
          })
      });
      if !all_strings {
        return Some("i18n.availableLocales requires a non-empty string array (each <= 64 chars)".to_string());
      }
      None
    }
    // Auth domain verification validation
    ("auth", "allowed_email_domains") => {
      if let Some(error) = validate_string_array(module, key, value, 100, MAX_LEN_NAME) {
        return Some(error);
      }
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if s.trim().is_empty() || s.contains('@') || s.contains('/') {
              return Some(format!(
                "auth.allowedEmailDomains: invalid domain '{s}' - must be a plain domain (for example, company.com)"
              ));
            }
          } else {
            return Some("auth.allowedEmailDomains: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("auth", "dns_timeout_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if !(1..=30).contains(&v) {
        return Some("auth.dnsTimeoutSeconds must be between 1 and 30".to_string());
      }
      None
    }
    // Git Sync policy validation
    ("git_sync", "allowed_directions") => {
      if let Some(error) = validate_string_array(module, key, value, 10, MAX_LEN_IDENTIFIER) {
        return Some(error);
      }
      let valid = ["bidirectional", "myoxus_to_git", "git_to_myoxus"];
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if !valid.contains(&s) {
              return Some(format!(
                "git_sync.allowed_directions: invalid value '{s}', must be one of {valid:?}"
              ));
            }
          } else {
            return Some("git_sync.allowed_directions: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("git_sync", "allowed_auth_methods") => {
      if let Some(error) = validate_string_array(module, key, value, 10, MAX_LEN_IDENTIFIER) {
        return Some(error);
      }
      let valid = ["https_token", "https_password", "ssh_key"];
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if !valid.contains(&s) {
              return Some(format!(
                "git_sync.allowed_auth_methods: invalid value '{s}', must be one of {valid:?}"
              ));
            }
          } else {
            return Some("git_sync.allowed_auth_methods: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("git_sync", "allowed_hosts") => {
      if let Some(error) = validate_string_array(module, key, value, 100, MAX_LEN_NAME) {
        return Some(error);
      }
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if s.len() > MAX_LEN_NAME {
              return Some(format!(
                "git_sync.allowed_hosts: item exceeds maximum length of {MAX_LEN_NAME}"
              ));
            }
            if contains_dangerous_pattern(s) {
              return Some("git_sync.allowed_hosts: item contains forbidden content".to_string());
            }
          } else {
            return Some("git_sync.allowed_hosts: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("git_sync", "mime_allowlist_admin") | ("git_sync", "mime_blocklist_admin") => {
      if let Some(error) = validate_string_array(module, key, value, 200, 128) {
        return Some(error);
      }
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if s.len() > 128 {
              return Some(format!("git_sync.{key}: item exceeds maximum length of 128"));
            }
            if contains_dangerous_pattern(s) {
              return Some(format!("git_sync.{key}: item contains forbidden content"));
            }
            if !is_valid_mime_pattern(s) {
              return Some(format!(
                "git_sync.{key}: '{s}' is not a valid MIME type pattern (expected type/subtype or type/*)"
              ));
            }
          } else {
            return Some(format!("git_sync.{key}: all items must be strings"));
          }
        }
      }
      None
    }
    ("git_sync", "mime_validation_mode") => {
      if let Some(s) = value.as_str()
        && !matches!(s, "strict" | "warn")
      {
        return Some("git_sync.mime_validation_mode must be one of: strict, warn".to_string());
      }
      None
    }
    ("git_sync", "ssh_host_key_policy") => {
      if let Some(s) = value.as_str()
        && myoxus_application::git_sync::SshHostKeyPolicy::parse(s).is_none()
      {
        return Some("git_sync.ssh_host_key_policy must be one of: accept_new, strict, insecure_no_verify".to_string());
      }
      None
    }
    ("git_sync", "https_certificate_policy") => {
      if let Some(s) = value.as_str()
        && myoxus_application::git_sync::HttpsCertificatePolicy::parse(s).is_none()
      {
        return Some("git_sync.https_certificate_policy must be one of: strict, insecure_no_verify".to_string());
      }
      None
    }
    ("git_sync", "https_ca_bundle_path") => {
      if let Some(error) = validate_string_field(module, key, value, MAX_LEN_PATH) {
        return Some(error);
      }
      if let Some(path) = value.as_str()
        && let Err(error) = crate::tls::validate_relative_path(path)
      {
        return Some(error);
      }
      None
    }
    // Server Tuning validation (P34-C)
    ("websocket", "broadcast_channel_capacity") => {
      let v = value.as_u64().unwrap_or_default();
      if !(16..=1_000_000).contains(&v) {
        return Some("websocket.broadcast_channel_capacity must be between 16 and 1000000".to_string());
      }
      None
    }
    ("storage", "io_timeout_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if !(1..=3600).contains(&v) {
        return Some("storage.io_timeout_seconds must be between 1 and 3600".to_string());
      }
      None
    }
    ("http", "proxy_timeout_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if !(1..=3600).contains(&v) {
        return Some("http.proxy_timeout_seconds must be between 1 and 3600".to_string());
      }
      None
    }
    ("worker", "polling.doc_maintenance_interval_ms")
    | ("worker", "polling.indexer_auto_index_interval_ms")
    | ("worker", "polling.document_graph_reindex_interval_ms")
    | ("worker", "polling.database_projection_interval_ms")
    | ("worker", "polling.workspace_automation_retry_interval_ms") => {
      let v = value.as_u64().unwrap_or_default();
      if !(5000..=86_400_000).contains(&v) {
        return Some(format!("worker.{key} must be between 5000 (5s) and 86400000 (1 day)"));
      }
      None
    }
    ("redis", "cache_ttl_quota_seconds")
    | ("redis", "cache_ttl_usage_seconds")
    | ("redis", "cache_ttl_git_status_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if !(5..=86400).contains(&v) {
        return Some(format!("redis.{key} must be between 5 and 86400 (1 day)"));
      }
      None
    }
    ("worker", "cron_tick_interval_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if !(5..=86400).contains(&v) {
        return Some("worker.cron_tick_interval_seconds must be between 5 and 86400".to_string());
      }
      None
    }
    // Explicit fixed-TTL overrides; null releases the database override.
    ("cache", "server_config_fixed_ttl_seconds")
    | ("cache", "user_features_fixed_ttl_seconds")
    | ("cache", "throttle_config_fixed_ttl_seconds")
    | ("cache", "ws_settings_fixed_ttl_seconds")
    | ("cache", "doc_snapshot_fixed_ttl_seconds")
    | ("cache", "doc_metadata_fixed_ttl_seconds")
    | ("cache", "doc_metadata_projection_fixed_ttl_seconds")
    | ("cache", "doc_timestamps_fixed_ttl_seconds") => {
      // Allow null (clears fixed override) or a number in [5, 86400]
      if value.is_null() {
        return None;
      }
      let v = value.as_u64().unwrap_or_default();
      if !(5..=86400).contains(&v) {
        return Some(format!("cache.{key} must be between 5 and 86400 (or null to clear)"));
      }
      None
    }
    // Template Registry validation
    ("template_registry", "reconcile_default_mode") => {
      if let Some(s) = value.as_str()
        && !matches!(s, "seed_once" | "managed_until_local_edit" | "manual_update")
      {
        return Some(
          "template_registry.reconcile_default_mode must be one of: seed_once, managed_until_local_edit, manual_update"
            .to_string(),
        );
      }
      None
    }
    ("template_registry", "import_max_bundle_size_mb") => {
      let v = value.as_u64().unwrap_or_default();
      if v < 1 {
        return Some("template_registry.import_max_bundle_size_mb must be >= 1".to_string());
      }
      None
    }
    ("template_registry", "drift_scan_interval_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if v < 10 {
        return Some("template_registry.drift_scan_interval_seconds must be >= 10".to_string());
      }
      None
    }
    // CORS validation
    ("cors", "app_origins") => {
      if let Some(error) = validate_string_array(module, key, value, 50, MAX_LEN_URL) {
        return Some(error);
      }
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if s != "null" && !s.ends_with("://") {
              return Some(format!("cors.appOrigins: '{s}' must end with :// or be \"null\""));
            }
          } else {
            return Some("cors.appOrigins: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("cors", "allowed_custom_headers") => {
      if let Some(error) = validate_string_array(module, key, value, 100, MAX_LEN_NAME) {
        return Some(error);
      }
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if s.trim().is_empty() {
              return Some("cors.allowedCustomHeaders: items must not be empty".to_string());
            }
            if reqwest::header::HeaderName::from_bytes(s.as_bytes()).is_err() {
              return Some(format!(
                "cors.allowedCustomHeaders: '{s}' is not a valid HTTP header name"
              ));
            }
          } else {
            return Some("cors.allowedCustomHeaders: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("cors", "allowed_origins") => {
      if let Some(error) = validate_string_array(module, key, value, 50, MAX_LEN_URL) {
        return Some(error);
      }
      if let Some(arr) = value.as_array() {
        for item in arr {
          if let Some(s) = item.as_str() {
            if s.is_empty() {
              return Some("cors.allowedOrigins must not contain empty origins".to_string());
            }
            if let Some(error) = validate_url_field(module, key, item, false) {
              return Some(error);
            }
          } else {
            return Some("cors.allowedOrigins: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("cors", "max_age_seconds") => {
      let v = value.as_i64().unwrap_or(-1);
      if !(0..=86400).contains(&v) {
        return Some("cors.maxAgeSeconds must be between 0 and 86400 (1 day)".to_string());
      }
      None
    }
    // Storage MB field validation (must be >= 1 MB)
    ("storage", "max_upload_mb") => {
      let v = value.as_u64().unwrap_or_default();
      if !(1..=10240).contains(&v) {
        return Some("storage.maxUploadMb must be between 1 and 10240 (10 GB)".to_string());
      }
      None
    }
    ("storage", "min_free_space_mb") => {
      let v = value.as_u64().unwrap_or_default();
      if v > 10_000_000 {
        return Some("storage.minFreeSpaceMb must be between 0 and 10000000 (~10 TB)".to_string());
      }
      None
    }
    ("storage", "multipart_threshold_mb") => {
      let v = value.as_u64().unwrap_or_default();
      if !(1..=1024).contains(&v) {
        return Some("storage.multipartThresholdMb must be between 1 and 1024 (1 GB)".to_string());
      }
      None
    }
    ("websocket", "max_http_buffer_size_mb") => {
      let v = value.as_u64().unwrap_or_default();
      if !(1..=1024).contains(&v) {
        return Some("websocket.maxHttpBufferSizeMb must be between 1 and 1024 (1 GB)".to_string());
      }
      None
    }
    // Built-in Google/GitHub entries own only credentials; Apple, OIDC and
    // custom providers use the complete endpoint and claim contract.
    ("oauth", "providers.google")
    | ("oauth", "providers.github")
    | ("oauth", "providers.oidc")
    | ("oauth", "providers.apple") => {
      if let Some(error) = validate_object_bounds(module, key, value, 64, 32_768) {
        return Some(error);
      }
      if value.get("scopes").is_some_and(|scopes| !scopes.is_array()) {
        return Some(format!("oauth.{key}: scopes must be an array of strings"));
      }
      let provider_name = key.strip_prefix("providers.").unwrap_or(key);
      let provider = match decode_oauth_provider_named(provider_name, value.clone()) {
        Ok(provider) => provider,
        Err(error) => return Some(format!("oauth.{key}: {}", error.message())),
      };
      let provider = match provider {
        OAuthProviderConfig::Simple(provider) => {
          if provider.client_id.trim().is_empty() || provider.client_secret.trim().is_empty() {
            return Some(format!(
              "oauth.{key}: clientId and clientSecret are required and must be non-empty strings"
            ));
          }
          return None;
        }
        OAuthProviderConfig::Custom(provider) => provider,
      };
      for (field, value) in [
        ("clientId", provider.client_id.as_str()),
        ("clientSecret", provider.client_secret.as_str()),
        ("authUrl", provider.auth_url.as_str()),
        ("tokenUrl", provider.token_url.as_str()),
        ("userinfoUrl", provider.userinfo_url.as_str()),
      ] {
        if value.trim().is_empty() {
          return Some(format!(
            "oauth.{key}: {field} is required and must be a non-empty string"
          ));
        }
        if matches!(field, "authUrl" | "tokenUrl" | "userinfoUrl") && !value.starts_with("https://") {
          return Some(format!("oauth.{key}: {field} - OAuth endpoint URLs must use HTTPS"));
        }
      }
      for (field, url) in [
        ("issuerUrl", provider.issuer_url.as_deref()),
        ("discoveryUrl", provider.discovery_url.as_deref()),
        ("jwksUrl", provider.jwks_url.as_deref()),
      ] {
        if let Some(url) = url
          && !url.starts_with("https://")
        {
          return Some(format!("oauth.{key}: {field} - OAuth endpoint URLs must use HTTPS"));
        }
      }
      if provider.scopes.len() > 64
        || provider
          .scopes
          .iter()
          .any(|scope| scope.trim().is_empty() || scope.len() > MAX_LEN_NAME)
      {
        return Some(format!("oauth.{key}: scopes must contain at most 64 non-empty values"));
      }
      for (field, claim) in [
        ("subject", provider.claims.subject.as_deref()),
        ("email", provider.claims.email.as_deref()),
        ("emailVerified", provider.claims.email_verified.as_deref()),
        ("name", provider.claims.name.as_deref()),
        ("avatar", provider.claims.avatar.as_deref()),
        ("groups", provider.claims.groups.as_deref()),
        ("groupsSource", provider.claims.groups_source.as_deref()),
      ] {
        if claim.is_some_and(|value| value.trim().is_empty()) {
          return Some(format!(
            "oauth.{key}: claims.{field} must be a non-empty string when provided"
          ));
        }
      }
      if !matches!(
        provider.group_mapping.default_role.as_str(),
        "reader" | "member" | "manager"
      ) {
        return Some(format!(
          "oauth.{key}: groupMapping.defaultRole must be one of reader, member, manager"
        ));
      }
      for rule in &provider.group_mapping.mappings {
        if rule.provider_group.trim().is_empty() {
          return Some(format!(
            "oauth.{key}: groupMapping.mappings[].providerGroup is required"
          ));
        }
        if rule.target_unit_id.trim().is_empty() {
          return Some(format!("oauth.{key}: groupMapping.mappings[].targetUnitId is required"));
        }
        if rule
          .role
          .as_deref()
          .is_some_and(|role| !matches!(role, "reader" | "member" | "manager"))
        {
          return Some(format!(
            "oauth.{key}: groupMapping.mappings[].role must be one of reader, member, manager"
          ));
        }
      }
      None
    }
    ("storage", "signed_url_ttl_seconds") => {
      let v = value.as_u64().unwrap_or_default();
      if !(60..=604_800).contains(&v) {
        return Some("storage.signed_url_ttl_seconds must be between 60 and 604800 (7 days)".to_string());
      }
      None
    }
    ("storage", "default_workspace_quota_mb") => {
      let v = value.as_i64().unwrap_or(-1);
      if !(0..=10_000_000).contains(&v) {
        return Some(
          "storage.default_workspace_quota_mb must be between 0 (unlimited) and 10000000 (~10 TB)".to_string(),
        );
      }
      None
    }
    // Journal validation
    ("journal", "first_day_of_week") => {
      if let Some(s) = value.as_str()
        && s != "monday"
        && s != "sunday"
      {
        return Some("journal.first_day_of_week must be 'monday' or 'sunday'".to_string());
      }
      None
    }

    // --- String max-length + SSRF hardening -----------------------------

    // URL fields with SSRF check (these should not point to internal networks)
    ("doc_service", "endpoint") => validate_url_field(module, key, value, true),
    ("indexer", "provider_endpoint") => validate_url_field(module, key, value, true),

    // server.origin is the server's own origin, so no SSRF check is needed.
    ("server", "origin") => validate_url_field(module, key, value, false),

    // Name/identifier string fields
    ("server", "name") | ("server", "host") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("server", "deployment_type") => {
      if let Some(s) = value.as_str() {
        if !matches!(s.to_lowercase().as_str(), "standalone" | "cloud") {
          return Some(format!("{module}.{key}: must be 'standalone' or 'cloud', got '{s}'"));
        }
        None
      } else {
        Some(format!("{module}.{key}: expected string, got {value}"))
      }
    }
    ("i18n", "default_locale") | ("admin_i18n", "default_locale") => {
      validate_string_field(module, key, value, MAX_LEN_IDENTIFIER)
    }
    ("i18n", "default_currency") => {
      let Some(raw) = value.as_str() else {
        return Some("i18n.default_currency must be a string".to_string());
      };
      match normalize_database_currency_code(raw) {
        Some(code) if code == raw.trim() => None,
        Some(code) => Some(format!(
          "i18n.default_currency must be an uppercase ISO-4217 code such as {code}"
        )),
        None => Some("i18n.default_currency must be a valid ISO-4217 currency code".to_string()),
      }
    }
    ("client", "version_control.required_version") => validate_string_field(module, key, value, MAX_LEN_IDENTIFIER),

    // Mailer string fields
    ("mail", "smtp_name") | ("mail", "fallback_smtp.name") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("mail", "smtp_host") | ("mail", "fallback_smtp.host") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("mail", "smtp_user")
    | ("mail", "smtp_pass")
    | ("mail", "fallback_smtp.username")
    | ("mail", "fallback_smtp.password") => validate_string_field(module, key, value, MAX_LEN_SECRET),
    ("mail", "sender") | ("mail", "fallback_smtp.sender") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("mail", "smtp_transport") | ("mail", "fallback_smtp.transport") => match value.as_str() {
      Some("plain" | "starttls" | "implicit_tls") => None,
      _ => Some(format!("{module}.{key} must be plain, starttls, or implicit_tls")),
    },

    // Client - download URL
    ("client", "download_url") => validate_url_field(module, key, value, false),

    // Crypto - private key can be large
    ("crypto", "private_key") => validate_string_field(module, key, value, MAX_LEN_SECRET),

    // Indexer string fields
    ("indexer", "provider_type") => validate_string_field(module, key, value, MAX_LEN_IDENTIFIER),
    ("indexer", "provider_api_key") | ("indexer", "provider_username") | ("indexer", "provider_password") => {
      validate_string_field(module, key, value, MAX_LEN_SECRET)
    }

    // Git Sync string fields
    ("git_sync", "default_branch") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("git_sync", "repo_base_dir") => validate_string_field(module, key, value, MAX_LEN_PATH),
    ("git_sync", "commit_author_name") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("git_sync", "commit_author_email") => validate_string_field(module, key, value, MAX_LEN_NAME),

    // --- Number bounds hardening ----------------------------------------
    ("server", "port") => validate_number_bounds(module, key, value, 1, 65535),
    ("auth", "session.ttl") => validate_number_bounds(module, key, value, 60, 31_536_000), // 1min..1year in seconds
    ("auth", "session.ttr") => validate_number_bounds(module, key, value, 60, 31_536_000),
    ("doc", "history.interval") => validate_number_bounds(module, key, value, 900_000, 86_400_000), // 15min..1day in ms
    ("mail", "smtp_port") | ("mail", "fallback_smtp.port") => validate_number_bounds(module, key, value, 1, 65535),
    ("indexer", "auto_index_batch_size") => validate_number_bounds(module, key, value, 1, 10_000),

    ("telemetry", "categories") | ("metrics", "categories") => validate_boolean_map(module, key, value),
    ("telemetry", "sampling_rates") => validate_sampling_rate_map(module, key, value),

    // Telemetry numbers (P-Telemetry-A)
    ("telemetry", "dedupe_ttl_hours") => validate_number_bounds(module, key, value, 1, 8760), // up to 1 year
    ("telemetry", "dedupe_max_entries") => validate_number_bounds(module, key, value, 1, 10_000_000),
    ("telemetry", "batch_max_events") => validate_number_bounds(module, key, value, 1, 100_000),
    ("telemetry", "flush_interval_seconds") => validate_number_bounds(module, key, value, 1, 3600),
    ("telemetry", "retention_raw_days") => validate_number_bounds(module, key, value, 1, 3650),
    ("telemetry", "retention_daily_days") => validate_number_bounds(module, key, value, 1, 3650),
    ("telemetry", "ingest_rate_limit_per_ip_per_min") => validate_number_bounds(module, key, value, 1, 1_000_000),

    // Metrics numbers (P-Metrics-A)
    ("metrics", "flush_interval_seconds") => validate_number_bounds(module, key, value, 1, 3600),
    ("metrics", "retention_raw_days") => validate_number_bounds(module, key, value, 1, 3650),
    ("metrics", "retention_daily_days") => validate_number_bounds(module, key, value, 1, 3650),
    ("metrics", "cardinality_limit_per_metric") => validate_number_bounds(module, key, value, 1, 1_000_000),

    // WebSocket numbers not covered by the specialized validation above.
    ("websocket", "ping_interval_seconds") => validate_number_bounds(module, key, value, 1, 3600),
    ("websocket", "max_connections_per_second_per_client") => validate_number_bounds(module, key, value, 1, 100),

    // Logging
    ("logging", "max_history") => validate_number_bounds(module, key, value, 0, 100_000),

    // GitSync numbers (those without existing validation)
    ("git_sync", "network_timeout_secs") => validate_number_bounds(module, key, value, 1, 3600),
    ("git_sync", "local_timeout_secs") => validate_number_bounds(module, key, value, 1, 3600),
    ("git_sync", "max_docs_per_sync") => validate_number_bounds(module, key, value, 0, 100_000),
    ("git_sync", "clone_depth") => validate_number_bounds(module, key, value, 1, 100_000),
    ("git_sync", "push_max_retries") => validate_number_bounds(module, key, value, 0, 100),
    ("git_sync", "parallel_conversion_threshold") => validate_number_bounds(module, key, value, 1, 10_000),
    ("git_sync", "max_mirror_storage_mb") => validate_number_bounds(module, key, value, 1, 10_000_000),
    ("git_sync", "min_free_disk_mb") => validate_number_bounds(module, key, value, 0, 10_000_000),
    ("git_sync", "retention_days") => validate_number_bounds(module, key, value, 1, 30),

    // Cleanup retention numbers
    ("cleanup", "history_retention_days") => validate_number_bounds(module, key, value, 1, 3650),
    ("cleanup", "notification_retention_days") => validate_number_bounds(module, key, value, 1, 3650),
    ("cleanup", "pending_blob_retention_hours") => validate_number_bounds(module, key, value, 1, 8760),
    ("cleanup", "outbox_retention_days") => validate_number_bounds(module, key, value, 1, 3650),

    // --- Array max-length hardening -------------------------------------
    ("websocket", "eio_ping_interval_seconds") | ("websocket", "eio_ping_timeout_seconds") => {
      validate_number_bounds(module, key, value, 1, 2_147_483)
    }
    ("websocket", "transports") => {
      if let Some(err) = validate_string_array(module, key, value, 10, MAX_LEN_IDENTIFIER) {
        return Some(err);
      }
      // Whitelist valid transports
      if let Some(arr) = value.as_array() {
        let valid = ["polling", "websocket"];
        for item in arr {
          if let Some(s) = item.as_str() {
            if !valid.contains(&s) {
              return Some(format!(
                "websocket.transports: invalid transport '{s}', must be one of {valid:?}"
              ));
            }
          } else {
            return Some("websocket.transports: all items must be strings".to_string());
          }
        }
      }
      None
    }
    ("mail", "fallback_domains") => validate_string_array(module, key, value, 50, MAX_LEN_NAME),
    ("telemetry", "allowed_origins") => {
      if let Some(error) = validate_string_array(module, key, value, 50, MAX_LEN_URL) {
        return Some(error);
      }
      for origin in value.as_array().into_iter().flatten() {
        if origin.as_str().is_some_and(str::is_empty) {
          return Some("telemetry.allowed_origins must not contain empty origins".to_string());
        }
        if let Some(error) = validate_url_field(module, key, origin, false) {
          return Some(error);
        }
      }
      None
    }

    // Filesystem path fields
    ("storage", "root") | ("logging", "file_path") => {
      if let Some(err) = validate_string_field(module, key, value, MAX_LEN_PATH) {
        return Some(err);
      }
      if let Some(s) = value.as_str() {
        if s.contains("..") {
          return Some(format!("{module}.{key}: path traversal (..) not allowed"));
        }
        if s.trim().is_empty() {
          return Some(format!("{module}.{key}: path must not be empty"));
        }
        // Only validate syntax - runtime path existence checks belong at
        // startup/usage, not at config validation time (TOCTOU).
        if !s.starts_with('/') && !s.starts_with('.') && !s.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) {
          return Some(format!("{module}.{key}: path has invalid leading character"));
        }
      }
      None
    }

    // --- Object field hardening (generic bounds for unstructured objects) -

    // Structured Copilot values remain one row each. Bound and recursively
    // inspect the complete object instead of accepting synthetic child paths.
    ("copilot", "providers") => validate_copilot_providers(module, key, value),

    ("transcription", "endpoint") => {
      let endpoint = value.as_str()?;
      if endpoint.is_empty() {
        None
      } else {
        crate::transcription::validate_endpoint(endpoint)
          .err()
          .map(|error| format!("transcription.endpoint: {error}"))
      }
    }
    ("transcription", "model") => validate_string_field(module, key, value, 256),
    ("transcription", "language") => validate_string_field(module, key, value, 64),
    ("transcription", "api_key") => validate_string_field(module, key, value, MAX_LEN_SECRET),

    // Copilot - top-level scalar config
    ("copilot", "default_provider") | ("copilot", "embedding_model") => {
      validate_string_field(module, key, value, MAX_LEN_IDENTIFIER)
    }

    ("copilot", "request_timeout_ms") => validate_number_bounds(module, key, value, 100, 600_000),

    // Copilot - embedding sub-keys
    ("copilot", "embedding.endpoint") => validate_url_field(module, key, value, false),
    ("copilot", "embedding.api_key") => validate_string_field(module, key, value, MAX_LEN_SECRET),
    ("copilot", "embedding.model") => validate_string_field(module, key, value, MAX_LEN_NAME),
    ("copilot", "embedding.dimensions") => validate_number_bounds(module, key, value, 1, 16000),

    ("copilot", "fallback_providers") => validate_string_array(module, key, value, 50, MAX_LEN_NAME),
    ("copilot", "unsplash") | ("copilot", "exa") => {
      if let Some(error) = validate_object_bounds(module, key, value, 20, 4096) {
        return Some(error);
      }
      if let Some(api_key) = value.get("key")
        && !api_key.is_null()
        && !api_key.is_string()
      {
        return Some(format!("{module}.{key}.key must be a string or null"));
      }
      None
    }

    // Calendar objects
    ("calendar", "google") | ("calendar", "caldav") => validate_object_bounds(module, key, value, 20, 8192),

    // Captcha (P-Captcha-A)
    ("captcha", "algorithm") => {
      // Enum validation (match registry enum_values + altcha-lib-rs capabilities)
      if let Some(s) = value.as_str() {
        const ALLOWED: &[&str] = &["SHA-256", "SHA-384", "SHA-512"];
        if !ALLOWED.contains(&s) {
          return Some(format!("captcha.algorithm must be one of {ALLOWED:?}"));
        }
        None
      } else {
        Some("captcha.algorithm must be a string".to_string())
      }
    }
    ("captcha", "hmac_key") => validate_string_field(module, key, value, 512),
    ("captcha", "honeypot_field_name") => validate_string_field(module, key, value, 64),
    ("captcha", "challenge_expires_seconds") => validate_number_bounds(module, key, value, 60, 86_400),
    ("captcha", "max_number") => validate_number_bounds(module, key, value, 1_000, 10_000_000),
    ("captcha", "rate_limit_per_ip_per_min") => validate_number_bounds(module, key, value, 1, 10_000),
    ("captcha", "rate_limit_per_account_per_hour") => validate_number_bounds(module, key, value, 1, 10_000),

    // Job objects share the typed queue contract consumed by every worker.
    ("job", "queue") | ("job", "worker") => validate_job_object(module, key, value),
    ("job", "queues.copilot")
    | ("job", "queues.doc")
    | ("job", "queues.indexer")
    | ("job", "queues.document-graph")
    | ("job", "queues.notification")
    | ("job", "queues.nightly")
    | ("job", "queues.calendar-reminder")
    | ("job", "queues.git-sync")
    | ("job", "queues.template-registry")
    | ("job", "queues.caldav-sync")
    | ("job", "queues.google-calendar-sync")
    | ("job", "queues.pdf-export")
    | ("job", "queues.database")
    | ("job", "queues.workspace-automation")
    | ("job", "queues.workspace-content-operation") => validate_job_object(module, key, value),

    _ => None,
  }
}
