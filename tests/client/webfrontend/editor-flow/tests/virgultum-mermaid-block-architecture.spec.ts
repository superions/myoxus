// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getAccountLocale,
  setAccountLocale,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";
import {
  cleanupDoc,
  createDisposableDoc,
} from "./virgultum-mermaid-block-doc-helpers";
import {
  expectEditableGfx,
  expectMermaidSourceAfterReload,
  FATAL_MERMAID_ERROR_PATTERNS,
  insertEditableMermaidBlock,
  mermaidBlockSource,
  writeMermaidSource,
} from "./virgultum-mermaid-block-family-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "./virgultum-mermaid-block-http-helpers";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const SOURCE = [
  "architecture-beta",
  "%% Architecture journey",
  '  group platform(cloud)["Platform"]',
  '  group core(server)["Core services"] in platform',
  '  service gateway(server)["Gateway"] in core',
  '  service api "API" ["Application service"] in core',
  '  service database(database)["Database"] in platform',
  "  junction bus in platform",
  '  gateway:R -["HTTPS"]-> L:api',
  "  api:R --> L:bus",
  '  bus:R -["events"]-> L:database',
  "  align row gateway api",
  "  align column api bus database",
].join("\n");

test("Architecture direct editing survives Page history and both Edgeless owners", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      FATAL_MERMAID_ERROR_PATTERNS.some((pattern) =>
        pattern.test(message.text()),
      )
    ) {
      browserErrors.push(`console: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    browserErrors.push(`pageerror: ${error.message}`);
  });

  const cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const preferences = { cookies, gqlEndpoint: GQL, request };
  const originalLocale = await getAccountLocale(preferences);
  await setAccountLocale(preferences, "en");
  await injectCookies(context, cookies);
  await suppressOpenInApp(context);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);

  let docId: string | undefined;
  try {
    docId = await createDisposableDoc(page, workspaceId);
    const { mermaidBlock, sourceEditor } =
      await insertEditableMermaidBlock(page);
    await mermaidBlock.getByText("Source", { exact: true }).click();
    await writeMermaidSource(sourceEditor, SOURCE);
    await mermaidBlock.getByText("Visual", { exact: true }).click();
    await expectEditableGfx(mermaidBlock, "architecture");

    await mermaidBlock.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Diagram settings" }).click();
    await page.getByRole("button", { name: "Layout" }).click();
    const configuredValues = {
      "Edge elasticity": "0.4",
      "Font size": "18",
      "Icon size": "64",
      "Ideal edge length multiplier": "1.75",
      "Layout iterations": "1200",
      "Layout seed": "7",
      "Node separation": "56",
      Padding: "36",
    } as const;
    for (const [label, value] of Object.entries(configuredValues)) {
      await page.getByRole("textbox", { name: label }).fill(value);
    }
    await page.getByRole("combobox", { name: "Randomize layout" }).click();
    await page.getByRole("option", { name: "Disable" }).click();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect
      .poll(() => mermaidBlockSource(page))
      .toContain('"architecture"');
    const configuredSource = await mermaidBlockSource(page);
    for (const fragment of [
      '"edgeElasticity":0.4',
      '"fontSize":18',
      '"iconSize":64',
      '"idealEdgeLengthMultiplier":1.75',
      '"nodeSeparation":56',
      '"numIter":1200',
      '"padding":36',
      '"randomize":false',
      '"seed":7',
    ]) {
      expect(configuredSource).toContain(fragment);
    }

    await mermaidBlock.getByText("View", { exact: true }).click();
    const viewToolbar = mermaidBlock.getByRole("toolbar", {
      name: "Mermaid diagram controls",
    });
    await expect(
      viewToolbar.getByRole("button", { name: "Center diagram" }),
    ).toBeVisible();
    await expect(viewToolbar.getByRole("button", { name: "Undo" })).toHaveCount(
      0,
    );
    await expect(
      viewToolbar.getByRole("button", { name: /^Delete diagram objects/ }),
    ).toHaveCount(0);
    await mermaidBlock.getByText("Visual", { exact: true }).click();
    await expectEditableGfx(mermaidBlock, "architecture");

    const sourceBeforeCreate = await mermaidBlockSource(page);
    await mermaidBlock
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Add service" }).click();
    await mermaidBlock
      .locator(".myoxus-mermaid-gfx-viewport")
      .click({ position: { x: 24, y: 24 } });
    await expect
      .poll(() => mermaidBlockSource(page))
      .not.toBe(sourceBeforeCreate);
    const sourceAfterCreate = await mermaidBlockSource(page);
    expect(sourceAfterCreate).toMatch(/\n\s*service service\d+/);
    await expect(
      mermaidBlock
        .getByRole("button", {
          name: "Delete diagram objects (1)",
        })
        .first(),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await mermaidBlock
      .getByRole("button", { name: "HTTPS", exact: true })
      .focus();
    await page.keyboard.press("Space");
    const reconnectTarget = mermaidBlock.getByRole("button", {
      name: "Reconnect edge target",
    });
    await expect(reconnectTarget).toBeVisible();
    await reconnectTarget.focus();
    await page.keyboard.press("ArrowDown");
    await expect
      .poll(() => mermaidBlockSource(page))
      .not.toBe(sourceAfterCreate);
    const sourceAfterReconnect = await mermaidBlockSource(page);

    await page.keyboard.press("Escape");
    for (const label of ["Gateway", "Application service"]) {
      await mermaidBlock
        .getByRole("button", { name: label, exact: true })
        .focus();
      await page.keyboard.press("Space");
    }
    await mermaidBlock
      .getByRole("button", { name: "Add", exact: true })
      .click();
    const addGroup = page.getByRole("menuitem", {
      name: "Add group",
      exact: true,
    });
    await expect(addGroup).toBeEnabled();
    await addGroup.click();
    await expect
      .poll(() => mermaidBlockSource(page))
      .not.toBe(sourceAfterReconnect);
    const sourceAfterGroup = await mermaidBlockSource(page);
    await mermaidBlock
      .getByRole("textbox", { name: "Selected group title" })
      .press("Escape");

    await mermaidBlock.focus();
    await page.keyboard.press("Control+Z");
    await expect
      .poll(() => mermaidBlockSource(page))
      .not.toMatch(/\n\s*group group\d+/);
    expect(await mermaidBlockSource(page)).toContain("Application service");
    await mermaidBlock.focus();
    await page.keyboard.press("Control+Y");
    await expect.poll(() => mermaidBlockSource(page)).toBe(sourceAfterGroup);

    await page.getByTestId("switch-edgeless-mode-button").click();
    await expect(page).toHaveURL(/mode=edgeless/, { timeout: 20_000 });
    const embeddedHost = page.locator("myoxus-mermaid").first();
    await expect(embeddedHost).toBeVisible({ timeout: 20_000 });
    const noteMask = page.locator(".myoxus-note-mask").first();
    await noteMask.click();
    await noteMask.dblclick();
    await expect(
      embeddedHost.getByRole("button", { name: "Add", exact: true }),
    ).toBeVisible();
    await embeddedHost
      .locator(".myoxus-mermaid-gfx-viewport")
      .click({ position: { x: 8, y: 8 } });
    await embeddedHost
      .getByRole("button", { name: "Gateway", exact: true })
      .focus();
    await page.keyboard.press("Space");
    await expect(
      embeddedHost
        .getByRole("button", { name: "Delete diagram objects (1)" })
        .first(),
    ).toBeVisible();
    const objectActions = embeddedHost.locator(
      '[data-myoxus-ui-role="mermaid-architecture-object-actions"]',
    );
    const commentsButton = objectActions.getByRole("button", {
      name: /^Comments: 0$/,
    });
    await expect(commentsButton).toBeVisible({ timeout: 10_000 });
    await commentsButton.click();
    const commentsDialog = page.getByRole("dialog", { name: "Comments: 0" });
    await commentsDialog
      .getByRole("textbox", { name: "Comments" })
      .fill("E2E service comment");
    await commentsDialog.getByRole("button", { name: "Comments" }).click();
    await expect
      .poll(() => mermaidBlockSource(page))
      .toContain("%% E2E service comment");
    const sourceAfterComment = await mermaidBlockSource(page);
    const updatedCommentsButton = objectActions.getByRole("button", {
      name: /^Comments: 1$/,
    });
    await expect(updatedCommentsButton).toBeVisible();

    await updatedCommentsButton.click();
    await expect(
      page.getByRole("textbox", { name: "Comments", exact: true }),
    ).toBeHidden();
    await page.keyboard.press("Control+Z");
    await expect
      .poll(() => mermaidBlockSource(page))
      .not.toContain("%% E2E service comment");
    await page.keyboard.press("Control+Y");
    await expect.poll(() => mermaidBlockSource(page)).toBe(sourceAfterComment);

    await page.getByTestId("myoxus-mermaid-edgeless-toolbar-button").click();
    await page
      .getByTestId("myoxus-mermaid-edgeless-template-architecture-basic")
      .click();
    const nativeAddService = page
      .getByRole("button", { name: "Add service", exact: true })
      .last();
    await expect(nativeAddService).toBeVisible();
    await nativeAddService.click();
    await expect(
      page.getByRole("button", { name: "Architecture properties" }).last(),
    ).toBeVisible();

    await page.getByTestId("switch-page-mode-button").click();
    await expect(page).toHaveURL(/mode=page|\/[^?]+$/, { timeout: 20_000 });
    const pageBlock = page.locator("myoxus-mermaid").first();
    await expect(pageBlock).toBeVisible({ timeout: 20_000 });
    await expectMermaidSourceAfterReload(page, "%% E2E service comment");
    await expectEditableGfx(
      page.locator("myoxus-mermaid").first(),
      "architecture",
    );
    expect(browserErrors).toEqual([]);
  } finally {
    if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
    await setAccountLocale(preferences, originalLocale);
    await signOutViaApi(request, API, cookies);
  }
});
