// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";
import {
  getAccountLocale,
  setAccountLocale,
} from "../../shared/user-preferences-helper";
import {
  cleanupDoc,
  createDisposableDoc,
  typeSlashCommand,
} from "./virgultum-mermaid-block-doc-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "./virgultum-mermaid-block-http-helpers";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;

const FATAL_ERROR_PATTERNS = [
  /not found in container/i,
  /ComponentNotFoundError/i,
  /Uncaught Error/i,
  /Cannot read properties of undefined/i,
  /Cannot read properties of null/i,
  /is not a function/i,
  /ReferenceError/i,
  /ChunkLoadError/i,
  /Loading chunk/i,
  /Invalid slash-menu id/i,
  /not a valid selector/i,
];

test.describe("Virgultum Mermaid source-first host", () => {
  let localeCookies: string[] = [];
  let originalLocale: string | null = null;

  test.beforeAll(async ({ request }) => {
    localeCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    const target = {
      request,
      gqlEndpoint: `${API}/graphql`,
      cookies: localeCookies,
    };
    originalLocale = await getAccountLocale(target);
    await setAccountLocale(target, "en");
  });

  test.afterAll(async ({ request }) => {
    const restoreCookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    try {
      await setAccountLocale(
        { request, gqlEndpoint: `${API}/graphql`, cookies: restoreCookies },
        originalLocale,
      );
    } finally {
      await signOutViaApi(request, API, restoreCookies);
    }
  });
  test("keeps source controls and keyboard slash insert stable for source-first diagrams", async ({
    context,
    page,
    request,
  }, testInfo) => {
    const runtimeErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (FATAL_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
        runtimeErrors.push(`console: ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      runtimeErrors.push(`pageerror: ${error.message}`);
    });

    const cookies = await signInViaApi(
      request,
      API,
      DEFAULT_SMOKE_USER_EMAIL,
      DEFAULT_SMOKE_USER_PASSWORD,
    );
    await injectCookies(context, cookies);
    await suppressOpenInApp(context);
    const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

    let docId: string | undefined;
    try {
      docId = await createDisposableDoc(page, workspaceId);
      await typeSlashCommand(page, "/mermaid elk");
      const flowchartElkItem = page.getByTestId(
        "slash-menu-item-mermaid-flowchart-elk-basic",
      );
      await expect(flowchartElkItem).toBeVisible({ timeout: 5_000 });
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");

      const mermaidBlock = page.locator("myoxus-mermaid").first();
      await expect(mermaidBlock).toBeVisible({ timeout: 15_000 });
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-editor").first(),
      ).toBeVisible({ timeout: 10_000 });

      await mermaidBlock.getByText("Source", { exact: true }).click();
      const sourceEditor = mermaidBlock.getByRole("textbox", {
        name: "Mermaid source",
      });
      const blockId = await mermaidBlock.getAttribute("data-block-id");
      expect(blockId).toBeTruthy();
      await expect(sourceEditor).toHaveValue(
        [
          "---",
          'title: "Flowchart ELK"',
          "---",
          "flowchart-elk TD",
          "  A[Start] --> B{Decision}",
          "  B -->|Yes| C[Done]",
          "  B -->|No| D[Retry]",
        ].join("\n"),
      );

      await sourceEditor.click();
      await page.keyboard.press("ControlOrMeta+A");
      const selection = await sourceEditor.evaluate((element) => {
        const textarea = element as HTMLTextAreaElement;
        return {
          end: textarea.selectionEnd,
          length: textarea.value.length,
          start: textarea.selectionStart,
        };
      });
      expect(selection).toEqual({
        end: selection.length,
        length: selection.length,
        start: 0,
      });
      await page.keyboard.press("Backspace");
      await expect(sourceEditor).toHaveValue("");
      await expect(mermaidBlock).toHaveAttribute("data-block-id", blockId!);
      await expect(
        mermaidBlock.locator(
          '[data-source-state="empty"][data-stale-projection="true"]',
        ),
      ).toBeVisible();

      const keyboardSource = "flowchart LR\n  A[Alpha] --> B[Beta]";
      await sourceEditor.pressSequentially(keyboardSource);
      await expect(sourceEditor).toBeFocused();
      await expect(sourceEditor).toHaveValue(
        new RegExp(`${keyboardSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );

      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: FRONTEND,
      });
      const pastedSource = "flowchart TD\n  A[Pasted] --> B[Done]";
      await page.evaluate(
        (source) => navigator.clipboard.writeText(source),
        pastedSource,
      );
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("ControlOrMeta+V");
      await expect(sourceEditor).toHaveValue(
        new RegExp(`${pastedSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
      await expect(mermaidBlock).toHaveAttribute("data-block-id", blockId!);

      const pastedValue = await sourceEditor.inputValue();
      await mermaidBlock.getByRole("button", { name: "Undo" }).click();
      await expect.poll(() => sourceEditor.inputValue()).not.toBe(pastedValue);
      await mermaidBlock.getByRole("button", { name: "Redo" }).click();
      await expect(sourceEditor).toHaveValue(pastedValue);

      await sourceEditor.fill(["info", "  showInfo"].join("\n"));

      await expect(
        mermaidBlock.getByRole("status", {
          name: "Last valid Mermaid preview",
        }),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        mermaidBlock.locator('[data-editor-surface="source-first"]'),
      ).toBeVisible();
      await expect(sourceEditor).toBeVisible();
      await expect(sourceEditor).toHaveValue(["info", "  showInfo"].join("\n"));
      await expect(
        mermaidBlock.getByRole("radio", { name: "Visual" }),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.getByRole("radio", { name: "Source" }),
      ).toBeChecked();
      await expect(
        mermaidBlock.locator(
          '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
        ),
      ).toHaveCount(1);
      await expect(
        mermaidBlock.getByRole("group", { name: "Mermaid source preview" }),
      ).toBeVisible();
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-visual-canvas"),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-gfx-editor"),
      ).toBeHidden();
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-structured-row"),
      ).toHaveCount(0);
      await expect(
        mermaidBlock.locator(".myoxus-mermaid-controls"),
      ).toHaveCount(0);
      await expect(mermaidBlock.getByLabel("Template")).toHaveCount(0);
      await expect(mermaidBlock.getByLabel("Layout")).toHaveCount(0);
      await expect(
        mermaidBlock.getByLabel("Edge style", { exact: true }),
      ).toHaveCount(0);
      await expect(mermaidBlock.getByLabel("Palette")).toHaveCount(0);

      await expect(
        mermaidBlock
          .getByRole("group", { name: "Mermaid source preview" })
          .locator("svg")
          .first(),
      ).toBeVisible({ timeout: 10_000 });
      await sourceEditor.fill("flowchart TD\n  A[Valid] --> {");
      const renderAlert = mermaidBlock.getByRole("alert");
      await expect(renderAlert).toBeVisible({ timeout: 10_000 });
      await expect(renderAlert).toContainText("Diagram could not be rendered");
      await expect(renderAlert).toContainText(/Parse error on line \d+/i);
      await expect(
        mermaidBlock.getByLabel("Last valid Mermaid preview"),
      ).toBeVisible();
      await expect(sourceEditor).toHaveValue("flowchart TD\n  A[Valid] --> {");
      await expect(
        mermaidBlock.getByRole("radio", { name: "Visual" }),
      ).toHaveCount(0);

      const screenshotPath = testInfo.outputPath(
        "web-mermaid-source-first-host.png",
      );
      await page.screenshot({ path: screenshotPath });
      await testInfo.attach("web-mermaid-source-first-host", {
        path: screenshotPath,
        contentType: "image/png",
      });

      expect(runtimeErrors).toEqual([]);
    } finally {
      if (docId) {
        await cleanupDoc(workspaceId, cookies, docId, request);
      }
      await signOutViaApi(request, API, cookies);
    }
  });
});
