import "../declare-test-window.js";

import {
  type ConsoleMessage,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import type { ListType } from "@virgultum/editor/model";
import type { RichText } from "@virgultum/editor/rich-text";
import type { EditorHost } from "@virgultum/editor/std";
import type {
  InlineRange,
  InlineRootElement,
} from "@virgultum/editor/std/inline";
import {
  type BlockModel,
  type BlockSnapshot,
  uuidv4,
} from "@virgultum/editor/store";
import type { TestMyoxusEditorContainer } from "@virgultum/integration-test";
import stringify from "json-stable-stringify";
import lz from "lz-string";

import { ZERO_WIDTH_FOR_EMPTY_LINE } from "../inline-editor.js";
import { currentEditorIndex } from "../multiple-editor.js";
import {
  pressEnter,
  pressSpace,
  pressTab,
  SHORT_KEY,
  type,
} from "./keyboard.js";

export const defaultPlaygroundURL = new URL(
  `http://localhost:${process.env.CI ? 4173 : 5173}/`,
);

const NEXT_FRAME_TIMEOUT = 50;
const DEFAULT_PLAYGROUND = defaultPlaygroundURL.toString();
const RICH_TEXT_SELECTOR = ".inline-editor";

function stringifySnapshotJson(value: unknown) {
  const stableJson = stringify(value);

  // Keep deterministic key ordering from json-stable-stringify while delegating
  // pretty printing to JSON.stringify. The latter preserves the repository's
  // established inline formatting for empty arrays/objects in E2E snapshots.
  return `${JSON.stringify(JSON.parse(stableJson), null, 2)}\n`;
}

function generateRandomRoomId() {
  return `playwright-${uuidv4()}`;
}

export const getSelectionRect = async (page: Page): Promise<DOMRect> => {
  const rect = await page.evaluate(() => {
    return getSelection()?.getRangeAt(0).getBoundingClientRect();
  });
  if (!rect) {
    throw new Error("rect is not found");
  }
  return rect;
};

export const getEditorLocator = (page: Page) => {
  return page.locator("myoxus-editor-container").nth(currentEditorIndex);
};

export const getEditorHostLocator = (page: Page) => {
  return page.locator("editor-host").nth(currentEditorIndex);
};

type TaggedConsoleMessage = ConsoleMessage & { __ignore?: boolean };
function ignoredLog(message: ConsoleMessage) {
  (message as TaggedConsoleMessage).__ignore = true;
}
function isIgnoredLog(
  message: ConsoleMessage,
): message is TaggedConsoleMessage {
  return "__ignore" in message && !!message.__ignore;
}

/**
 * Expect console message to be called in the test.
 *
 * This function **should** be called before the `enterPlaygroundRoom` function!
 *
 * ```ts
 * expectConsoleMessage(page, 'Failed to load resource'); // Default type is 'error'
 * expectConsoleMessage(page, '[vite] connected.', 'warning'); // Specify type
 * ```
 */
export function expectConsoleMessage(
  page: Page,
  logPrefixOrRegex: string | RegExp,
  type:
    | "log"
    | "debug"
    | "info"
    | "error"
    | "warning"
    | "dir"
    | "dirxml"
    | "table"
    | "trace"
    | "clear"
    | "startGroup"
    | "startGroupCollapsed"
    | "endGroup"
    | "assert"
    | "profile"
    | "profileEnd"
    | "count"
    | "timeEnd" = "error",
) {
  page.on("console", (message: ConsoleMessage) => {
    const sameType = message.type() === type;
    const textMatch =
      logPrefixOrRegex instanceof RegExp
        ? logPrefixOrRegex.test(message.text())
        : message.text().startsWith(logPrefixOrRegex);
    if (sameType && textMatch) {
      ignoredLog(message);
    }
  });
}

export type PlaygroundRoomOptions = {
  room?: string;
  blobSource?: ("idb" | "mock")[];
  noInit?: boolean;
};
export async function enterPlaygroundRoom(
  page: Page,
  ops?: PlaygroundRoomOptions,
) {
  const url = new URL(DEFAULT_PLAYGROUND);
  let room = ops?.room;
  const blobSource = ops?.blobSource;
  if (!room) {
    room = generateRandomRoomId();
  }
  url.searchParams.set("room", room);
  url.searchParams.set("blobSource", blobSource?.join(",") || "idb");
  if (ops?.noInit) {
    url.searchParams.set("noInit", "true");
  }
  await page.goto(url.toString());

  // See https://github.com/microsoft/playwright/issues/5546
  page.on("console", (message) => {
    if (
      [
        // React devtools:
        "%cDownload the React DevTools for a better development experience: https://reactjs.org/link/react-devtools font-weight:bold",
        // Vite:
        "[vite] connected.",
        "[vite] connecting...",
        // Figma embed:
        "Fullscreen: Using 4GB WASM heap",
        // Lit:
        "Lit is in dev mode. Not recommended for production! See https://lit.dev/msg/dev-mode for more information.",
        // Figma embed:
        "Running frontend commit",
        // Github timeout:
        "Failed to load resource: the server responded with a status of 403",
        // font download warning:
        '[JavaScript Warning: "downloadable font:',
      ].some((text) => message.text().startsWith(text))
    ) {
      return;
    }
    const ignore = isIgnoredLog(message) || !process.env.CI;
    if (!ignore) {
      expect
        .soft("Unexpected console message: " + message.text())
        .toBe(
          'Please remove the "console.log" or declare `expectConsoleMessage` before `enterPlaygroundRoom`. It is advised not to output logs in a production environment.',
        );
    }
    console.log(`Console ${message.type()}: ${message.text()}`);
  });

  // Log all uncaught errors
  page.on("pageerror", (exception) => {
    throw new Error(`Uncaught exception: "${exception}"\n${exception.stack}`);
  });

  const locator = page.locator("myoxus-editor-container");
  await locator.isVisible();
  await page.evaluate(async () => {
    const dom = document.querySelector<TestMyoxusEditorContainer>(
      "myoxus-editor-container",
    );
    if (dom) {
      await dom.updateComplete;
    }
  });

  await page.evaluate(() => {
    if (typeof window.$virgultum !== "object") {
      throw new Error("window.$virgultum is not object");
    }
  }, []);
  return room;
}

export async function waitDefaultPageLoaded(page: Page) {
  await page.waitForSelector('myoxus-page-root[data-block-id="0"]');
}

export async function waitEmbedLoaded(page: Page) {
  await page.waitForSelector(".resizable-img");
}

export async function waitNextFrame(
  page: Page,
  frameTimeout = NEXT_FRAME_TIMEOUT,
) {
  await page.waitForTimeout(frameTimeout);
}

export async function clearLog(page: Page) {
  await page.evaluate(() => console.clear());
}

export async function captureHistory(page: Page) {
  await page.evaluate(() => {
    window.doc.captureSync();
  });
}

export async function resetHistory(page: Page) {
  await page.evaluate(() => {
    const space = window.doc;
    space.resetHistory();
  });
}

// XXX: This doesn't add surface yet, the page state should not be switched to edgeless.
export async function enterPlaygroundWithList(
  page: Page,
  contents: string[] = ["", "", ""],
  type: ListType = "bulleted",
) {
  const room = generateRandomRoomId();
  await page.goto(`${DEFAULT_PLAYGROUND}?room=${room}`);

  await page.evaluate(
    ({ contents, type }: { contents: string[]; type: ListType }) => {
      const { doc } = window;
      const rootId =
        doc.root?.id ??
        doc.addBlock("myoxus:page", {
          title: new window.$virgultum.store.Text(),
        });
      const noteId = doc.addBlock("myoxus:note", {}, rootId);
      // oxlint-disable-next-line typescript/prefer-for-of
      for (let i = 0; i < contents.length; i++) {
        doc.addBlock(
          "myoxus:list",
          contents.length > 0
            ? { text: new window.$virgultum.store.Text(contents[i]), type }
            : { type },
          noteId,
        );
      }
    },
    { contents, type },
  );
  await waitNextFrame(page);
}

export async function addNoteFixture(page: Page) {
  await page.evaluate(() => {
    const { doc } = window;
    if (!doc.root)
      throw new Error("Note fixture requires a mounted document root");
    doc.captureSync();
    doc.transact(() => {
      const noteId = doc.addBlock("myoxus:note", {}, doc.root!.id);
      doc.addBlock("myoxus:paragraph", {}, noteId);
    });
    doc.captureSync();
  });
}

// XXX: This doesn't add surface yet, the doc state should not be switched to edgeless.
export async function initEmptyParagraphState(page: Page, rootId?: string) {
  const ids = await page.evaluate((rootId) => {
    const { doc } = window;
    doc.captureSync();
    if (!rootId) {
      rootId =
        doc.root?.id ??
        doc.addBlock("myoxus:page", {
          title: new window.$virgultum.store.Text(),
        });
    }

    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    const paragraphId = doc.addBlock("myoxus:paragraph", {}, noteId);
    // doc.addBlock('myoxus:surface', {}, rootId);
    doc.captureSync();

    return { rootId, noteId, paragraphId };
  }, rootId);
  return ids;
}

export async function initMultipleNoteWithParagraphState(
  page: Page,
  rootId?: string,
  count = 2,
) {
  const ids = await page.evaluate(
    ({ rootId, count }) => {
      const { doc } = window;
      doc.captureSync();
      if (!rootId) {
        rootId =
          doc.root?.id ??
          doc.addBlock("myoxus:page", {
            title: new window.$virgultum.store.Text(),
          });
      }

      const ids = Array.from({ length: count })
        .fill(0)
        .map(() => {
          const noteId = doc.addBlock("myoxus:note", {}, rootId);
          const paragraphId = doc.addBlock("myoxus:paragraph", {}, noteId);
          return { noteId, paragraphId };
        });

      // doc.addBlock('myoxus:surface', {}, rootId);
      doc.captureSync();

      return { rootId, ids };
    },
    { rootId, count },
  );
  return ids;
}

export async function initEmptyEdgelessState(page: Page) {
  const ids = await page.evaluate(() => {
    const { doc } = window;
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    const surfaceId =
      doc.getBlocksByFlavour("myoxus:surface")[0]?.id ??
      doc.addBlock("myoxus:surface", {}, rootId);
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    const paragraphId = doc.addBlock("myoxus:paragraph", {}, noteId);

    doc.resetHistory();

    return { rootId, surfaceId, noteId, paragraphId };
  });
  return ids;
}

/**
 * Erstellt einen Page-Mode-Zustand mit Surface-Block, aber ohne
 * Notes. Edgeless-Mode braucht zwingend eine Surface (sonst
 * `VirgultumError: This doc is missing surface block in edgeless.`,
 * siehe D-FIND-10), aber M07 erwartet keine Notes.
 *
 * Diese Variante ist die Vorstufe zum Edgeless-Mode ohne
 * sichtbaren Inhalt - ein gueltiger Zustand fuer den M07-Capture.
 */
export async function initEmptySurfaceState(page: Page) {
  const ids = await page.evaluate(() => {
    const { doc } = window;
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    const surfaceId =
      doc.getBlocksByFlavour("myoxus:surface")[0]?.id ??
      doc.addBlock("myoxus:surface", {}, rootId);
    doc.resetHistory();
    return { rootId, surfaceId };
  });
  return ids;
}

export async function initEmptyCodeBlockState(
  page: Page,
  codeBlockProps = {} as { language?: string },
) {
  const ids = await page.evaluate((codeBlockProps) => {
    const { doc } = window;
    doc.captureSync();
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    const noteId = doc.addBlock("myoxus:note", {}, rootId);
    const codeBlockId = doc.addBlock("myoxus:code", codeBlockProps, noteId);
    doc.captureSync();

    return { rootId, noteId, codeBlockId };
  }, codeBlockProps);
  await page.waitForSelector(`[data-block-id="${ids.codeBlockId}"] rich-text`);
  return ids;
}

type FocusRichTextOptions = {
  clickPosition?: { x: number; y: number };
};

export async function focusRichText(
  page: Page,
  i = 0,
  options?: FocusRichTextOptions,
) {
  await page.mouse.move(0, 0);
  const editor = getEditorHostLocator(page);
  const locator = editor.locator(RICH_TEXT_SELECTOR).nth(i);
  // need to set `force` to true when clicking on `myoxus-selected-blocks`
  await locator.click({ force: true, position: options?.clickPosition });
  // Commands consume the projected inline range, not the pointer event. Await
  // that existing handoff so setup cannot dispatch Tab against the prior block.
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const selection = element.ownerDocument.getSelection();
        if (!selection?.rangeCount || !element.contains(selection.anchorNode))
          return false;
        const inlineEditor =
          element.closest<RichText>("rich-text")?.inlineEditor;
        if (!inlineEditor) return false;
        const nativeRange = inlineEditor.toInlineRange(selection.getRangeAt(0));
        const projectedRange = inlineEditor.getInlineRange();
        return (
          !!nativeRange &&
          !!projectedRange &&
          nativeRange.index === projectedRange.index &&
          nativeRange.length === projectedRange.length
        );
      }),
    )
    .toBe(true);
}

