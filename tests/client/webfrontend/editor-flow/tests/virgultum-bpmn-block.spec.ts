// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFile } from "node:fs/promises";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
  signOutViaApi,
} from "../../shared/auth-helper";
import {
  getSmokeWorkspaceId,
  smokeGql,
  waitForWorkspaceDocSync,
} from "../../shared/workspace-helper";

const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const API = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const GQL = `${FRONTEND}/graphql`;
async function injectCookies(context: BrowserContext, cookies: string[]) {
  for (const raw of cookies) {
    const [pair] = raw.split(";");
    const [name, ...value] = pair.split("=");
    await context.addCookies([
      {
        name: name.trim(),
        value: value.join("="),
        url: FRONTEND,
        sameSite: "Lax",
      },
    ]);
  }
  await context.addInitScript(() =>
    localStorage.setItem("global-state:open-link-mode", '"open-in-web"'),
  );
}
async function cleanupDoc(
  page: Page,
  request: APIRequestContext,
  workspaceId: string,
  cookies: string[],
  docId: string,
) {
  // Content-only sync deletion does not remove authoritative document metadata.
  // Use the normal trash journey, then the canonical permanent-delete mutation.
  await page
    .getByRole("radio", { name: /^(List|Liste)$/ })
    .locator("..")
    .click();
  const row = page.locator(
    `[data-testid="doc-list-item"][data-doc-id="${docId}"]`,
  );
  await row.hover();
  await row.getByTestId("doc-list-operation-button").click();
  await page.getByTestId("doc-list-operation-trash").click();
  await page.getByRole("dialog").getByTestId("confirm-modal-confirm").click();
  await expect(row).toHaveCount(0);
  const deleted = await smokeGql<{
    deleteDocumentPermanently: { deleted: number; failed: number };
  }>(
    request,
    GQL,
    cookies,
    `mutation BpmnCleanupDelete($input: DeleteDocumentPermanentlyInput!) { deleteDocumentPermanently(input: $input) { deleted failed } }`,
    { input: { workspaceId, docId } },
  );
  expect(deleted.deleteDocumentPermanently).toEqual({ deleted: 1, failed: 0 });
  await expect
    .poll(
      async () => {
        const result = await smokeGql<{
          workspace: { doc: { id: string } | null };
        }>(
          request,
          GQL,
          cookies,
          `query BpmnCleanup($workspaceId: String!, $docId: String!) { workspace(id: $workspaceId) { doc(docId: $docId) { id } } }`,
          { workspaceId, docId },
        );
        return result.workspace.doc;
      },
      {
        timeout: 20_000,
        message: "Disposable BPMN document must be deleted, not merely closed",
      },
    )
    .toBeNull();
}
async function dropPaletteNode(
  page: Page,
  name: RegExp,
  position: { x: number; y: number },
) {
  await page
    .getByRole("button", { name })
    .dragTo(page.locator(".react-flow__pane"), {
      targetPosition: position,
    });
}

async function connectByMouse(
  page: Page,
  sourceType: string,
  targetType: string,
) {
  const source = page.locator(`.react-flow__node-${sourceType}`).last();
  const target = page.locator(`.react-flow__node-${targetType}`).last();
  await source.click();
  await source.getByRole("button", { name: /^(Actions|Aktionen)$/ }).click();
  const handle = source.getByRole("button", {
    name: /^(Sequence Flow|Sequenzfluss)$/,
  });
  const from = await handle.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Visible connection endpoints required");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 2, to.y + to.height / 2, { steps: 22 });
  await page.mouse.up();
}

