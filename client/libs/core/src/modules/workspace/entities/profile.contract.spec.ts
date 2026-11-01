// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("workspace profile contracts", () => {
  test("passes workspace metadata to profile providers", () => {
    const provider = readRepoFile(
      "client/libs/core/src/modules/workspace/providers/flavour.ts",
    );
    const profile = readRepoFile(
      "client/libs/core/src/modules/workspace/entities/profile.ts",
    );

    expect(provider).toContain("metadata: WorkspaceMetadata");
    expect(profile).toContain(
      "provider.getWorkspaceProfile(this.props.metadata, signal)",
    );
  });

  test("uses list metadata for switcher previews without remote root-doc probes", () => {
    const metadata = readRepoFile(
      "client/libs/core/src/modules/workspace/metadata.ts",
    );
    const workspacesQuery = readRepoFile(
      "client/libs/graphql/src/graphql/get-workspaces.gql",
    );
    const cloud = readRepoFile(
      "client/libs/core/src/modules/workspace-engine/impls/cloud.ts",
    );

    for (const field of ["name", "role", "workspaceType"]) {
      expect(metadata).toContain(`${field}?`);
      expect(workspacesQuery).toContain(field);
    }

    expect(cloud).toContain("profileFromMetadata");
    expect(cloud).toContain("GraphQL payload already carries authoritative");
    expect(cloud).toContain("metadata.initialized === false");
    expect(cloud).not.toContain("StaticCloudDocStorage");
    expect(cloud).not.toContain("cloudStorage.getDoc(id)");
  });
});