export async function focusRichTextEnd(page: Page, i = 0) {
  await page.evaluate(
    ([i, currentEditorIndex]) => {
      const editorHost =
        document.querySelectorAll("editor-host")[currentEditorIndex];
      const richTexts = Array.from(editorHost.querySelectorAll("rich-text"));

      richTexts[i].inlineEditor?.focusEnd();
    },
    [i, currentEditorIndex],
  );
  await waitNextFrame(page);
}

export async function initThreeParagraphs(page: Page) {
  await focusRichText(page);
  await type(page, "123");
  await pressEnter(page);
  await type(page, "456");
  await pressEnter(page);
  await type(page, "789");
  await resetHistory(page);
}

export async function initSixParagraphs(page: Page) {
  await focusRichText(page);
  await type(page, "1");
  await pressEnter(page);
  await type(page, "2");
  await pressEnter(page);
  await type(page, "3");
  await pressEnter(page);
  await type(page, "4");
  await pressEnter(page);
  await type(page, "5");
  await pressEnter(page);
  await type(page, "6");
  await resetHistory(page);
}

export async function initThreeLists(page: Page) {
  await focusRichText(page);
  await type(page, "-");
  await pressSpace(page);
  await type(page, "123");
  await pressEnter(page);
  await type(page, "456");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "789");
}

