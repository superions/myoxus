// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

import { injectSessionCookies } from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  smokeGql,
  waitForWorkspaceReady,
} from "../../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const FIXTURE_ROOT = path.join(
  process.cwd(),
  "build/fixtures/markdown/obsidian-vault",
);

async function vaultZip(): Promise<Buffer> {
  const archive = new JSZip();
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else {
        archive.file(
          path.relative(FIXTURE_ROOT, absolute).replaceAll(path.sep, "/"),
          await readFile(absolute),
        );
      }
    }
  };
  await visit(FIXTURE_ROOT);
  return archive.generateAsync({ type: "nodebuffer" });
}

async function expectVaultSemantics(archiveBytes: Buffer) {
  const archive = await JSZip.loadAsync(archiveBytes);
  expect(archive.file("myoxus-export-report.json")).not.toBeNull();
  const note = archive.file("Projects/Shared.md");
  expect(note).not.toBeNull();
  const markdown = await note!.async("string");
  expect(markdown).toContain("status: active");
  expect(markdown).toContain("[the person](../People/Shared.md)");
  expect(
    markdown.match(/!\[pixel(?:\.svg)?\]\(\.\.\/media\/pixel\.svg\)/g),
  ).toHaveLength(2);
  expect(markdown).toContain("==Highlighted==");
  expect(markdown).toContain("```mermaid\nflowchart LR\n  A --> B\n```");
  expect(archive.file("media/pixel.svg")).not.toBeNull();
}

