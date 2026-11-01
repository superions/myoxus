// SPDX-License-Identifier: AGPL-3.0-or-later
//! reqwest-backed implementation of [`VerapdfClient`] (`P-PDF-TPL-PDFA-01-04`).
//!
//! Lives in the infrastructure crate because that's where every other
//! external HTTP integration lives (CalDAV, Copilot, OAuth). The
//! `pdf_export` crate keeps the trait + URL-builder dependency-free so
//! tests can swap in mocks without standing up an HTTP stack.
//!
//! ## Endpoint contract
//!
//! `POST {base_url}/api/validate/{profileId}` (`1b`, `2b`, `2u`, `3b`, `ua1`)
//!   • Request body: multipart form with a `file` part containing PDF bytes.
//!   • Response: the native veraPDF JSON report. This adapter reduces the
//!     nested `report.jobs[].validationResult` structure to [`VerapdfReport`].
//!     Non-compliant or incomplete/malformed reports return
//!     `Ok(VerapdfReport { passed: false, ... })`. Only explicit positive
//!     boolean verdicts and the requested profile identity for every job/result pass;
//!     optional rule counts never
//!     establish compliance. Network, HTTP and JSON decoding failures return
//!     [`PdfaError::Transport`].
//!
//! Transport failures (DNS, TCP, deserialise) become
//! [`PdfaError::Transport`] so the worker can distinguish "veraPDF said
//! no" from "veraPDF unreachable".

use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tracing::{debug, instrument, warn};

use myoxus_pdf_export::render_v2::pdfa::{HttpVerapdfClient, PdfaError, VerapdfClient, VerapdfProfile, VerapdfReport};

/// Wrapper around [`HttpVerapdfClient`] (which lives in
/// `myoxus_pdf_export` and only carries the URL-builder + config fields)
/// plus a real `reqwest::Client`. Constructing this in `infrastructure`
/// keeps `pdf_export` reqwest-free.
#[derive(Clone, Debug)]
pub struct ReqwestVerapdfClient {
  config: HttpVerapdfClient,
  http: reqwest::Client,
}

impl ReqwestVerapdfClient {
  /// Build a client for the given veraPDF base URL with a per-request
  /// timeout. The reqwest client is configured with rustls-tls (no
  /// system OpenSSL dependency), HTTP/2 keep-alive, and a deny-all
  /// redirect policy — veraPDF should never redirect a `POST
  /// /validate`, and silently following a redirect could exfiltrate
  /// the user's PDF to a third party.
  pub fn new(
    base_url: impl Into<String>,
    timeout: Duration,
    additional_ca: Option<&crate::tls::ValidatedCaBundle>,
  ) -> Result<Self, PdfaError> {
    let http = crate::tls::build_http_client(
      reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none()),
      additional_ca,
    )
    .map_err(|e| PdfaError::Transport(format!("reqwest client build: {e}")))?;
    Ok(Self {
      config: HttpVerapdfClient::new(base_url, timeout),
      http,
    })
  }
}

#[async_trait]
impl VerapdfClient for ReqwestVerapdfClient {
  #[instrument(skip(self, pdf_bytes), fields(profile = ?profile, bytes = pdf_bytes.len()), err)]
  async fn validate(&self, pdf_bytes: &[u8], profile: VerapdfProfile) -> Result<VerapdfReport, PdfaError> {
    let url = self.config.validate_url(profile);
    debug!(url, "POSTing PDF to veraPDF /validate");
    let file_part = reqwest::multipart::Part::bytes(pdf_bytes.to_vec())
      .file_name("document.pdf")
      .mime_str("application/pdf")
      .map_err(|e| PdfaError::Transport(format!("veraPDF multipart content-type: {e}")))?;
    let form = reqwest::multipart::Form::new().part("file", file_part);
    let response = self
      .http
      .post(&url)
      .header(reqwest::header::ACCEPT, "application/json")
      .multipart(form)
      .send()
      .await
      .map_err(|e| PdfaError::Transport(format!("POST {url}: {e}")))?;
    let status = response.status();
    if !status.is_success() {
      // Error bodies can echo the uploaded document. Retain the HTTP failure
      // category without exposing that payload through worker logs or errors.
      warn!(status = %status, "veraPDF returned non-2xx");
      return Err(PdfaError::Transport(format!("veraPDF returned HTTP {status}")));
    }
    let raw_report: Value = response
      .json()
      .await
      .map_err(|e| PdfaError::Transport(format!("veraPDF response decode: {e}")))?;
    let report = reduce_verapdf_report(&raw_report, profile);
    debug!(
      passed = report.passed,
      failures = report.failures.len(),
      "veraPDF validation done"
    );
    Ok(report)
  }
}

/// Only the REST contract's explicit boolean verdicts establish compliance.
/// Optional counters can contradict that verdict, but never replace it.
fn validate_result(result: &Value) -> Result<(), String> {
  let object = result.as_object().ok_or("validationResult must be an object")?;
  let mut verdict = None;
  for field in ["isCompliant", "compliant"] {
    if let Some(value) = object.get(field) {
      let value = value.as_bool().ok_or("compliance verdict must be boolean")?;
      if verdict.is_some_and(|previous| previous != value) {
        return Err("conflicting compliance verdicts".into());
      }
      verdict = Some(value);
    }
  }
  let compliant = verdict.ok_or("missing explicit compliance verdict")?;
  let details = match object.get("details") {
    Some(value) => Some(value.as_object().ok_or("validation details must be an object")?),
    None => None,
  };
  let mut failed_rules = 0;
  for field in ["failedRules", "passedRules"] {
    let mut count = None;
    for value in [object.get(field), details.and_then(|details| details.get(field))]
      .into_iter()
      .flatten()
    {
      let value = value.as_u64().ok_or("rule counts must be nonnegative integers")?;
      if count.is_some_and(|previous| previous != value) {
        return Err("conflicting rule counts".into());
      }
      count = Some(value);
    }
    if field == "failedRules" {
      failed_rules = count.unwrap_or(0);
    }
  }
  if !compliant || failed_rules > 0 {
    return Err(format!("failed PDF validation (failedRules={failed_rules})"));
  }
  Ok(())
}