export async function insertThreeLevelLists(page: Page, i = 0) {
  await focusRichText(page, i);
  await type(page, "-");
  await pressSpace(page);
  await type(page, "123");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "456");
  await pressEnter(page);
  await pressTab(page);
  await type(page, "789");
}

export async function initThreeDividers(page: Page) {
  await focusRichText(page);
  await type(page, "123");
  await pressEnter(page);
  await type(page, "---");
  await pressSpace(page);
  await type(page, "---");
  await pressSpace(page);
  await type(page, "---");
  await pressSpace(page);
  await type(page, "123");
}

export async function initParagraphsByCount(page: Page, count: number) {
  await focusRichText(page);
  for (let i = 0; i < count; i++) {
    await type(page, `paragraph ${i}`);
    await pressEnter(page);
  }
  await resetHistory(page);
}

export async function getInlineSelectionIndex(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection() as Selection;

    const range = selection.getRangeAt(0);
    const component = range.startContainer.parentElement?.closest("rich-text");
    const index = component?.inlineEditor?.getInlineRange()?.index;
    return index !== undefined ? index : -1;
  });
}

export async function getInlineSelectionText(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection() as Selection;
    const range = selection.getRangeAt(0);
    const component = range.startContainer.parentElement?.closest("rich-text");
    return component?.inlineEditor?.yText.toString() ?? "";
  });
}

