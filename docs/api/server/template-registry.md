# Template Registry administration via API

[Documentation](../../README.md) / [API](../README.md) / [Server API](./README.md)

Automate template imports, publication, workspace assignments and reconciliation
through the existing GraphQL interface. For normal administration and operating
procedures, use the [Template Registry guide](../../ops/integrations/template-registry.md).

Send requests to `POST /graphql` with the server’s normal authentication and
CSRF handling. Administrative operations require the relevant administrator
permissions; workspace suggestions use the caller’s workspace access.

<details>
<summary>On this page</summary>

- [Import a bundle](#import-a-bundle)
- [Export a workspace template source](#export-a-workspace-template-source)
- [Publish a revision](#publish-a-revision)
- [Assign a workspace template](#assign-a-workspace-template)
- [Apply a manual update](#apply-a-manual-update)
- [Inspect workspace instances](#inspect-workspace-instances)
- [Trigger a drift scan](#trigger-a-drift-scan)
- [Inspect jobs](#inspect-jobs)
- [Discover available templates](#discover-available-templates)

</details>

## Import a bundle

Send the archive as a GraphQL multipart upload with the `file` variable. The result contains the catalog entry, revision and validation warnings.

```graphql
mutation ImportTemplate($file: Upload!) {
  admin {
    importTemplate(file: $file) {
      entry {
        id
        slug
        status
      }
      revision {
        id
        version
        state
      }
      warnings {
        code
        message
        severity
      }
    }
  }
}
```

The revision projection includes nullable `manifest` JSON with the file-owned
locale variants, `title_policy` and `purpose`. `checksum` continues to identify
the standard `content.template.zip` payload. The same-version check also covers
the manifest and every declared locale checksum; identical standard bytes do
not permit a changed alternative language. Normal bundle export preserves all
language payloads.

The same `importTemplate(file:)` operation also accepts an onboarding guide
package. For packages, `entry` and `revision` are null; `documents` lists the
actual persisted child entries/revisions, `package` contains the delivery
manifest and `jobId` identifies its import report. Children are validated as a
whole package and published through the normal revision lifecycle. Check the
nullable `error` field: a persistence/publication failure returns the children
already saved, rather than claiming an atomic rollback. Retry the same ZIP to
reuse those immutable revisions and finish the remaining children. Single
document imports retain their existing entry, revision and validation behavior.

Guide revisions have `purpose=guide`, ordinary document attribution and
`seed_once` delivery. They are excluded from template suggestions and Database
row-template bindings independently of category. The existing explicit
`applyTemplateManualUpdate` action can install a new ordinary guide copy from
an enabled seed-once assignment, including its current revision. Earlier reader
copies are preserved; the new copy selects the current document-default language.

## Export a workspace template source

`POST /api/admin/templates/workspace-source/export` downloads a canonical native
document bundle directly from an existing workspace template. It uses normal
Admin authentication and CSRF handling, plus the caller's current workspace,
document and referenced-file read permissions. It does not require a Registry
revision or import, publish, assign or modify the source.

Read eligible sources with `admin.workspaceTemplateSources` and send their native
document keys. On download, the server reads the current committed content,
titles, template eligibility and presentation for all selected sources in one
read-only repeatable-read transaction:

```json
{
  "workspaceId": "<workspace-uuid>",
  "source": {
    "docId": "<native-document-key>"
  },
  "metadata": {
    "templateId": "project-responsibilities",
    "version": "1.0.0",
    "title": "Project responsibilities",
    "locale": "en",
    "category": "building-blocks",
    "tags": ["project"],
    "titlePolicy": "template"
  },
  "localizedSources": []
}
```

Optional `description`, ordinary `category`, `tags` and `titlePolicy` use the
existing document manifest rules. Purpose is `template` and kind is `page`.
Each optional `localizedSources` item has a distinct `locale` and a `source`
selection containing its native `docId`, in the selected workspace. These are
existing authored language alternatives; export never translates content.

A successful response is `application/zip`, with an attachment filename,
`Cache-Control: no-store`, `x-template-export-container-sha256` for the returned
ZIP and `x-template-export-content-sha256` for its `content.template.zip`.
The JSON request is limited to 64 KiB; output and native resources obey the
existing configured archive limits. Unknown request fields are rejected.

The download captures the current server state; discovery revisions are
informational and impose no client preconditions. A source-scoped access loss returns `404` with
`SOURCE_UNAVAILABLE`; it does not invalidate an otherwise valid Admin session.
Invalid metadata, language mappings or unsupported content return `422`, and
archive limit failures return `413`. Failure responses contain no download.
The existing `GET /api/admin/templates/export/{revision_id}` remains available
for Published/Deprecated Registry revisions.

## Publish a revision

Publish the intended validated revision before assigning it to a workspace.

```graphql
mutation PublishRevision($revisionId: ID!) {
  admin {
    publishRevision(revisionId: $revisionId) {
      id
      templateId
      version
      state
      publishedAt
      manifest
    }
  }
}
```

## Assign a workspace template

Use `Published` for the current published revision, or `PinnedRevision` with `selectedRevisionId` for an eligible fixed revision. Provisioning values are `SeedOnce`, `ManagedUntilLocalEdit` and `ManualUpdate`.

```graphql
mutation AssignTemplate($workspaceId: String!, $templateId: ID!, $provisioningMode: ProvisioningModeType!, $selectionMode: SelectionModeType!, $selectedRevisionId: ID) {
  admin {
    assignTemplateToWorkspace(workspaceId: $workspaceId, templateId: $templateId, provisioningMode: $provisioningMode, selectionMode: $selectionMode, selectedRevisionId: $selectedRevisionId) {
      id
      workspaceId
      templateId
      provisioningMode
      selectionMode
      selectedRevisionId
      isEnabled
    }
  }
}
```

## Apply a manual update

An explicit manual update checks the live source for conflicts. A failed or conflicting update retains its previous content and revision.

```graphql
mutation ApplyTemplateManualUpdate($workspaceId: String!, $templateId: ID!, $revisionId: ID!) {
  admin {
    applyTemplateManualUpdate(workspaceId: $workspaceId, templateId: $templateId, revisionId: $revisionId) {
      id
      revisionId
      state
      lastErrorCode
      lastErrorMessage
    }
  }
}
```

## Inspect workspace instances

Read the workspace instances and their current reconciliation state before deciding whether to retry or update.

```graphql
query WorkspaceTemplateInstances($workspaceId: String!) {
  admin {
    workspaceTemplateInstances(workspaceId: $workspaceId) {
      id
      templateId
      revisionId
      workspaceDocId
      state
      lastSyncedAt
      lastErrorCode
      lastErrorMessage
    }
  }
}
```

## Trigger a drift scan

Trigger the authenticated scan for one workspace; regular scans still follow the configured interval.

```graphql
mutation AdminTriggerDriftScan($workspaceId: String!) {
  admin {
    triggerDriftScan(workspaceId: $workspaceId)
  }
}
```

## Inspect jobs

Read a bounded page of import and reconciliation jobs, including their timestamps and result summaries.

```graphql
query TemplateJobs {
  admin {
    templateJobs(skip: 0, take: 50) {
      id
      jobType
      state
      templateId
      workspaceId
      startedAt
      finishedAt
      summaryJson
    }
  }
}
```

## Discover available templates

This read-only workspace projection returns suggestions filtered by the caller’s access. It does not copy content or queue reconciliation.

```graphql
query TemplateSuggestions($workspaceId: String!, $input: TemplateSuggestionInput!) {
  workspace(id: $workspaceId) {
    templateSuggestions(input: $input) {
      items {
        slug
        title
        templateDocId
        available
        reasons
        instanceState
      }
      emptyDocumentAllowed
      reconcileRequired
      stale
      hasNextPage
      endCursor
    }
  }
}
```

Suggested discovery variables:

```json
{
  "workspaceId": "<workspace-id>",
  "input": {
    "surface": "AllPagesNewPage",
    "locale": "en",
    "clientVersion": 1,
    "first": 8,
    "after": null
  }
}
```

Follow `endCursor` when `hasNextPage` is true. Invalid cursors return
`MIX_TEMPLATE_SUGGESTIONS_INPUT_INVALID`; restart discovery from the first page.
See the [suggestion states](../../ops/integrations/template-registry.md#contextual-template-suggestions)
for the corresponding operator actions.
