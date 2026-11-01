// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../shared/auth-helper";
import {
  getAccountColorMode,
  getAccountLocale,
  setAccountColorMode,
  setAccountLocale,
  type UserColorMode,
} from "../../shared/user-preferences-helper";
import { getSmokeWorkspaceId } from "../../shared/workspace-helper";
import {
  cleanupDoc,
  createDisposableDoc,
  typeSlashCommand,
} from "../../editor-flow/tests/virgultum-mermaid-block-doc-helpers";
import {
  injectCookies,
  suppressOpenInApp,
} from "../../editor-flow/tests/virgultum-mermaid-block-http-helpers";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
const EVIDENCE_DIR = path.join(
  process.cwd(),
  "output/visual-qa/p-mermaid-repair-20260726-04f/after",
);

let cookies: string[] = [];
let originalColorMode: UserColorMode | null = null;
let originalLocale: string | null = null;

async function writeSource(block: Locator, source: string) {
  await block.getByRole("tab", { name: "Source" }).click();
  const editor = block.getByRole("textbox", { name: "Mermaid source" });
  await editor.fill(source);
  await expect(editor).toHaveValue(source);
  await block.getByRole("tab", { name: "Visual" }).click();
}

async function capture(page: Page, name: string) {
  await page.screenshot({ path: path.join(EVIDENCE_DIR, `${name}.png`) });
}

async function switchToEdgeless(page: Page) {
  await page.getByTestId("switch-edgeless-mode-button").click();
  await expect(page).toHaveURL(/mode=edgeless/, { timeout: 20_000 });
  const note = page.locator("myoxus-edgeless-note").first();
  await expect(note).toBeVisible({ timeout: 20_000 });
  await note.dblclick();
  return note;
}

async function switchToPage(page: Page) {
  await page.getByTestId("switch-page-mode-button").click();
  await expect(page).toHaveURL(/mode=page/, { timeout: 20_000 });
  return page.locator("myoxus-mermaid").first();
}

test.beforeAll(async ({ request }) => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  const preferences = { cookies, gqlEndpoint: GQL, request };
  originalColorMode = await getAccountColorMode(preferences);
  originalLocale = await getAccountLocale(preferences);
  await setAccountLocale(preferences, "en");
});

test.afterAll(async ({ request }) => {
  if (!cookies.length) return;
  const preferences = { cookies, gqlEndpoint: GQL, request };
  await setAccountLocale(preferences, originalLocale);
  await setAccountColorMode(preferences, originalColorMode);
});

test("Phase 04F Journey and Packet visual state matrix", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await injectCookies(context, cookies);
  await suppressOpenInApp(context);
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  const preferences = { cookies, gqlEndpoint: GQL, request };
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  let docId: string | undefined;
  try {
    await setAccountColorMode(preferences, "light");
    docId = await createDisposableDoc(page, workspaceId);
    await typeSlashCommand(page, "/mermaid");
    await page
      .getByRole("button", {
        name: /Mermaid: Flowchart\s+Create a Mermaid diagram/i,
      })
      .click();
    let block = page.locator("myoxus-mermaid").first();
    await writeSource(
      block,
      [
        "journey",
        "  title Onboarding journey",
        "  section Discover",
        "    Invite a team with a realistically long name: 4: Admin, User",
        "    Review workspace: 2: User, Reviewer",
        "    Create page: 3: User",
        "  section Adopt",
        "    Publish reviewed document: 4: Editor",
      ].join("\n"),
    );
    let journey = block.locator('[data-myoxus-ui-role="journey-map"]');
    await expect(journey).toBeVisible({ timeout: 15_000 });
    await expect(journey.getByText("Admin", { exact: true })).toBeVisible();
    await expect(
      journey.getByText("Score: 4", { exact: true }).first(),
    ).toBeVisible();
    await capture(page, "mermaid-journey-page-light-desktop");

    await setAccountColorMode(preferences, "dark");
    await page.reload({ waitUntil: "load" });
    const journeyNote = await switchToEdgeless(page);
    journey = journeyNote.locator('[data-myoxus-ui-role="journey-map"]');
    await expect(journey).toBeVisible({ timeout: 20_000 });
    await expect(journey.getByText("Adopt", { exact: true })).toBeVisible();
    await capture(page, "mermaid-journey-edgeless-dark-desktop");

    block = await switchToPage(page);
    await writeSource(
      block,
      [
        "packet",
        '  0-3: "Protocol version"',
        '  4-7: "Flags"',
        '  12-15: "Reserved gap after flags"',
        '  16-31: "Payload bytes"',
      ].join("\n"),
    );
    const packet = block.locator('[data-myoxus-ui-role="packet-bit-editor"]');
    await expect(packet.getByText("Total width: 32 bits")).toBeVisible();
    await expect(packet.getByText("Gap", { exact: true })).toBeVisible();
    const fields = packet.locator('[data-myoxus-ui-role="packet-bit-field"]');
    await expect(fields.nth(0)).toHaveCSS("grid-column", "1 / span 4");
    await expect(fields.nth(3)).toHaveCSS("grid-column", "17 / span 16");
    await capture(page, "mermaid-packet-page-dark-desktop");

    await switchToEdgeless(page);
    await setAccountColorMode(preferences, "system");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 640, height: 900 });
    await page.reload({ waitUntil: "load" });
    const compactPacket = page
      .locator('[data-myoxus-ui-role="packet-bit-editor"]')
      .first();
    await expect(compactPacket).toBeVisible({ timeout: 25_000 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("dark");
    await expect(
      compactPacket.locator('[data-myoxus-ui-role="packet-bit-scroll"]'),
    ).toBeVisible();
    await capture(page, "mermaid-packet-edgeless-system-dark-compact");

    for (const worker of page.workers()) {
      await expect(worker.evaluate(() => true)).resolves.toBe(true);
    }
    expect(browserErrors, browserErrors.join("\n")).toEqual([]);
  } finally {
    if (docId) await cleanupDoc(workspaceId, cookies, docId, request);
  }
});