export async function getSelectedTextByInlineEditor(page: Page) {
  return page.evaluate(() => {
    const selection = window.getSelection() as Selection;
    const range = selection.getRangeAt(0);
    const component = range.startContainer.parentElement?.closest("rich-text");

    const inlineRange = component?.inlineEditor?.getInlineRange();
    if (!inlineRange) return "";

    const { index, length } = inlineRange;
    return (
      component?.inlineEditor?.yText.toString().slice(index, index + length) ||
      ""
    );
  });
}

export async function getSelectedText(page: Page) {
  return page.evaluate(() => {
    let content = "";
    const selection = window.getSelection() as Selection;

    if (selection.rangeCount === 0) return content;

    const range = selection.getRangeAt(0);
    const components =
      range.commonAncestorContainer.parentElement?.querySelectorAll(
        "rich-text",
      ) || [];

    components.forEach((component) => {
      const inlineRange = component.inlineEditor?.getInlineRange();
      if (!inlineRange) return;
      const { index, length } = inlineRange;
      content +=
        component?.inlineEditor?.yText
          .toString()
          .slice(index, index + length) || "";
    });

    return content;
  });
}

export async function setInlineRangeInSelectedRichText(
  page: Page,
  index: number,
  length: number,
) {
  await page.evaluate(
    ({ index, length }) => {
      const selection = window.getSelection() as Selection;

      const range = selection.getRangeAt(0);
      const component =
        range.startContainer.parentElement?.closest("rich-text");
      component?.inlineEditor?.setInlineRange({
        index,
        length,
      });
    },
    { index, length },
  );
  await waitNextFrame(page);
}

