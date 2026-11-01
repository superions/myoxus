// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `virgultum-mermaid-block-doc-helpers.ts`
 * — P-VIRG-ARCH-I-04g
 *
 * Doc-lifecycle + assertion helpers
 * extracted from
 * `virgultum-mermaid-block.spec.ts`
 * (post-I-04f lines 277-495). The 6
 * functions and 1 type here are
 * byte-for-byte identical to the
 * originals; the move is a relocation,
 * not a reimplementation.
 *
 * **Why this file exists (slice
 * charter).** I-04g is the 2nd sub-slice
 * of the I-04f..i cluster split. I-04f
 * landed first because the 4 HTTP/Auth
 * helpers have zero cross-cluster deps
 * and are the natural entry point. I-04g
 * follows because the doc-lifecycle
 * cluster (`cleanupDoc`,
 * `createDisposableDoc`,
 * `typeSlashCommand`) is the one that
 * consumes the I-04f `nativeGql`
 * transport — landing I-04g after I-04f
 * keeps the import graph a clean DAG.
 *
 * **Why `PermanentDeleteData` moves
 * entirely (option 1c), not re-declared
 * (option 1a) or re-exported (option
 * 1b).** The type has exactly 2
 * references in the main spec: the
 * declaration (line 113-121) and the
 * `nativeGql<PermanentDeleteData>(...)`
 * generic argument inside `cleanupDoc`
 * (line 293). The 7 test() bodies call
 * `cleanupDoc` but never reference the
 * type directly. Moving the type with
 * its only consumer eliminates the
 * F7-flagged drift class without
 * needing a byte-equality source-anchor
 * test. The I-04f H-04 reviewer flagged
 * this as "I-04g must include a
 * FRONTEND/GQL byte-equality
 * source-anchor test for its own
 * siblings to prevent the same drift
 * class" — for `PermanentDeleteData`
 * the move-ownership test (Test 3 in
 * the source-anchors spec asserts
 * "the main spec no longer declares
 * `type PermanentDeleteData = {`")
 * is strictly stronger than byte-
 * equality.
 *
 * **Why `FRONTEND` is re-declared
 * here (not imported from the main
 * spec or from the I-04f sibling).**
 * The main spec keeps `FRONTEND`
 * module-private; the I-04f sibling
 * re-declares it (with byte-equality
 * drift detection). This sibling
 * follows the same pattern for
 * consistency: 1-line re-declaration
 * + source-anchor drift check (Test 5
 * in the source-anchors spec).
 *
 * **Why this is the first sibling that
 * imports `expect` from
 * `@playwright/test`.** The I-04f
 * sibling used `import type` only
 * (its helpers don't call `expect`).
 * Three of the 6 I-04g helpers
 * (`assertScreenshotHasDiagramContent`,
 * `assertLocatorUsesThemeBackground`,
 * `assertMermaidSourcePreviewFitsHorizontally`)
 * and `createDisposableDoc` all call
 * `expect(...)`. The sibling uses
 * `import { expect, type X, type Y, ... }
 * from "@playwright/test";` — mixed
 * runtime + type imports on one line,
 * matching the main-spec pattern at
 * lines 3-10. This is the standard
 * `isolatedModules`-safe import shape.
 *
 * **Callers.** The 6 helpers are used
 * by all 7 test() blocks in the main
 * spec, but with different frequencies:
 *
 * | Helper                                   | Count |
 * | ---------------------------------------- | ----- |
 * | `cleanupDoc`                             | 7     |
 * | `createDisposableDoc`                    | 7     |
 * | `typeSlashCommand`                       | 7     |
 * | `assertScreenshotHasDiagramContent`      | 5     |
 * | `assertLocatorUsesThemeBackground`       | 1     |
 * | `assertMermaidSourcePreviewFitsHorizontally` | 1 |
 *
 * The 3 `assert*` helpers have
 * non-uniform distribution because
 * different tests probe different
 * properties (e.g., the managed-frame
 * visibility test uses
 * `assertLocatorUsesThemeBackground`
 * once, but the complex-workflow
 * test uses
 * `assertScreenshotHasDiagramContent`
 * 3 times for the 4 Mermaid/GFX shape
 * families). None is dead code
 * (no zero counts).
 *
 * @see docs/dev/virgultum/refactor-roadmap.md
 *      §I (P-VIRG-ARCH-I-04g)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04f closeout for
 *      the http-helpers sibling pattern
 *      and F7 finding context)
 * @see docs/dev/virgultum/closeouts/phase-i.md
 *      (P-VIRG-ARCH-I-04g closeout)
 */

import {
  type APIRequestContext,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";

import { nativeGql } from "./virgultum-mermaid-block-http-helpers";

// Kept local because the helper is executable independently from the split
// declaration file. Browser behavior, not byte equality between test files,
// owns this endpoint contract.
const FRONTEND =
  process.env.MYOXUS_FRONTEND_BASE_URL ?? "http://localhost:3010";

// Moved entirely from
// `virgultum-mermaid-block.spec.ts`
// lines 113-121. The type has no consumer
// outside the `cleanupDoc` body. See file
// header "Why `PermanentDeleteData` moves
// entirely (option 1c)".
type PermanentDeleteData = {
  deleteDocumentsPermanently: {
    alreadyDeleted: number;
    deleted: number;
    failed: number;
    forbidden: number;
    rootMetaRemoved: number;
  };
};

export async function cleanupDoc(
  workspaceId: string,
  cookies: string[],
  docId: string,
  request: APIRequestContext,
): Promise<void> {
  const cleanupMutation = `mutation MermaidSmokeCleanup($input: DeleteDocumentsPermanentlyInput!) {
    deleteDocumentsPermanently(input: $input) {
      alreadyDeleted
      deleted
      failed
      forbidden
      rootMetaRemoved
    }
  }`;

  const { deleteDocumentsPermanently } = await nativeGql<PermanentDeleteData>(
    request,
    cookies,
    cleanupMutation,
    { input: { docIds: [docId], workspaceId } },
  );
  if (
    deleteDocumentsPermanently.failed > 0 ||
    deleteDocumentsPermanently.forbidden > 0
  ) {
    throw new Error(
      `Mermaid smoke cleanup failed: ${JSON.stringify(deleteDocumentsPermanently)}`,
    );
  }
}

export async function createDisposableDoc(
  page: Page,
  workspaceId: string,
): Promise<string> {
  // The Web shell can briefly render the workspace chooser if no last
  // workspace is known in a fresh Playwright context. Prime the same
  // browser-local workspace hint used by other Web smoke helpers before
  // navigating to the explicit workspace route.
  await page.addInitScript((id) => {
    localStorage.setItem("last_workspace_id", id);
  }, workspaceId);
  await page
    .evaluate((id) => {
      localStorage.setItem("last_workspace_id", id);
    }, workspaceId)
    .catch(() => undefined);

  await page.goto(`${FRONTEND}/workspace/${workspaceId}/all`, {
    waitUntil: "load",
    timeout: 30_000,
  });
  await expect(page.getByTestId("main-container")).toBeVisible({
    timeout: 20_000,
  });
  const newPageButton = page
    .getByTestId("new-page-button-trigger")
    .or(page.getByRole("button", { name: /^New doc$/ }))
    .or(page.getByRole("button", { name: /^Neue Seite$/ }))
    .first();
  await expect(newPageButton).toBeVisible({ timeout: 20_000 });
  await newPageButton.click();
  await expect(page).toHaveURL(/\/workspace\/[^/]+\/(?!all(?:$|\?))[^/?#]+/, {
    timeout: 20_000,
  });
  await expect(page.locator("[data-myoxus-editor-container]")).toBeVisible({
    timeout: 20_000,
  });

  const docId = page.url().split("/").findLast(Boolean);
  if (!docId || docId === "all") {
    throw new Error(`Could not derive Mermaid smoke doc id from ${page.url()}`);
  }
  return docId;
}

export async function typeSlashCommand(
  page: Page,
  command: string,
): Promise<void> {
  const editor = page.locator("[data-myoxus-editor-container]");
  await expect(editor).toBeVisible({ timeout: 20_000 });

  const blank = page.locator('[data-testid="page-editor-blank"]');
  if (await blank.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await blank.click();
  } else {
    await editor.click();
  }

  const lastLine = page.locator("v-line").last();
  await expect(lastLine).toBeVisible({ timeout: 10_000 });
  await lastLine.click({ timeout: 10_000 });

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const active = document.activeElement;
          return Boolean(
            active?.closest?.("rich-text") ||
            active?.closest?.("v-line") ||
            active?.closest?.("[data-myoxus-editor-container]") ||
            document.querySelector("rich-text")?.contains(active),
          );
        }),
      {
        message:
          "Mermaid slash-command smoke must focus the Virgultum rich-text host before typing.",
        timeout: 5_000,
      },
    )
    .toBe(true);

  await page.keyboard.press("Control+End");
  await page.keyboard.press("Enter");
  await page.keyboard.type(command);
}