test("imports an explicitly selected Obsidian vault through the durable dialog", async ({
  context,
  page,
  request,
}) => {
  const cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  await injectSessionCookies(context, cookies);
  const sourceWorkspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const sourceArchiveName = `obsidian-vault-${runId}.zip`;
  const roundtripArchiveName = `roundtrip-${runId}.obsidian.zip`;
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  let importedWorkspaceId: string | undefined;
  let roundtripWorkspaceId: string | undefined;
  try {
    await page.goto(`${FRONTEND}/workspace/${sourceWorkspaceId}/all`, {
      waitUntil: "load",
    });
    await waitForWorkspaceReady(page, { allDocs: true });
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("add-workspace").click();

    const dialog = page.getByTestId("workspace-import-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("workspace-import-source-obsidian-vault").click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: sourceArchiveName,
      mimeType: "application/zip",
      buffer: await vaultZip(),
    });

    await expect(
      dialog.getByTestId("workspace-import-confirm-changes"),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByTestId("workspace-import-apply")).toBeDisabled();

    // Closing and reopening must reconnect to the same durable preview instead
    // of creating a second upload job.
    await dialog.getByRole("button").first().click();
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("add-workspace").click();
    await expect(
      dialog.getByTestId("workspace-import-confirm-changes"),
    ).toBeVisible();

    await dialog.getByTestId("workspace-import-start-over").click();
    await expect(dialog.getByTestId("workspace-import-upload")).toBeVisible();
    await dialog.getByTestId("workspace-import-source-obsidian-vault").click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: sourceArchiveName,
      mimeType: "application/zip",
      buffer: await vaultZip(),
    });
    await expect(
      dialog.getByTestId("workspace-import-confirm-changes"),
    ).toBeVisible({ timeout: 30_000 });

    await dialog.getByTestId("workspace-import-confirm-changes").check();
    await dialog.getByTestId("workspace-import-apply").click();
    await expect(dialog.getByTestId("workspace-import-open")).toBeVisible({
      timeout: 30_000,
    });
    await dialog.getByTestId("workspace-import-open").click();
    await expect(page).toHaveURL(/\/workspace\/[^/]+\/home$/);
    importedWorkspaceId = page.url().match(/\/workspace\/([^/]+)\/home$/)?.[1];
    if (!importedWorkspaceId)
      throw new Error("import did not navigate to a workspace");
    expect(importedWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);

    await page.goto(`${FRONTEND}/workspace/${importedWorkspaceId}/all`, {
      waitUntil: "load",
    });
    await waitForWorkspaceReady(page, { allDocs: true });
    await expect(page.getByText("Shared", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Empty note", { exact: true })).toBeVisible();
    await expect(page.getByText("Grüße 世界", { exact: true })).toBeVisible();

    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("workspace-navigation-settings").click();
    await page.getByTestId("workspace-setting:storage").click();
    const vaultExport = page.getByTestId("export-obsidian-vault");
    await expect(vaultExport).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      vaultExport.click(),
    ]);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("vault download has no persisted path");
    expect(path.isAbsolute(downloadPath)).toBe(true);
    const exportedVault = await readFile(downloadPath);
    await expectVaultSemantics(exportedVault);

    await page.goto(`${FRONTEND}/workspace/${importedWorkspaceId}/all`, {
      waitUntil: "load",
    });
    await waitForWorkspaceReady(page, { allDocs: true });
    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("add-workspace").click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("workspace-import-source-obsidian-vault").click();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: roundtripArchiveName,
      mimeType: "application/zip",
      buffer: exportedVault,
    });
    await expect(
      dialog.getByTestId("workspace-import-confirm-changes"),
    ).toBeVisible({ timeout: 30_000 });
    await dialog.getByTestId("workspace-import-confirm-changes").check();
    await dialog.getByTestId("workspace-import-apply").click();
    await expect(dialog.getByTestId("workspace-import-open")).toBeVisible({
      timeout: 30_000,
    });
    await Promise.all([
      page.waitForURL((url) => {
        const workspaceId = url.pathname.match(
          /^\/workspace\/([^/]+)\/(?:home|all)$/,
        )?.[1];
        return workspaceId !== undefined && workspaceId !== importedWorkspaceId;
      }),
      dialog.getByTestId("workspace-import-open").click(),
    ]);
    roundtripWorkspaceId = page
      .url()
      .match(/\/workspace\/([^/]+)\/(?:home|all)$/)?.[1];
    if (!roundtripWorkspaceId)
      throw new Error("roundtrip import did not navigate to a workspace");
    expect(roundtripWorkspaceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(roundtripWorkspaceId).not.toBe(importedWorkspaceId);
    await page.goto(`${FRONTEND}/workspace/${roundtripWorkspaceId}/all`, {
      waitUntil: "load",
    });
    await waitForWorkspaceReady(page, { allDocs: true });
    await expect(page.getByText("Shared", { exact: true })).toHaveCount(2);
    await expect(page.getByText("Empty note", { exact: true })).toBeVisible();

    await page.getByTestId("sidebar-workspaces-section").click();
    await page.getByTestId("workspace-navigation-settings").click();
    await page.getByTestId("workspace-setting:storage").click();
    const roundtripExport = page.getByTestId("export-obsidian-vault");
    await expect(roundtripExport).toBeVisible();
    const [roundtripDownload] = await Promise.all([
      page.waitForEvent("download"),
      roundtripExport.click(),
    ]);
    const roundtripDownloadPath = await roundtripDownload.path();
    if (!roundtripDownloadPath)
      throw new Error("roundtrip vault download has no persisted path");
    await expectVaultSemantics(await readFile(roundtripDownloadPath));
    expect(browserErrors).toEqual([]);
  } finally {
    const cleanupIds = new Set(
      [roundtripWorkspaceId, importedWorkspaceId].filter(
        (id): id is string => id !== undefined,
      ),
    );
    // Concurrent development can create unrelated workspaces during this test.
    // Only the IDs returned by this journey are owned cleanup targets.
    for (const workspaceId of cleanupIds) {
      await smokeGql(
        request,
        GQL,
        cookies,
        `mutation ObsidianRoundtripCleanup($id: ID!) {
          admin { deleteWorkspace(id: $id) }
        }`,
        { id: workspaceId },
      );
    }
  }
});