export async function setInlineRangeInInlineEditor(
  page: Page,
  inlineRange: InlineRange,
  i = 0,
) {
  await page.evaluate(
    ({ i, inlineRange }) => {
      const inlineEditor = document.querySelectorAll<InlineRootElement>(
        '[data-v-root="true"]',
      )[i]?.inlineEditor;
      if (!inlineEditor) {
        throw new Error("Cannot find inline editor");
      }
      inlineEditor.setInlineRange(inlineRange);
    },
    { i, inlineRange },
  );
  await waitNextFrame(page);
}

export async function pasteContent(
  page: Page,
  clipData: Record<string, unknown>,
) {
  await page.evaluate(
    ({ clipData }) => {
      const e = new ClipboardEvent("paste", {
        clipboardData: new DataTransfer(),
      });
      Object.defineProperty(e, "target", {
        writable: false,
        value: document,
      });
      Object.keys(clipData).forEach((key) => {
        e.clipboardData?.setData(key, clipData[key] as string);
      });
      document.dispatchEvent(e);
    },
    { clipData },
  );
  await waitNextFrame(page);
}

export async function pasteTestImage(page: Page) {
  await page.evaluate(async () => {
    const resp = await fetch(`${location.origin}/test-card-1.png`);
    const blob = await resp.blob();
    const file = new File([blob], "test-card-1.png", {
      type: "image/png",
    });
    const e = new ClipboardEvent("paste", {
      clipboardData: new DataTransfer(),
    });

    Object.defineProperty(e, "target", {
      writable: false,
      value: document,
    });

    e.clipboardData?.items.add(file);
    document.dispatchEvent(e);
  });
  await waitNextFrame(page);
}

export async function getClipboardHTML(page: Page) {
  const dataInClipboard = await page.evaluate(async () => {
    function format(node: HTMLElement, level: number) {
      const indentBefore = "  ".repeat(level++);
      const indentAfter = "  ".repeat(level >= 2 ? level - 2 : 0);
      let textNode;

      // oxlint-disable-next-line typescript/prefer-for-of
      for (let i = 0; i < node.children.length; i++) {
        textNode = document.createTextNode("\n" + indentBefore);
        node.insertBefore(textNode, node.children[i]);

        format(node.children[i] as HTMLElement, level);

        if (node.lastElementChild === node.children[i]) {
          textNode = document.createTextNode("\n" + indentAfter);
          node.append(textNode);
        }
      }

      return node;
    }
    const clipItems = await navigator.clipboard.read();
    const item = clipItems.find((item) => item.types.includes("text/html"));
    const data = await item?.getType("text/html");
    const text = await data?.text();
    const html = new DOMParser().parseFromString(text ?? "", "text/html");
    const container = html.querySelector<HTMLDivElement>(
      "[data-virgultum-snapshot]",
    );
    if (!container) {
      return "";
    }
    return format(container, 0).innerHTML.trim();
  });

  return dataInClipboard;
}

export async function getClipboardText(page: Page) {
  const dataInClipboard = await page.evaluate(async () => {
    const clipItems = await navigator.clipboard.read();
    const item = clipItems.find((item) => item.types.includes("text/plain"));
    const data = await item?.getType("text/plain");
    const text = await data?.text();
    return text ?? "";
  });
  return dataInClipboard;
}

