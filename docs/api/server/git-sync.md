# Git Sync via API

[Documentation](../../README.md) / [API](../README.md) / [Server API](./README.md)

Create and inspect Git Sync profiles, runs, conflicts and file bindings through
the existing authenticated workspace and Admin operations.

For request handling, see [Calling GraphQL](./README.md#calling-graphql).
For validation, state transitions and recovery, use the
[operator guide](../../ops/integrations/git-sync.md).

<details>
<summary>On this page</summary>

- [Create a Profile (via GraphQL)](#create-a-profile-via-graphql)
- [Repository manifest contract](#repository-manifest-contract)
- [Manual Sync](#manual-sync)
- [Viewing Conflicts](#viewing-conflicts)
- [Resolving Conflicts](#resolving-conflicts)
- [Configure via Admin GraphQL](#configure-via-admin-graphql)
- [GraphQL Inspection](#graphql-inspection)
- [Git Sync File Conflicts](#git-sync-file-conflicts)

</details>

## Create a Profile (via GraphQL)

```graphql
mutation CreateGitSyncProfile($workspaceId: String!, $input: GitSyncProfileInput!) {
  createGitSyncProfile(workspaceId: $workspaceId, input: $input) {
    id
    enabled
  }
}
```

## Repository manifest contract

The existing schema-1 `.myoxus/git-sync-manifest.json` retains its document and
folder identities. Its workspace record and each folder record may additionally
contain `overview: { repoPath, contentHash }`. Output paths and hashes describe the
materialized Git result, including verified retained paths in partial runs.
Overview-only changes participate in the same guarded commit without adding
document counts, bindings or SQL path-ledger entries. Missing values are omitted,
including unchanged legacy roundtrips. These descriptors are derived output,
not API document IDs, bindings or additional document counters. Invalid or
colliding ownership fails preflight; it does not grant access to workspace
content. This is a repository-output contract, not a new GraphQL endpoint.

## Manual Sync

```graphql
mutation {
  triggerGitSync(workspaceId: "...") {
    id
    status
  }
}
```

## Viewing Conflicts

```graphql
query {
  workspace(id: "...") {
    gitSyncStatus {
      openConflicts
    }
    gitSyncConflicts {
      id
      repoPath
      conflictType
      myoxusContent
      gitContent
    }
  }
}
```

## Resolving Conflicts

```graphql
mutation {
  resolveGitSyncConflict(
    input: {
      conflictId: "..."
      resolution: MyoxusWins # or GitWins, ManualMerge, Dismissed
      mergedContent: "..." # only for ManualMerge
    }
  )
}
```

## Configure via Admin GraphQL

```graphql
mutation UpdateGitSyncMimePolicy($updates: [UpdateAppConfigInput!]!) {
  admin {
    adminUpdateConfig(updates: $updates) {
      applied
      fieldErrors {
        path
        message
      }
    }
  }
}
```

## GraphQL Inspection

```graphql
query GitSyncFileState($workspaceId: String!) {
  workspace(id: $workspaceId) {
    gitSyncStatus {
      openConflicts
      openDocConflicts
      openFileConflicts
      totalBindings
      totalDocBindings
      totalFileBindings
    }
    gitSyncFileConflicts {
      id
      bindingId
      blobKey
      repoPath
      conflictType
      resolution
      gitHash
      myoxusHash
      baselineHash
    }
    gitSyncFileBindings {
      id
      blobKey
      repoPath
      contentHash
      mimeType
      fileSize
      tombstoned
    }
  }
}
```

```graphql
mutation ResolveFileConflict($input: ResolveFileConflictInput!) {
  resolveGitSyncFileConflict(input: $input)
}
```

## Git Sync File Conflicts

```graphql
query {
  workspace(id: "...") {
    gitSyncFileConflicts(resolved: false) {
      id
      repoPath
      conflictType
      resolution
    }
  }
}
```

```graphql
mutation {
  resolveGitSyncFileConflict(input: { conflictId: "...", resolution: MyoxusWins })
}
```
