# External transcription

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

Myoxus connects to an operator-configured, OpenAI-compatible speech-to-text
service. Transcription configuration is independent of `copilot.enabled`, chat
providers and their fallback chain. Myoxus ships no speech server, model,
model cache or default destination. Audio is processed by the configured
external service; its infrastructure and operating costs belong to the operator.

## Configuration

Open **AI → Transcription** at `/adminfrontend/ai?tab=transcription`, including
when Copilot is disabled. Set activation, external API base URL and model;
enter an optional API key or language hint. Expand **Technical limits** to edit
the server-defined bounds. **Save** persists the changed group and displays the
effective server readback. **Cancel** discards edits. Reloading the route reads
the same persisted configuration.

The saved key is never shown. Leave its protected input blank to retain it,
enter a replacement to save it with the other changes, or select **Remove saved
API key override** to release its database override. A deployment-provided key
may remain effective after removal. Cancel clears an entered replacement;
successful save clears it after masked readback. Rejected saves retain the input
for correction. An empty language hint likewise restores its configured baseline.
Read-only fields retain the shared deployment write-policy explanation.

All `transcription.*` fields are registered in the existing Admin configuration
contract (`adminConfigSchema`, `adminConfigValues` / `adminUpdateConfig`). Activation defaults to `false`.
Enabling requires an explicit endpoint and model; the external service does not
have to be reachable to save, correct or disable settings. Existing deployment
locks and source/read-only explanations apply.

Set `transcription.endpoint` to the API **base URL**, such as an operator-owned
`https://speech.example.com/v1`. The adapter appends `/audio/transcriptions`
once. Do not supply the complete operation URL. Credentials in the URL, query
parameters and fragments are rejected. Use the protected optional
`transcription.api_key` field for bearer authentication. It is masked in Admin
readback and never appears in ordinary client capability responses.

`transcription.model` is the service's model identifier, without an assumed
provider or default. `transcription.language` is an optional language hint.
The technical limits and their ranges are listed in the
[configuration reference](../configuration/reference.md#transcription).
A request timeout bounds the entire request, including transport retries and
response reading. Input and response sizes and simultaneous speech requests are
bounded. Duration is checked when the service reports it; an unknown duration
is not invented. The shared admission counter survives live adapter replacement.

Settings use the existing DB, YAML/ENV and protected secret-file paths. A
canonical DB override wins over YAML/ENV under the normal configuration rules.
Explicit `copilot.transcription_model` values are accepted only as an ingress
alias: an explicit new model key wins, including a new YAML/ENV model over an
old DB-only alias. Otherwise the legacy value becomes `transcription.model`.
The next ordinary canonical configuration write retires the old DB row.
Migration never enables transcription or selects a destination from chat.
A safe deprecation message identifies the key without its value.

For deployments using files, `MYOXUS__TRANSCRIPTION__API_KEY_FILE` is the
allowlisted protected secret source. YAML/ENV layering, DB override precedence
and source projection follow the [configuration guide](../configuration/README.md).
No YAML or environment edit is required for ordinary Admin-contract setup.

## Explicit connection check

The tab shows server activation, configuration completeness and the last
connection check separately. **Check connection** uses the saved endpoint,
model, optional key, timeout, response limit and shared concurrency admission.
Save or Cancel pending edits before checking. Complete settings can be checked
while recognition is disabled. Reading status never contacts the provider;
there is no periodic probe. Changing effective configuration clears its result.

The server sends authenticated `GET /models` through the same TLS client as
speech requests. HTTP 404/405 means that the optional catalog check is not
supported. A normal OpenAI model list can establish whether the configured
identifier appears in that response; an ambiguous response leaves it unverified.
Neither case proves speech support, loading or successful recognition. The
first actual audio job validates the configured model. No check is required
to save, enable or use a complete configuration.

Actual HTTP authentication failures, TLS certificate causes and deadlines
appear as normal sanitized provider errors. Error bodies and keys are excluded.
Repair the saved key, endpoint, server trust or limit as appropriate to the
observed error, save, then check again. No separate error categories or logging
reports are introduced.

## Transport and trust

The external API accepts multipart `POST /audio/transcriptions` with encoded
audio, the configured model, `response_format=verbose_json` and an optional
language hint. JSON responses contain `text`, optionally `language`, `duration`
and `segments` with `text`, `start`, `end` and optional `speaker`. Text-only
responses stay usable; missing speakers or timestamps do not discard text or
create invented metadata.

HTTPS uses the server's shared `tls.additional_ca_bundle_path` and normal
certificate verification. A trust change requires restarting the consuming
process. Intentionally configured internal HTTP endpoints are supported.
Redirects are disabled, so audio and bearer credentials are never forwarded to
a redirect destination. Error bodies are not read into diagnostics. Existing
server logging records ordinary request failures and safe HTTP status/size
information, without audio, transcripts or credentials.

## Client capability

`serverConfig.transcription` exposes activation, completeness, input/duration
limits and one sanitized status: `DISABLED`, `UNCONFIGURED`, `NOT_CHECKED`,
`AVAILABLE` or `UNAVAILABLE`. It exposes no endpoint or secret to ordinary
clients. A complete enabled but untested configuration permits the first
request; no successful preflight is required. The last observed transport
outcome belongs only to the current configuration. Live configuration changes
invalidate it, and unchanged recovery polling preserves it. Backend failure
does not prevent the main API from starting or serving other features.

This configuration contract alone does not certify real model execution or a
completed recording-to-transcript GUI journey.

Optional summaries and suggested action items are separate from speech processing.
They require an explicit action and independently enabled/configured Copilot plus
workspace permission. Transcribing, restoring or reading an attachment does not
request generation. The audio player retains transcript, playback and previously
stored optional output after a generative failure or Copilot deactivation. See the
[Copilot operations runbook](./copilot-embeddings.md#transcription) for the
separately configured generative destination. Action items are suggestions, not
automatically created tasks.