export async function getClipboardCustomData(page: Page, type: string) {
  const dataInClipboard = await page.evaluate(async () => {
    const clipItems = await navigator.clipboard.read();
    const item = clipItems.find((item) => item.types.includes("text/html"));
    const data = await item?.getType("text/html");
    const text = await data?.text();
    const html = new DOMParser().parseFromString(text ?? "", "text/html");
    const container = html.querySelector<HTMLDivElement>(
      "[data-virgultum-snapshot]",
    );
    return container?.dataset.virgultumSnapshot ?? "";
  });

  const decompressed = lz.decompressFromEncodedURIComponent(dataInClipboard);
  try {
    const json = JSON.parse(decompressed) as Record<string, unknown>;
    return json[type];
  } catch {
    throw new Error(`Invalid snapshot in clipboard: ${dataInClipboard}`);
  }
}

export async function getClipboardSnapshot(page: Page) {
  const dataInClipboard = await getClipboardCustomData(
    page,
    "VIRGULTUM/SNAPSHOT",
  );
  if (!dataInClipboard) {
    throw new Error("dataInClipboard is not found");
  }
  const json = JSON.parse(dataInClipboard as string);
  return json;
}

export async function getPageSnapshot(
  page: Page,
  toJSON: true,
): Promise<string>;
export async function getPageSnapshot(
  page: Page,
  toJSON?: false,
): Promise<unknown>;
export async function getPageSnapshot(page: Page, toJSON?: boolean) {
  const json = await page.evaluate(() => {
    const { job, doc } = window;
    const snapshot = job.docToSnapshot(doc);
    if (!snapshot) {
      throw new Error("Failed to get snapshot");
    }
    return snapshot.blocks;
  });
  if (toJSON) {
    return stringifySnapshotJson(json);
  }
  return json;
}

/** Text-operation evidence excludes ambient Note colour, not inline styling.
 * Never use this projection for clipboard, theme or persistence fidelity. */
export async function getTextOperationSnapshot(page: Page): Promise<string> {
  const snapshot = (await getPageSnapshot(page)) as BlockSnapshot;
  const visit = (block: BlockSnapshot) => {
    if (block.flavour === "myoxus:note") delete block.props.background;
    block.children.forEach(visit);
  };
  visit(snapshot);
  return stringifySnapshotJson(snapshot);
}

export async function setSelection(
  page: Page,
  anchorBlockId: number,
  anchorOffset: number,
  focusBlockId: number,
  focusOffset: number,
) {
  await page.evaluate(
    ({
      anchorBlockId,
      anchorOffset,
      focusBlockId,
      focusOffset,
      currentEditorIndex,
    }) => {
      const editorHost =
        document.querySelectorAll("editor-host")[currentEditorIndex];
      const anchorRichText = editorHost.querySelector<RichText>(
        `[data-block-id="${anchorBlockId}"] rich-text`,
      )!;
      const anchorRichTextRange = anchorRichText.inlineEditor!.toDomRange({
        index: anchorOffset,
        length: 0,
      })!;
      const focusRichText = editorHost.querySelector<RichText>(
        `[data-block-id="${focusBlockId}"] rich-text`,
      )!;
      const focusRichTextRange = focusRichText.inlineEditor!.toDomRange({
        index: focusOffset,
        length: 0,
      })!;

      const sl = getSelection();
      if (!sl) throw new Error("Cannot get selection");
      const range = document.createRange();
      range.setStart(
        anchorRichTextRange.startContainer,
        anchorRichTextRange.startOffset,
      );
      range.setEnd(
        focusRichTextRange.startContainer,
        focusRichTextRange.startOffset,
      );
      sl.removeAllRanges();
      sl.addRange(range);
    },
    {
      anchorBlockId,
      anchorOffset,
      focusBlockId,
      focusOffset,
      currentEditorIndex,
    },
  );
}

export async function readClipboardText(
  page: Page,
  type: "input" | "textarea" = "input",
) {
  const id = "clipboard-test";
  const selector = `#${id}`;
  await page.evaluate(
    ({ type, id }) => {
      const input = document.createElement(type);
      input.setAttribute("id", id);
      document.body.append(input);
    },
    { type, id },
  );
  const input = page.locator(selector);
  await input.focus();
  await page.keyboard.press(`${SHORT_KEY}+v`);
  const text = await input.inputValue();
  await page.evaluate(
    ({ selector }) => {
      const input = document.querySelector(selector);
      input?.remove();
    },
    { selector },
  );
  return text;
}

