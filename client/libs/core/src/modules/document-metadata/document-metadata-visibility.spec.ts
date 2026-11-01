import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { shouldShowDocumentMetadata } from "./visibility";

describe("document metadata visibility", () => {
  test.each([
    {
      name: "server-backed document",
      input: { workspaceFlavour: "myoxus-cloud" },
      expected: true,
    },
    {
      name: "local demo/offline document",
      input: { workspaceFlavour: "local" },
      expected: false,
    },
    {
      name: "unknown workspace context",
      input: { workspaceFlavour: null },
      expected: false,
    },
    {
      name: "journal document",
      input: { workspaceFlavour: "myoxus-cloud", isJournal: true },
      expected: false,
    },
    {
      name: "shared document",
      input: { workspaceFlavour: "myoxus-cloud", shared: true },
      expected: false,
    },
  ])("$name", ({ input, expected }) => {
    expect(shouldShowDocumentMetadata(input)).toBe(expected);
  });

  test("editor chrome gates document metadata on the workspace flavour", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/editor/virgultum/doc-editor/lit-adaper.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("shouldShowDocumentMetadata({");
    expect(source).toContain("workspaceFlavour: workspace.flavour");
    expect(source).not.toContain("const showDocumentMetadata = !shared");
  });

  test("editor chrome does not render free workspace properties next to canonical metadata fields", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/editor/virgultum/doc-editor/lit-adaper.tsx",
      ),
      "utf8",
    );

    expect(source).not.toContain("WorkspacePropertiesTable");
    expect(source).not.toContain("showWorkspacePropertiesTable");
    expect(source).not.toContain("displayDocInfo");
    expect(source).not.toContain("{!shared && displayDocInfo ? (");
  });

  test("editor chrome links canonical metadata defaults to workspace document settings", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/editor/virgultum/doc-editor/lit-adaper.tsx",
      ),
      "utf8",
    );

    expect(source).toMatch(
      /useGuard\(\s*"Workspace_Settings_Update"\s*,?\s*\)/,
    );
    expect(source).not.toMatch(
      /useGuard\(\s*"Workspace_Properties_Update"\s*,?\s*\)/,
    );
    expect(source).toContain("WorkspaceDialogService");
    expect(source).toContain(
      'workspaceDialogService.open("workspace-settings"',
    );
    expect(source).toContain('activeTab: "workspace:documents"');
    expect(source).not.toContain('activeTab: "workspace:properties"');
    expect(source).toContain("canConfigureWorkspaceDefaults={");
    expect(source).toContain("onConfigureWorkspaceDefaults={");
  });

  test("editor chrome exposes global policy navigation only through the admin feature gate", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/editor/virgultum/doc-editor/lit-adaper.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("UserFeatureService");
    expect(source).toContain("userFeature.isAdmin$");
    expect(source).toContain('"/adminfrontend/documents?tab=metadata"');
    expect(source).toContain("canOpenGlobalPolicy={Boolean(isMyoxusAdmin)}");
    expect(source).toContain("onOpenGlobalPolicy={onOpenGlobalDocumentPolicy}");
    expect(source).not.toContain("Workspace_Administrators_Manage");
  });

  test("mobile doc info sheet reuses the native document metadata provider", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "client/libs/core/src/mobile/components/doc-info/doc-info.tsx",
      ),
      "utf8",
    );

    expect(source).toContain("DocumentMetadataProvider");
    expect(source).toContain("DocumentMetadataDetails");
    expect(source).toContain("shouldShowDocumentMetadata({");
    expect(source).toContain(
      "workspaceFlavour: workspaceService.workspace.flavour",
    );
    expect(source).toContain("isJournal: Boolean(journalDate)");
    expect(source).not.toContain("WorkspacePropertyRow");
    expect(source).not.toContain("DocDatabaseBacklinkInfo");
    expect(source).not.toContain("TimeRow");
    expect(source).not.toContain("documentMetadataQuery");
    expect(source).not.toContain("documentMetadataQuery");
  });
});