export async function assertScreenshotHasDiagramContent(
  page: Page,
  clip: { height: number; width: number; x: number; y: number },
  label: string,
  minNonBackgroundPixels = 900,
): Promise<void> {
  const buffer = await page.screenshot({ clip });
  const stats = await page.evaluate(
    async ({ dataUrl }) => {
      const image = new Image();
      const load = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Could not decode screenshot"));
      });
      image.src = dataUrl;
      await load;

      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not create screenshot canvas context");
      ctx.drawImage(image, 0, 0);
      const { data, height, width } = ctx.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      );

      let nonBackgroundPixels = 0;
      let sampledPixels = 0;
      const background = [data[0], data[1], data[2]];

      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3];
        if (alpha < 200) continue;
        sampledPixels++;
        const red = data[index];
        const green = data[index + 1];
        const blue = data[index + 2];
        const distance = Math.hypot(
          red - background[0],
          green - background[1],
          blue - background[2],
        );
        if (distance > 35) nonBackgroundPixels++;
      }

      return { height, nonBackgroundPixels, sampledPixels, width };
    },
    { dataUrl: `data:image/png;base64,${buffer.toString("base64")}` },
  );

  expect(
    stats.nonBackgroundPixels,
    `${label} should contain non-background Mermaid pixels: ${JSON.stringify(
      stats,
    )}`,
  ).toBeGreaterThan(minNonBackgroundPixels);
}