fn reduce_verapdf_report(value: &Value, profile: VerapdfProfile) -> VerapdfReport {
  let Some(jobs) = value
    .pointer("/report/jobs")
    .and_then(Value::as_array)
    .filter(|jobs| !jobs.is_empty())
  else {
    return VerapdfReport {
      passed: false,
      failures: vec!["veraPDF response did not contain nonempty report.jobs".to_string()],
    };
  };

  let mut failures = Vec::new();
  for (job_index, job) in jobs.iter().enumerate() {
    // Every job must be validated. A valid sibling must not mask a missing,
    // empty or malformed result, including an element of a result array.
    let results: &[Value] = match job.get("validationResult") {
      Some(Value::Array(items)) if !items.is_empty() => items,
      Some(value @ Value::Object(_)) => std::slice::from_ref(value),
      _ => {
        failures.push(format!("job {} missing nonempty validationResult", job_index + 1));
        continue;
      }
    };
    for result in results {
      if result.get("profileName").and_then(Value::as_str) != Some(profile.report_name()) {
        failures.push(format!(
          "job {} missing or mismatched requested validation profile",
          job_index + 1
        ));
      }
      if let Err(detail) = validate_result(result) {
        failures.push(format!("job {} {detail}", job_index + 1));
      }
    }
  }

  VerapdfReport {
    passed: failures.is_empty(),
    failures,
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use myoxus_pdf_export::render_v2::pdfa::PdfaProfile;

  /// Even without veraPDF reachable, the URL builder must produce
  /// stable output for every supported profile.
  #[test]
  fn validate_url_for_every_profile() {
    let c = ReqwestVerapdfClient::new("http://verapdf:8080", Duration::from_secs(5), None).expect("build");
    assert_eq!(
      c.config.validate_url(PdfaProfile::Pdfa1b.into()),
      "http://verapdf:8080/api/validate/1b"
    );
    assert_eq!(
      c.config.validate_url(PdfaProfile::Pdfa2b.into()),
      "http://verapdf:8080/api/validate/2b"
    );
    assert_eq!(
      c.config.validate_url(PdfaProfile::Pdfa3b.into()),
      "http://verapdf:8080/api/validate/3b"
    );
  }

  #[test]
  fn reduces_compliant_verapdf_report() {
    let raw = serde_json::json!({
      "report": {
        "jobs": [{
          "validationResult": {
            "profileName":"PDF/A-2b validation profile", "isCompliant": true,
            "details": { "failedRules": 0 }
          }
        }]
      }
    });
    let report = reduce_verapdf_report(&raw, PdfaProfile::Pdfa2b.into());
    assert!(report.passed);
    assert!(report.failures.is_empty());
  }

  #[test]
  fn reduces_negative_verapdf_report_to_failures() {
    let raw = serde_json::json!({
      "report": {
        "jobs": [{
          "validationResult": [{
            "profileName":"PDF/A-2b validation profile", "isCompliant": false,
            "details": { "failedRules": 3 }
          }]
        }]
      }
    });
    let report = reduce_verapdf_report(&raw, PdfaProfile::Pdfa2b.into());
    assert!(!report.passed);
    assert_eq!(report.failures, vec!["job 1 failed PDF validation (failedRules=3)"]);
  }

  #[test]
  fn rejects_missing_malformed_and_conflicting_validation_results() {
    let invalid = [
      serde_json::json!({}),
      serde_json::json!({"failedRules": 0}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": null}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": "true"}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "compliant": 1}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "compliant": false}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "compliant": null}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": false, "compliant": true}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "failedRules": 1}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "details": {"failedRules": 1}}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "failedRules": 0, "details": {"failedRules": 1}}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "failedRules": 1, "details": {"failedRules": 0}}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "details": null}),
      serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant": true, "details": []}),
      serde_json::json!(null),
      serde_json::json!(true),
      serde_json::json!([]),
    ];
    for result in invalid {
      let raw = serde_json::json!({"report":{"jobs":[{"validationResult":[{"profileName":"PDF/A-2b validation profile", "isCompliant":true},result]}]}});
      let report = reduce_verapdf_report(&raw, PdfaProfile::Pdfa2b.into());
      assert!(!report.passed, "valid sibling must not hide invalid result: {raw}");
      assert!(!report.failures.is_empty());
    }
    for field in ["failedRules", "passedRules"] {
      for value in [
        serde_json::json!(null),
        serde_json::json!("0"),
        serde_json::json!(-1),
        serde_json::json!(0.5),
        serde_json::json!(true),
        serde_json::json!([]),
        serde_json::json!({}),
      ] {
        for nested in [false, true] {
          let mut result = serde_json::json!({"profileName":"PDF/A-2b validation profile", "isCompliant":true});
          if nested {
            result["details"] = serde_json::json!({field:value});
          } else {
            result[field] = value.clone();
          }
          let raw = serde_json::json!({"report":{"jobs":[{"validationResult":result}]}});
          assert!(
            !reduce_verapdf_report(&raw, PdfaProfile::Pdfa2b.into()).passed,
            "malformed supplied counter: {raw}"
          );
        }
      }
    }
  }
}