export const getCenterPositionByLocator: (
  page: Page,
  locator: Locator,
) => Promise<{ x: number; y: number }> = async (
  _page: Page,
  locator: Locator,
) => {
  const box = await locator.boundingBox();
  if (!box) {
    throw new Error("Failed to getCenterPosition! Can't get bounding box");
  }
  return {
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  };
};

export async function getBoundingBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Missing column box");
  return box;
}

export async function getBlockModel<Model extends BlockModel>(
  page: Page,
  blockId: string,
) {
  const result: BlockModel | null | undefined = await page.evaluate(
    (blockId) => {
      return window.doc?.getBlock(blockId)?.model;
    },
    blockId,
  );
  expect(result).not.toBeNull();
  return result as Model;
}

export async function getIndexCoordinate(
  page: Page,
  [richTextIndex, vIndex]: [number, number],
  coordOffSet: { x: number; y: number } = { x: 0, y: 0 },
) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const coord = await page.evaluate(
      ({ richTextIndex, vIndex, coordOffSet, currentEditorIndex }) => {
        const editorHost =
          document.querySelectorAll("editor-host")[currentEditorIndex];
        const richTexts = Array.from(
          editorHost?.querySelectorAll("rich-text") ?? [],
        );
        if (!richTexts.length) {
          return null;
        }
        const richText = richTexts[
          Math.min(richTextIndex, richTexts.length - 1)
        ] as any;
        const inlineEditor = richText?.inlineEditor;
        if (!inlineEditor) {
          return null;
        }
        const clampedIndex = Math.max(
          0,
          Math.min(vIndex, inlineEditor.yTextLength ?? vIndex),
        );
        const domRange = inlineEditor.toDomRange({
          index: clampedIndex,
          length: 0,
        });
        if (!domRange) {
          return null;
        }
        const pointBound = domRange.getBoundingClientRect();
        if (
          !Number.isFinite(pointBound.left) ||
          !Number.isFinite(pointBound.top)
        ) {
          return null;
        }
        return {
          x: pointBound.left + coordOffSet.x,
          y: pointBound.top + pointBound.height / 2 + coordOffSet.y,
        };
      },
      {
        richTextIndex,
        vIndex,
        coordOffSet,
        currentEditorIndex,
      },
    );
    if (coord) {
      return coord;
    }
    await page.waitForTimeout(50);
  }

  throw new Error(
    `Failed to get index coordinate: richTextIndex=${richTextIndex}, vIndex=${vIndex}`,
  );
}

export function inlineEditorInnerTextToString(innerText: string): string {
  return innerText.replace(ZERO_WIDTH_FOR_EMPTY_LINE, "").trim();
}

export async function focusTitle(page: Page) {
  await page.locator("doc-title rich-text").click();
  await page.evaluate((i) => {
    const docTitle = document.querySelectorAll("doc-title")[i];
    if (!docTitle) {
      throw new Error("Doc title component not found");
    }
    const docTitleRichText = docTitle.querySelector("rich-text");
    if (!docTitleRichText) {
      throw new Error("Doc title rich text component not found");
    }
    if (!docTitleRichText.inlineEditor) {
      throw new Error("Doc title inline editor not found");
    }
    docTitleRichText.inlineEditor.focusEnd();
  }, currentEditorIndex);
  await waitNextFrame(page, 200);
}

/**
 * XXX: this is a workaround for the bug in Playwright
 */
export async function shamefullyBlurActiveElement(page: Page) {
  await page.evaluate(() => {
    if (
      !document.activeElement ||
      !(document.activeElement instanceof HTMLElement)
    ) {
      throw new Error("document.activeElement doesn't exist");
    }
    document.activeElement.blur();
  });
}

/**
 * FIXME:
 * Sometimes inline editor state is not updated in time. Bad case like below:
 *
 * ```
 * await focusRichText(page);
 * await type(page, 'hello');
 * await assertRichTexts(page, ['hello']);
 * ```
 *
 * output(failed or flaky):
 *
 * ```
 * - Expected  - 1
 * + Received  + 1
 *   Array [
 * -   "hello",
 * +   "ello",
 *   ]
 * ```
 *
 */
