// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import en from "../../../../../../client/libs/i18n/src/resources/en.json";
import de from "../../../../../../client/libs/i18n/src/resources/de.json";
import fr from "../../../../../../client/libs/i18n/src/resources/fr.json";
import es from "../../../../../../client/libs/i18n/src/resources/es.json";
import { injectSessionCookies } from "../../../../adminfrontend/e2e/fixtures/auth";
import {
  DEFAULT_SMOKE_USER_EMAIL,
  DEFAULT_SMOKE_USER_PASSWORD,
  signInViaApi,
} from "../../../shared/auth-helper";
import {
  smokeGql,
  waitForWorkspaceReady,
} from "../../../shared/workspace-helper";

const frontend =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";
const api = process.env.MYOXUS_API_BASE_URL ?? "http://localhost:3001";
const body =
  "Check the publication scope.\n\nKeep the private approval details here.";
const markdown = `Before **approval** %%Ask Anna about the release.%% after.\n\n%%${body}%%\n\nCode \`%%code%%\`.\n\n\`\`\`text\n%%literal code%%\n\`\`\``;
const html = `<p>Before <strong>approval</strong> %%Ask Anna about the release.%% after.</p><p>%%${body.replaceAll("\n", "<br>")}%%</p><p>Code <code>%%code%%</code>.</p><pre><code>%%literal code%%</code></pre>`;

// Read the canonical consuming model; never manufacture native annotations in
// the test. Removing client codec registration must fail these assertions.
async function semantics(page: Page) {
  return page.evaluate(() => {
    type Delta = { insert: string; attributes?: Record<string, unknown> };
    type Model = { flavour: string; text?: { toDelta(): Delta[] } };
    const host = document.querySelector("editor-host") as HTMLElement & {
      std: {
        store: { getBlocksByFlavour(flavour: string): { model: Model }[] };
      };
    };
    return ["myoxus:paragraph", "myoxus:annotation", "myoxus:code"].flatMap(
      (flavour) =>
        host.std.store.getBlocksByFlavour(flavour).map(({ model }) => ({
          flavour,
          delta: model.text?.toDelta() ?? [],
        })),
    );
  });
}

async function assertFixture(page: Page) {
  await expect(page.locator("myoxus-annotation")).toHaveCount(1);
  await expect
    .poll(async () => {
      const blocks = await semantics(page);
      return blocks.find((block) => block.flavour === "myoxus:annotation")
        ?.delta;
    })
    .toEqual([{ insert: body }]);
  const blocks = await semantics(page);
  const paragraph = blocks.find((block) =>
    block.delta.some((delta) => delta.insert === "Before "),
  )!;
  expect(paragraph.delta.map((delta) => delta.insert).join("")).toBe(
    "Before approval Ask Anna about the release. after.",
  );
  expect(
    paragraph.delta.find((delta) => delta.insert === "approval")?.attributes
      ?.bold,
  ).toBe(true);
  expect(
    paragraph.delta.find(
      (delta) => delta.insert === "Ask Anna about the release.",
    )?.attributes?.annotation,
  ).toMatchObject({ id: expect.any(String) });
  expect(
    blocks.find((block) => block.flavour === "myoxus:code")?.delta,
  ).toEqual([{ insert: "%%literal code%%" }]);
  expect(
    blocks
      .flatMap((block) => block.delta)
      .find((delta) => delta.insert === "%%code%%")?.attributes?.code,
  ).toBe(true);
}

async function importMarkdown(page: Page, name: string, buffer: Buffer) {
  const previousUrl = page.url();
  await page.getByTestId("header-dropDownButton").click();
  await page.getByTestId("editor-option-menu-import").hover();
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("editor-option-menu-import-markdown-files").click();
  await (await chooser).setFiles({ name, mimeType: "text/markdown", buffer });
  await expect(page).not.toHaveURL(previousUrl);
  await assertFixture(page);
}