export async function assertLocatorUsesThemeBackground(
  locator: Locator,
  label: string,
): Promise<void> {
  const background = await locator.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.backgroundColor = "var(--myoxus-background-primary-color)";
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    document.body.append(probe);
    const themeBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();

    let current: Element | null = element;
    while (current) {
      const candidate = getComputedStyle(current).backgroundColor;
      if (candidate !== "rgba(0, 0, 0, 0)" && candidate !== "transparent") {
        return { effectiveBackground: candidate, themeBackground };
      }
      current = current.parentElement;
    }
    return { effectiveBackground: "transparent", themeBackground };
  });

  expect(
    background.effectiveBackground,
    `${label} must inherit the projected primary theme background: ${JSON.stringify(
      background,
    )}`,
  ).toBe(background.themeBackground);
}

export async function assertMermaidSourcePreviewFitsHorizontally(
  mermaidBlock: Locator,
  label: string,
): Promise<void> {
  await expect(
    mermaidBlock.locator(".myoxus-mermaid-preview svg").first(),
    `${label} source preview should render an SVG`,
  ).toBeVisible({ timeout: 10_000 });

  const metrics = await mermaidBlock.evaluate((block) => {
    const preview = block.querySelector(
      ".myoxus-mermaid-preview",
    ) as HTMLElement | null;
    const svgElement = preview?.querySelector("svg") as SVGElement | null;
    if (!preview || !svgElement) return null;
    const previewRect = preview.getBoundingClientRect();
    const svgRect = svgElement.getBoundingClientRect();
    return {
      clientWidth: preview.clientWidth,
      previewLeft: previewRect.left,
      previewRight: previewRect.right,
      scrollWidth: preview.scrollWidth,
      svgLeft: svgRect.left,
      svgRight: svgRect.right,
      svgWidth: svgRect.width,
    };
  });
  if (!metrics) {
    throw new Error(`${label} source preview metrics were not available`);
  }
  expect(
    metrics.svgWidth,
    `${label} source preview SVG should be measurable: ${JSON.stringify(
      metrics,
    )}`,
  ).toBeGreaterThan(24);
  expect(
    metrics.svgLeft,
    `${label} source preview SVG must not clip on the left: ${JSON.stringify(
      metrics,
    )}`,
  ).toBeGreaterThanOrEqual(metrics.previewLeft - 1);
  expect(
    metrics.svgRight,
    `${label} source preview SVG must not clip on the right: ${JSON.stringify(
      metrics,
    )}`,
  ).toBeLessThanOrEqual(metrics.previewRight + 1);
  expect(
    metrics.scrollWidth,
    `${label} source preview must not create horizontal overflow: ${JSON.stringify(
      metrics,
    )}`,
  ).toBeLessThanOrEqual(metrics.clientWidth + 1);
}