async function selectEdgeByMouse(page: Page) {
  const point = await page
    .locator(".react-flow__edge")
    .first()
    .locator("path")
    .first()
    .evaluate((path) => {
      const line = path as SVGPathElement;
      const local = line.getPointAtLength(line.getTotalLength() / 2);
      const screen = local.matrixTransform(line.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".react-flow__edge.selected")).toHaveCount(1);
}
async function downloadSource(page: Page) {
  const pending = page.waitForEvent("download");
  await page
    .locator("myoxus-bpmn")
    .getByRole("button", { name: /^(Download|Herunterladen)$/ })
    .click();
  const download = await pending;
  const path = await download.path();
  if (!path) throw new Error("BPMN download did not produce a file");
  return readFile(path);
}

test.use({ serviceWorkers: "block" });
test("catalog mouse construction and Page/Edgeless entry preserve canonical BPMN graphs", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(160_000);
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const cookies = await signInViaApi(
    request,
    API,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  await injectCookies(context, cookies);
  await page.setViewportSize({ width: 1280, height: 720 });
  const workspaceId = await getSmokeWorkspaceId(request, GQL, cookies);
  let docId: string | undefined;
  let insertionDocId: string | undefined;
  try {
    await page.goto(`${FRONTEND}/workspace/${workspaceId}/diagrams`);
    await page.getByTestId("diagram-type-bpmn").click();
    await page.getByTestId("create-selected-diagram-button").click();
    await expect(page).toHaveURL(
      /\/workspace\/[^/]+\/(?!diagrams(?:$|\?))[^/?#]+/,
    );
    docId = new URL(page.url()).pathname.split("/").at(-1)!;
    const dialog = page.getByTestId("bpmn-editor-dialog");
    await expect(dialog.locator(".react-flow")).toBeVisible();
    await expect(page.locator("myoxus-bpmn")).toHaveCount(1);
    const blockId = await page
      .locator("myoxus-bpmn")
      .getAttribute("data-block-id");
    expect(blockId).toBeTruthy();
    await expect(
      page.locator("myoxus-frame, myoxus-bpmn editor-host"),
    ).toHaveCount(0);
    const pageBlank = await page.locator("myoxus-bpmn").evaluate(
      (element) =>
        Object.values(
          (
            element as HTMLElement & {
              model: { props: { sourceHeads: Record<string, string> } };
            }
          ).model.props.sourceHeads,
        )[0],
    );
    await dropPaletteNode(page, /^(BPMN Start Event|BPMN Startereignis)$/, {
      x: 320,
      y: 250,
    });
    await dropPaletteNode(page, /^(BPMN Task|BPMN Aufgabe)$/, {
      x: 530,
      y: 280,
    });
    await dropPaletteNode(page, /^(BPMN End Event|BPMN Endereignis)$/, {
      x: 765,
      y: 310,
    });
    await expect(dialog.locator(".react-flow__node")).toHaveCount(3);
    // Allow the 500 ms settled-model projection to finish before a new pointer
    // connection; it can replace an in-flight React Flow gesture.
    await page.waitForTimeout(650);
    await connectByMouse(page, "node_startEvent", "node_task");
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(1);
    await page.waitForTimeout(650);
    await connectByMouse(page, "node_task", "node_endEvent");
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(2);
    await page.waitForTimeout(650);
    await dialog.locator(".react-flow__node-node_task").click();
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("BPMN persisted task");
    await page.waitForTimeout(650);
    const task = dialog.locator(".react-flow__node-node_task");
    const beforeMove = await task.boundingBox();
    if (!beforeMove) throw new Error("Task is not visible for mouse movement");
    await page.mouse.move(
      beforeMove.x + beforeMove.width / 2,
      beforeMove.y + beforeMove.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      beforeMove.x + beforeMove.width / 2,
      beforeMove.y + beforeMove.height / 2 + 75,
      { steps: 18 },
    );
    await page.mouse.up();
    await expect
      .poll(async () => (await task.boundingBox())?.y)
      .toBeGreaterThan(beforeMove.y + 30);
    await page.waitForTimeout(650);
    await selectEdgeByMouse(page);
    await dialog.getByRole("button", { name: /^(Delete|Löschen)$/ }).click();
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(1);
    // Settled-model projection replaces the graph after 500 ms; immediate
    // focus alone misses a later return to body.
    await page.waitForTimeout(850);
    await expect(dialog.locator(".react-flow")).toBeFocused();
    await dialog.getByRole("button", { name: /^(Undo|Rückgängig)$/ }).click();
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(2);
    await dialog.getByRole("button", { name: /^(Redo|Wiederholen)$/ }).click();
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(1);
    await dialog.getByRole("button", { name: /^(Undo|Rückgängig)$/ }).click();
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(2);
    await task.click();
    await dialog.getByRole("button", { name: /^(Delete|Löschen)$/ }).click();
    await expect(dialog.locator(".react-flow__node")).toHaveCount(2);
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(0);
    await dialog.getByRole("button", { name: /^(Undo|Rückgängig)$/ }).click();
    await expect(dialog.locator(".react-flow__node")).toHaveCount(3);
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(2);
    await dialog.getByRole("button", { name: /^(Save|Speichern)$/ }).click();
    await expect(
      dialog.getByText(/^(Unsaved changes|Ungespeicherte Änderungen)$/),
    ).toHaveCount(0);
    await expect(dialog.locator(".react-flow__node")).toHaveCount(3);
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(2);
    await dialog.locator("header button").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("myoxus-bpmn")).toBeFocused();
    const before = await downloadSource(page);
    expect(before.toString("utf8")).toContain("BPMN persisted task");
    await waitForWorkspaceDocSync(page, docId);
    await page.reload();
    await expect(dialog).toBeHidden();
    await expect(page.locator("myoxus-bpmn")).toHaveAttribute(
      "data-block-id",
      blockId!,
    );
    await page
      .getByRole("radio", { name: /^(Page|Seite)$/ })
      .locator("..")
      .click();
    await page
      .locator("myoxus-bpmn")
      .getByRole("button", { name: /^(Edit|Bearbeiten)$/ })
      .click();
    await expect(dialog.locator(".react-flow__node")).toHaveCount(3);
    await expect(dialog.locator(".react-flow__edge")).toHaveCount(2);
    await expect(dialog.locator(".react-flow__node-node_task")).toContainText(
      "BPMN persisted task",
    );
    await dialog.locator("header button").click();
    await expect(dialog).toBeHidden();
    expect(await downloadSource(page)).toEqual(before);
    // Catalog creation replaces the initial empty paragraph atomically. Use a
    // separate ordinary Page for the existing slash/quick-tool insertion path.
    await page.getByTestId("sidebar-new-page-button").click();
    insertionDocId = new URL(page.url()).pathname.split("/").at(-1)!;
    const paragraph = page
      .locator("myoxus-paragraph [contenteditable=true]")
      .last();
    await paragraph.click();
    await page.keyboard.type("/bpmn");
    await page.getByTestId("slash-menu-item-bpmn").click();
    await expect(dialog.locator(".react-flow")).toBeVisible();
    await expect(page.locator("myoxus-bpmn")).toHaveCount(1);
    await dialog.locator("header button").click();
    await page
      .getByRole("radio", { name: "Edgeless", exact: true })
      .locator("..")
      .click();
    const quickTool = page.getByTestId("myoxus-bpmn-edgeless-toolbar-button");
    await quickTool.click();
    const viewport = await page.locator("myoxus-edgeless-root").boundingBox();
    if (!viewport) throw new Error("Edgeless viewport has no rendered bounds");
    await page.mouse.click(
      viewport.x + viewport.width * 0.65,
      viewport.y + viewport.height * 0.3,
    );
    await expect(dialog.locator(".react-flow")).toBeVisible();
    await expect(page.locator("myoxus-bpmn")).toHaveCount(2);
    await expect(
      page.locator("myoxus-edgeless-root .react-flow, myoxus-frame"),
    ).toHaveCount(0);
    await dialog.locator("header button").click();
    const edgelessBlock = page.locator("myoxus-bpmn").last();
    const note = edgelessBlock.locator("xpath=ancestor::myoxus-edgeless-note");
    await expect(note).toBeVisible();
    await expect(note.locator("myoxus-bpmn")).toHaveCount(1);
    await expect(note.locator("myoxus-paragraph")).toHaveCount(0);
    const edgelessBlank = await edgelessBlock.evaluate(
      (element) =>
        Object.values(
          (
            element as HTMLElement & {
              model: { props: { sourceHeads: Record<string, string> } };
            }
          ).model.props.sourceHeads,
        )[0],
    );
    // Blank diagrams intentionally receive fresh BPMN IDs, not different XML models.
    const withoutIds = (xml: string) =>
      xml.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "UUID");
    expect(withoutIds(edgelessBlank)).toEqual(withoutIds(pageBlank));
    expect(errors).toEqual([]);
  } finally {
    try {
      if (docId) {
        await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`);
        await cleanupDoc(page, request, workspaceId, cookies, docId);
      }
      if (insertionDocId) {
        await cleanupDoc(page, request, workspaceId, cookies, insertionDocId);
      }
    } finally {
      await signOutViaApi(request, API, cookies);
    }
  }
});