async function focusPasteBoundary(page: Page) {
  await page.locator("rich-text > [contenteditable=true]").last().click();
  // The native caret and the editor's asynchronous selection projection must
  // agree before a paste whose preparation protects against later caret moves.
  await expect
    .poll(() =>
      page.evaluate(() => {
        type Selection = {
          toJSON(): {
            type: string;
            from?: { blockId: string; index: number; length: number };
          };
        };
        const host = document.querySelector("editor-host") as HTMLElement & {
          std: { selection: { value: Selection[] } };
        };
        const selected = host.std.selection.value
          .map((item) => item.toJSON())
          .find((item) => item.type === "text");
        const native = document.getSelection();
        const anchor = native?.anchorNode;
        const caretElement =
          anchor instanceof Element ? anchor : anchor?.parentElement;
        return (
          !!selected?.from &&
          native?.isCollapsed &&
          !!caretElement &&
          host.contains(caretElement) &&
          selected.from.blockId ===
            caretElement
              .closest("[data-block-id]")
              ?.getAttribute("data-block-id") &&
          selected.from.index === 0 &&
          selected.from.length === 0
        );
      }),
    )
    .toBe(true);
}

type PreciseTargets = {
  documentId: string;
  heading: string;
  paragraph: string;
  list: string;
};

async function assertPreciseTargets(page: Page, targets: PreciseTargets) {
  await expect
    .poll(async () =>
      (await semantics(page)).flatMap((block) =>
        block.delta.flatMap((delta) =>
          delta.attributes?.reference ? [delta.attributes.reference] : [],
        ),
      ),
    )
    .toEqual([
      {
        type: "LinkedPage",
        pageId: targets.documentId,
        title: "heading target",
        params: { mode: "page", blockIds: [targets.heading] },
      },
      {
        type: "LinkedPage",
        pageId: targets.documentId,
        title: "paragraph target",
        params: { mode: "page", blockIds: [targets.paragraph] },
      },
      {
        type: "LinkedPage",
        pageId: targets.documentId,
        title: "list target",
        params: { mode: "page", blockIds: [targets.list] },
      },
    ]);
  for (const [alias, id] of [
    ["heading target", targets.heading],
    ["paragraph target", targets.paragraph],
    ["list target", targets.list],
  ]) {
    const link = page.getByRole("link", { name: alias, exact: true });
    await expect(link).toHaveAttribute(
      "href",
      new RegExp(`blockIds=${id}(?:&|$)`),
    );
  }
}