export async function waitForInlineEditorStateUpdated(page: Page) {
  return page.evaluate(async () => {
    const selection = window.getSelection() as Selection;

    if (selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    const component = range.startContainer.parentElement?.closest("rich-text");
    await component?.inlineEditor?.waitForUpdate();
  });
}

export async function initImageState(page: Page, prependParagraph = false) {
  await page.evaluate(async (prepend) => {
    const { doc } = window;
    const rootId =
      doc.root?.id ??
      doc.addBlock("myoxus:page", {
        title: new window.$virgultum.store.Text(),
      });
    const noteId = doc.addBlock("myoxus:note", {}, rootId);

    await new Promise((res) => setTimeout(res, 200));

    const pageRoot = document.querySelector("myoxus-page-root");
    if (!pageRoot) throw new Error("Cannot find doc page");
    const imageBlob = await fetch(`${location.origin}/test-card-1.png`).then(
      (response) => response.blob(),
    );
    const storage = pageRoot.store.blobSync;
    const sourceId = await storage.set(imageBlob);
    if (prepend) {
      doc.addBlock("myoxus:paragraph", {}, noteId);
    }
    const imageId = doc.addBlock(
      "myoxus:image",
      {
        sourceId,
      },
      noteId,
    );

    doc.resetHistory();

    return { rootId, noteId, imageId };
  }, prependParagraph);

  // due to pasting img calls fetch, so we need timeout for downloading finished.
  await page.waitForTimeout(500);
}

export async function getCurrentEditorDocId(page: Page) {
  return page.evaluate((index) => {
    const editor = document.querySelectorAll("myoxus-editor-container")[index];
    if (!editor) throw new Error("Can't find myoxus-editor-container");
    const docId = editor.doc.id;
    return docId;
  }, currentEditorIndex);
}

export async function getCurrentThemeCSSPropertyValue(
  page: Page,
  property: string,
) {
  const value = await page
    .locator("myoxus-editor-container")
    .evaluate(
      (_, property) =>
        window
          .getComputedStyle(document.documentElement)
          .getPropertyValue(property)
          .trim(),
      property,
    );
  return value;
}

export async function scrollToTop(page: Page) {
  await page.mouse.wheel(0, -1000);

  await page.waitForFunction(() => {
    const scrollContainer = document.querySelector(".myoxus-page-viewport");
    if (!scrollContainer) {
      throw new Error("Can't find scroll container");
    }
    return scrollContainer.scrollTop < 10;
  });
}

export async function scrollToBottom(page: Page) {
  // await page.mouse.wheel(0, 1000);

  await page
    .locator(".myoxus-page-viewport")
    .evaluate((node) =>
      node.scrollTo({ left: 0, top: 1000, behavior: "smooth" }),
    );
  // TODO switch to `scrollend`
  // See https://developer.chrome.com/en/blog/scrollend-a-new-javascript-event/
  await page.waitForFunction(() => {
    const scrollContainer = document.querySelector(".myoxus-page-viewport");
    if (!scrollContainer) {
      throw new Error("Can't find scroll container");
    }

    return (
      // Wait for scrolled to the bottom
      // Refer to https://stackoverflow.com/questions/3898130/check-if-a-user-has-scrolled-to-the-bottom-not-just-the-window-but-any-element
      Math.abs(
        scrollContainer.scrollHeight -
          scrollContainer.scrollTop -
          scrollContainer.clientHeight,
      ) < 10
    );
  });
}

export async function mockParseDocUrlService(
  page: Page,
  mapping: Record<string, string>,
) {
  await getEditorHostLocator(page).evaluate((host: EditorHost, mapping) => {
    // URL parsing is supplied by the workspace host in Web, not by the
    // standalone editor. The running provider owns a cloned container; bind
    // this fixture there, on the current host (mode switches replace hosts).
    host.std.provider.container.addImpl(
      window.$virgultum.services.ParseDocUrlProvider,
      {
        parseDocUrl(url: string) {
          const docId = mapping[url];
          return docId ? { docId } : undefined;
        },
      },
    );
  }, mapping);
}
