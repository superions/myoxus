# User preferences operations

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

User preferences are authoritative in PostgreSQL table `user_preferences`.
Redis and Yjs are not preference stores. Client caches may contain offline
pending intent, but the server never reads them.

<details>
<summary>On this page</summary>

- [Health and diagnosis](#health-and-diagnosis)
- [Common incidents](#common-incidents)
- [Backup, restore and privacy](#backup-restore-and-privacy)
- [Restore and rollback](#restore-and-rollback)

</details>

## Health and diagnosis

Inspect one account without logging unrelated personal values:

```sql
SELECT user_id, updated_at, jsonb_object_length(values) AS override_count
FROM user_preferences
WHERE user_id = '<user-uuid>';
```

Check structural validity and unexpected top-level keys:

```sql
SELECT user_id, key
FROM user_preferences, LATERAL jsonb_object_keys(values) AS key
WHERE key NOT IN (
  'locale', 'defaultDocumentLanguage', 'timezone', 'dateFormat', 'timeFormat',
  'receiveInvitationEmail', 'receiveMentionEmail', 'receiveCommentEmail',
  'notifyCreatedDocuments', 'savedSetups',
  'journalFirstDayOfWeek', 'journalShowCalendarWeeks', 'colorMode',
  'showLinkedDocuments', 'imageAntialiasing',
  'noisyBackground', 'editorFontFamily', 'editorCustomFontFamily',
  'editorFontSize', 'newDocumentMode', 'fullWidthLayout',
  'openDocumentMode', 'edgelessDefaultTheme', 'telemetryEnabled',
  'aiModelId', 'aiReasoningEnabled',
  'documentMetadataHeaderVisibility', 'workbenchToolLayouts',
  'workspaceDashboardLayouts', 'assistanceMode',
  'workspaceAssistanceOverrides', 'projectAssistanceOverrides'
);
```

An API validation error means the complete aggregate failed the application
contract; do not edit JSON to bypass it. Diagnose the rejected field, correct
the caller and use `updatePreferences` to set or reset it.

## Common incidents

### A change works offline but does not reach another device

1. Confirm the browser is authenticated to the expected server and account.
   Inspect the active `GlobalContext.serverId`; do not assume the built-in
   default server while a self-hosted workspace is open.
2. Inspect browser console/network errors for `updatePreferences`.
3. Confirm the SQL row `updated_at` advances after reconnect.
4. Re-focus or reload the client; focus triggers revalidation and pending
   retry. Do not clear site data before preserving evidence of pending intent.

### Locale or color mode appears to revert

Read `values` and `effectiveValues` through GraphQL. A null/missing raw value
means inheritance, not data loss. Check the server locale and Journal defaults
before forcing an override. Browser-language and system-color values are
transient defaults only until the account cache is available.

For regional display incidents, validate that `timezone` is an IANA identifier
and inspect `dateFormat`/`timeFormat` separately. Missing format overrides mean
locale-derived formatting; missing timezone means the current server default.
Changing a user's default document language affects newly created documents,
not existing document metadata.

### A theme selection does not apply to the personal workspace

Theme choice is not stored in `user_preferences`; there is no user-level
`themeSlug`. The selected existing catalog theme belongs only to the canonical
personal workspace. Verify that workspace:

```sql
SELECT id, owner_user_id, is_personal_workspace
FROM workspaces
WHERE id = '<workspace-uuid>';
```

The user-facing GraphQL operations reject Shared and additional UserOwned
and foreign workspaces even when the caller has an owner role. For a valid
personal workspace, inspect the explicit override without logging unrelated
preferences:

```sql
SELECT profile.workspace_id, theme.slug, profile.updated_at
FROM theme_profiles profile
JOIN themes theme ON theme.id = profile.theme_id
WHERE profile.scope = 'workspace'
  AND profile.workspace_id = '<workspace-uuid>';
```

No row means intentional global inheritance. After selecting or resetting a
theme, verify that
`/api/branding/theme.css?workspaceId=<workspace-uuid>` returns the expected
projection and that the browser received the `myoxus-branding` /
`branding-updated` refresh. Change the workspace theme through the existing
appearance settings.

### Telemetry remains enabled after opt-out

Verify each active auth cache and preference cache share the same server and
user key. Before active-server resolution, any locally authenticated account's
`pendingPatch.telemetryEnabled=false` must win over confirmed values; afterward
the reactive active-server projection applies. Never copy a cache record
between accounts.

### Preference row is absent

Absence is valid and resolves entirely to defaults. The first concrete patch
creates the row. Do not pre-materialize defaults for every user.

### Assistance differs between people or contexts

This is personal state. Read `currentUser.preferences.assistance` for the
actual Workspace and optional ordinary Project. Project overrides precede
Workspace overrides and the user default. Workspace Tasks has no Project
override. Reset removes only the selected scope and restores inheritance.
Current accepted membership and current same-Workspace Project ownership are
required even when an old preference cache exists.

Assistance choices require a confirmed save. A failed request leaves the last
confirmed mode active and is not queued for offline activation. Selecting
Automatic alone enables no recipe or action. Missing preferences resolve to
Manual; an initial Guided offer in creation is not evidence of a stored mode.
Do not repair a denied scope by editing JSON or copying another person's cache.

### A saved setup is unavailable or differs from an earlier application

Saved setups belong only to the authenticated account. Check that the client
uses the intended server and account before inspecting its selections. They
contain package/source references and supported nonprivate defaults, not
working data or executable manifests.

Resolving a saved selection uses current offerings. A withdrawn package,
unavailable published document, removed input or changed workflow is reported
for explicit recovery or clearing. Do not repair this by pinning an old
managed schema, editing preference JSON or copying another user's cache.
Existing accepted applications and edited working copies keep their own
identities and versions. Saving a configuration alone creates no Workspace,
Project, document, run or automatic opt-in.

### Workbench tools revert, appear under another account, or stay pending

1. Query both `values.workbenchToolLayouts` and
   `effectiveValues.workbenchToolLayouts`. `null` is the valid missing-override
   state; it is not a server-side default list.
2. Confirm that each entry has one unique Workspace/view-family scope and that
   collapsed tools are visible and visible tools are ordered. The API rejects
   the complete patch if any entry is invalid.
3. Inspect the active `(serverId, userId)` before examining the client cache.
   Never copy or merge preference cache records across those scopes.
4. A `pending` projection after a network failure is intentional. Restore
   connectivity and refocus the client to trigger revalidation and one merged
   retry. Check the GraphQL response and SQL `updated_at`; do not clear browser
   storage before preserving the pending payload as diagnostic evidence.
5. Reset through `updatePreferences(workbenchToolLayouts: null)`. Direct JSONB
   edits bypass validation and can make the full aggregate unreadable.

Support output may record the account ID, server ID, Workspace ID, view family,
sync status and update timestamp. It must not log the complete preference JSON
or unrelated personal settings.

### A dashboard layout reverts, leaks across accounts, or remains pending

1. Query `values.workspaceDashboardLayouts` and
   `effectiveValues.workspaceDashboardLayouts`. `null` means no explicit
   override; the five product defaults are intentionally not materialized.
2. Confirm the affected entry has a unique Workspace UUID, no duplicate
   dashlet/size IDs and no `Compact` override for Today, Reminders or Activity.
   An invalid entry rejects the complete preference candidate.
3. Inspect the active `(serverId, userId)` cache scope. A layout is personal to
   that account even when its Workspace is Shared; never copy a pending cache
   record between accounts or servers.
4. Restore connectivity and use the edit-mode Retry action or refocus the
   client. Pending state is retained until the API acknowledges the merged
   patch.
5. Reset one Workspace through the product action. It sends the other entries
   unchanged, or `workspaceDashboardLayouts: null` only when no entries remain.
   Do not repair the list with direct JSONB edits.

Local Electron Workspaces deliberately have no Dashboard-layout writer.
Support output may include account/server/Workspace IDs, sync status and
`updated_at`, but never the complete ordered layout or unrelated preferences.

## Backup, restore and privacy

Normal PostgreSQL backup/restore includes `user_preferences`; there is no Redis
or Yjs preference backup. Restore users before preferences so the foreign key
is satisfied. Treat `values` as personal data. Logs and support bundles should
record user ID, operation, error category and update timestamp, not the full
JSON payload.

For account deletion, the foreign key removes the row via `ON DELETE CASCADE`.
Client caches are account-scoped and become unreachable after logout; native
clients should remove application storage during an explicit local-data wipe.

## Restore and rollback

The authoritative aggregate is the current `user_preferences` row. Roll back
preferences only as part of the matching PostgreSQL and application restore;
do not create a second settings table or client-to-server write path in a
running deployment.