test("client clipboard and document Markdown retain canonical annotation bodies", async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const cookies = await signInViaApi(
    request,
    api,
    DEFAULT_SMOKE_USER_EMAIL,
    DEFAULT_SMOKE_USER_PASSWORD,
  );
  await injectSessionCookies(context, cookies);
  const created = await smokeGql<{ createWorkspace: { id: string } }>(
    request,
    `${frontend}/graphql`,
    cookies,
    "mutation AnnotationClientWorkspace { createWorkspace { id } }",
  );
  const workspaceId = created.createWorkspace.id;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  try {
    // Exercise the existing browser file-input fallback, not an adapter invoked
    // directly by the test. File System Access pickers cannot be automated here.
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, "showOpenFilePicker");
    });
    await page.goto(`${frontend}/workspace/${workspaceId}/all`);
    await waitForWorkspaceReady(page, { allDocs: true });
    await context.grantPermissions(["clipboard-write"]);
    await page.getByTestId("sidebar-new-page-button").click();
    await expect(page.locator("editor-host")).toBeVisible();
    await page.locator("doc-title .inline-editor").fill("Precise target");
    await page.keyboard.press("Enter");
    await page.bringToFront();
    await page.evaluate(async () =>
      navigator.clipboard.writeText(
        "# Über Größe\n\nInstruction ^instruction\n\n- Decision ^decision",
      ),
    );
    await focusPasteBoundary(page);
    await page.keyboard.press("Control+V");
    await expect(page.locator("myoxus-list")).toHaveCount(1);
    const targets = await page.evaluate(() => {
      type Model = {
        id: string;
        props: { type?: string; markdownAnchor?: string };
      };
      const host = document.querySelector("editor-host") as HTMLElement & {
        store: {
          id: string;
          getBlocksByFlavour(flavour: string): { model: Model }[];
        };
      };
      const paragraphs = host.store
        .getBlocksByFlavour("myoxus:paragraph")
        .map((block) => block.model);
      const lists = host.store
        .getBlocksByFlavour("myoxus:list")
        .map((block) => block.model);
      const heading = paragraphs.find((model) => model.props.type === "h1");
      const paragraph = paragraphs.find(
        (model) => model.props.markdownAnchor === "instruction",
      );
      const list = lists.find(
        (model) => model.props.markdownAnchor === "decision",
      );
      if (!heading || !paragraph || !list)
        throw new Error("Target import did not create native anchored blocks");
      return {
        documentId: host.store.id,
        heading: heading.id,
        paragraph: paragraph.id,
        list: list.id,
      };
    });
    const targetUrl = `${frontend}/workspace/${workspaceId}/${targets.documentId}`;
    const linkedMarkdown = `${markdown}\n\n[[Precise target#%C3%9Cber%20Gr%C3%B6%C3%9Fe|heading target]] [paragraph target](${targetUrl}#%5Einstruction) [[Precise target#^decision|list target]]`;
    const linkedHtml = `${html}<p>${[
      ["heading target", targets.heading],
      ["paragraph target", targets.paragraph],
      ["list target", targets.list],
    ]
      .map(
        ([alias, id]) =>
          `<a href="${targetUrl}?mode=page&amp;blockIds=${id}">${alias}</a>`,
      )
      .join(" ")}</p>`;
    for (const withHtml of [false, true]) {
      const previousUrl = page.url();
      await page.getByTestId("sidebar-new-page-button").click();
      await expect(page).not.toHaveURL(previousUrl);
      await expect(page.locator("editor-host")).toBeVisible();
      await expect(page.locator("myoxus-annotation")).toHaveCount(0);
      await page.bringToFront();
      await page.evaluate(
        async ({ markdown, html, withHtml }) => {
          if (withHtml)
            await navigator.clipboard.write([
              new ClipboardItem({
                "text/plain": new Blob([markdown], { type: "text/plain" }),
                "text/html": new Blob([html], { type: "text/html" }),
              }),
            ]);
          else await navigator.clipboard.writeText(markdown);
        },
        { markdown: linkedMarkdown, html: linkedHtml, withHtml },
      );
      await focusPasteBoundary(page);
      await page.keyboard.press("Control+V");
      await assertFixture(page);
      await assertPreciseTargets(page, targets);
      await page.reload();
      await assertFixture(page);
      await assertPreciseTargets(page, targets);
    }
    await page
      .getByRole("link", { name: "heading target", exact: true })
      .click();
    await expect(
      page.locator(`[data-block-id="${targets.heading}"]`),
    ).toContainText("Über Größe");
    await expect(page).toHaveURL(
      new RegExp(`blockIds=${targets.heading}(?:&|$)`),
    );
    const headingEditor = page.locator(
      `[data-block-id="${targets.heading}"] .inline-editor`,
    );
    await headingEditor.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const host = document.querySelector("editor-host") as HTMLElement & {
            std: {
              selection: {
                value: {
                  toJSON(): {
                    type: string;
                    from?: { blockId: string; length: number };
                  };
                }[];
              };
            };
          };
          return host.std.selection.value.some((selection) => {
            const value = selection.toJSON();
            return (
              value.type === "text" &&
              value.from?.blockId === id &&
              value.from.length === "Über Größe".length
            );
          });
        }, targets.heading),
      )
      .toBe(true);
    await page.keyboard.insertText("Renamed Über Größe");
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const host = document.querySelector("editor-host") as HTMLElement & {
            store: {
              getModelById(
                id: string,
              ): { props: { text?: { toString(): string } } } | null;
            };
          };
          return host.store.getModelById(id)?.props.text?.toString();
        }, targets.heading),
      )
      .toBe("Renamed Über Größe");
    await page.goBack();
    await assertPreciseTargets(page, targets);
    for (const [alias, id] of [
      ["paragraph target", targets.paragraph],
      ["list target", targets.list],
    ]) {
      const link = page.getByRole("link", { name: alias, exact: true });
      await expect(link).toHaveAttribute("data-reference-state", "ready");
      await link.focus();
      await link.press("Enter");
      await expect(page).toHaveURL(new RegExp(`blockIds=${id}(?:&|$)`));
      await expect(page.locator(`[data-block-id="${id}"]`)).toBeVisible();
      await page.goBack();
      await assertPreciseTargets(page, targets);
    }
    await importMarkdown(
      page,
      "Annotation client fixture.md",
      // Use the current heading spelling for this new import. The already
      // native references above retain their original IDs through the rename.
      Buffer.from(
        linkedMarkdown.replace(
          "%C3%9Cber%20Gr%C3%B6%C3%9Fe",
          "Renamed%20%C3%9Cber%20Gr%C3%B6%C3%9Fe",
        ),
      ),
    );
    await assertPreciseTargets(page, targets);
    await page.getByTestId("header-dropDownButton").click();
    await page.getByTestId("export-menu").hover();
    const download = page.waitForEvent("download");
    await page.getByTestId("export-to-markdown").click();
    const file = await (await download).path();
    if (!file) throw new Error("Markdown export did not persist a download");
    await importMarkdown(
      page,
      "Annotation client roundtrip.md",
      await readFile(file),
    );
    await assertPreciseTargets(page, targets);
    await page
      .getByRole("link", { name: "heading target", exact: true })
      .click();
    const heading = page.locator(`[data-block-id="${targets.heading}"]`);
    await expect(heading).toContainText("Renamed Über Größe");
    const rect = await heading.boundingBox();
    if (!rect) throw new Error("Native heading has no rendered bounds");
    await page.mouse.move(rect.x + 10, rect.y + 10, { steps: 2 });
    await page.locator(".myoxus-drag-handle-container").click();
    await page.keyboard.press("Backspace");
    await expect(heading).toHaveCount(0);
    await page.goBack();
    const missing = page.getByRole("link", {
      name: "heading target",
      exact: true,
    });
    await expect(missing).toHaveAttribute(
      "data-reference-state",
      "unavailable",
    );
    await expect(missing).toHaveAttribute("aria-disabled", "true");
    // Seed users retain their account locale; require the canonical localized
    // diagnostic rather than overriding that preference for this journey.
    expect(
      [en, de, fr, es].map(
        (messages) => messages["com.myoxus.reference.target-unavailable"],
      ),
    ).toContain(await missing.getAttribute("title"));
    const sourceUrl = page.url();
    const missingBounds = await missing.boundingBox();
    if (!missingBounds) throw new Error("Unavailable link is not rendered");
    // A pointer can hit an aria-disabled anchor; locator.click deliberately
    // waits for it to become enabled and cannot exercise this blocked click.
    await page.mouse.click(
      missingBounds.x + missingBounds.width / 2,
      missingBounds.y + missingBounds.height / 2,
    );
    await expect(page).toHaveURL(sourceUrl);
    await assertPreciseTargets(page, targets);
    await page.goForward();
    await page.locator("rich-text .inline-editor").first().click();
    await page.keyboard.press("Control+z");
    await expect(heading).toContainText("Renamed Über Größe");
    await page.goBack();
    await expect(missing).toHaveAttribute("data-reference-state", "ready");
    await missing.focus();
    await missing.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`blockIds=${targets.heading}(?:&|$)`),
    );
    await expect(heading).toContainText("Renamed Über Größe");
    expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await smokeGql(
      request,
      `${frontend}/graphql`,
      cookies,
      "mutation AnnotationClientCleanup($id: ID!) { admin { deleteWorkspace(id: $id) } }",
      { id: workspaceId },
    );
  }
});
