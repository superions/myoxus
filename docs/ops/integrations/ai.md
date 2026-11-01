<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# AI and Copilot

[Documentation](../../README.md) / [Operations](../README.md) / [Integrations](./README.md)

AI features are optional. Myoxus starts without a provider and reports provider
unavailability through the consuming feature. Enabling a provider is a data
governance and operational decision because document content may cross the
provider boundary.

<details>
<summary>On this page</summary>

- [Decide before enabling](#decide-before-enabling)
- [Components](#components)
- [Example provider](#example-provider)
- [Embeddings](#embeddings)
- [Verify and disable](#verify-and-disable)
- [Configure in Admin](#configure-in-admin)

</details>

## Decide before enabling

- Which workspaces may send content to an external provider?
- Which provider endpoints and model identifiers are approved?
- Where are cost, quota, and rate limits enforced? Myoxus does not replace the
  provider's budget controls.
- Is semantic search required? It needs an embedding endpoint and pgvector.
- Who rotates provider credentials and verifies disablement?

## Components

| Component        | Configuration                              | Role                                          |
| ---------------- | ------------------------------------------ | --------------------------------------------- |
| Chat providers   | `copilot.providers.*`                      | Response generation and assistant features    |
| Default provider | `copilot.default_provider`                 | First provider selected for requests          |
| Fallback chain   | `copilot.fallback_providers`               | Ordered alternatives after a provider failure |
| Embeddings       | `copilot.embedding.*`                      | Semantic search and retrieval context         |
| Worker queues    | `job.queues.copilot`, `job.queues.indexer` | Asynchronous processing                       |
| pgvector         | PostgreSQL extension                       | Vector persistence and search                 |

## Example provider

```yaml
copilot:
  enabled: true
  default_provider: "openai"
  providers:
    openai:
      enabled: true
      kind: "openai"
      endpoint: "https://api.openai.com/v1"
      # Inject MYOXUS__COPILOT__PROVIDERS__OPENAI__API_KEY from the
      # deployment's protected secret mechanism.
      models: ["gpt-4.1", "gpt-4o-mini"]
```

A local OpenAI-compatible endpoint uses `kind: "local"` and its internal URL.
Keep external credentials in the supported secret store rather than the
committed YAML file.

## Embeddings

```yaml
copilot:
  embedding:
    endpoint: "https://api.openai.com/v1"
    # Inject MYOXUS__COPILOT__EMBEDDING__API_KEY separately when needed.
    model: "text-embedding-3-small"
    dimensions: 1536
    batch_size: 20
```

Without an embedding endpoint, embedding-backed results remain unavailable;
ordinary full-text search can continue. A model or dimension change requires a
deliberate re-embedding run. Follow [Copilot embeddings](./copilot-embeddings.md).

## Verify and disable

1. Confirm `/ready` passes and pgvector is present in the server startup checks.
2. Open **Admin → AI → Copilot**, configure the approved provider and save
   the Copilot group. This page configures providers; it has no inference test
   action.
3. Inspect Copilot and worker signals without logging prompts or credentials.
4. Exercise one approved feature with synthetic content.
5. To disable the integration, turn off Copilot and the providers, restart
   when the changed setting requires it, and prove the external endpoint
   receives no further request.

Provider keys are secrets. Never include them in screenshots, logs, support
bundles, or audit metadata.

## Configure in Admin

Cloud, local and custom providers expand individually. The heading shows the
actual configured protocol and enablement; the masked key field separately
reports whether a credential is configured. Enablement does not prove endpoint
availability. File-only settings remain read-only.

Add model identifiers with Enter or a comma. Duplicates are rejected without
changing order; the first model is the default. Removing that model makes the
next identifier first. Choosing a different provider kind may replace its
endpoint after confirmation; cancelling leaves the draft unchanged.

The separate embedding panel owns its endpoint, credential, model and dimensions.
Timeouts and dimensions use numeric controls. Invalid numeric input blocks Save
without discarding the entered value. Closing a panel or switching AI tabs keeps
the draft. Cancel explicitly restores the saved configuration.

Provider edits are saved as one complete provider map, preserving untouched
providers and keys. A rejected Save retains the draft and shows the server's
error next to changed providers instead of expanding every provider. A successful
Save refreshes the authoritative configuration. Saving locks mutations until
that operation finishes. No provider request is sent by opening its editor.

Copilot starts with its activation and default/fallback routing. The fallback
list uses the same ordered tag input as provider models. Request and model
defaults expand separately; the transcription field retains its existing
configuration contract. Storage uses the shared blob backend and an editable
prefix. Optional external services expand together and keep credentials masked.
Browser login autofill is excluded from technical configuration fields.

Indexer shows activation before its expandable provider details. MCP has its
own activation field. Each tab saves or cancels only its configuration group;
the unsaved-change indicator belongs to that group. Switching tabs or closing
details preserves drafts, including invalid numeric input. Server field errors
open the affected details. File-only values remain non-editable, and an active
Save locks the group's controls until its request finishes.
