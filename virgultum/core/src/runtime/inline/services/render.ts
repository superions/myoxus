import {
  ErrorCode,
  VirgultumError,
} from "../../../primitives/exceptions/index";
import type { BaseTextAttributes } from "../../../store/index";
import * as Y from "yjs";

import { VLine } from "../components/v-line.js";
import type { InlineEditor } from "../inline-editor.js";
import type { InlineRange } from "../types.js";
import { deltaInsertsToChunks } from "../utils/delta-convert.js";

export class RenderService<TextAttributes extends BaseTextAttributes> {
  private _pendingRemoteInlineRangeSync = false;

  private _carriageReturnValidationCounter = 0;

  private _renderVersion = 0;

  private readonly _syncRemoteInlineRange = () => {
    const inlineRange = this.editor.inlineRange$.peek();
    if (!inlineRange) return;

    const lastStartRelativePosition = this.editor.lastStartRelativePosition;
    const lastEndRelativePosition = this.editor.lastEndRelativePosition;
    if (!lastStartRelativePosition || !lastEndRelativePosition) return;

    const doc = this.editor.yText.doc;
    if (!doc) {
      console.error("doc is not found when syncing yText");
      return;
    }
    const absoluteStart = Y.createAbsolutePositionFromRelativePosition(
      lastStartRelativePosition,
      doc,
    );
    const absoluteEnd = Y.createAbsolutePositionFromRelativePosition(
      lastEndRelativePosition,
      doc,
    );

    const startIndex = absoluteStart?.index;
    const endIndex = absoluteEnd?.index;
    if (startIndex == null || endIndex == null) return;

    const newInlineRange: InlineRange = {
      index: startIndex,
      length: endIndex - startIndex,
    };
    if (!this.editor.isValidInlineRange(newInlineRange)) return;

    this.editor.setInlineRange(newInlineRange);
  };

  private readonly _onYTextChange = (
    _: Y.YTextEvent,
    transaction: Y.Transaction,
  ) => {
    this.editor.slots.textChange.next();

    const yText = this.editor.yText;

    if (
      (this._carriageReturnValidationCounter++ & 0x3f) === 0 &&
      yText.toString().includes("\r")
    ) {
      throw new VirgultumError(
        ErrorCode.InlineEditorError,
        'yText must not contain "\\r" because it will break the range synchronization',
      );
    }

    if (!transaction.local) {
      this._pendingRemoteInlineRangeSync = true;
    }

    this.render();
  };

  mount = () => {
    const editor = this.editor;
    const yText = editor.yText;

    yText.observe(this._onYTextChange);
    editor.disposables.add({
      dispose: () => {
        yText.unobserve(this._onYTextChange);
        this._pendingRemoteInlineRangeSync = false;
      },
    });
  };

  private _rendering = false;
  get rendering() {
    return this._rendering;
  }
  // render current deltas to VLines
  render = () => {
    if (!this.editor.rootElement) return;

    const renderVersion = ++this._renderVersion;
    this._rendering = true;

    const rootElement = this.editor.rootElement;
    const embedDeltas = this.editor.deltaService.embedDeltas;
    const chunks = deltaInsertsToChunks(
      embedDeltas,
      (delta) => typeof this.editor.isEmbed(delta) === "string",
    );

    let offset = 0;
    let next = rootElement.firstChild;
    for (const [index, chunk] of chunks.entries()) {
      const line =
        next instanceof VLine
          ? next
          : rootElement.ownerDocument.createElement("v-line");
      if (line !== next) rootElement.insertBefore(line, next);
      line.updateLine(chunk, index, offset);
      offset = line.endOffset + 1;
      next = line.nextSibling;
    }
    while (next) {
      const rest = next.nextSibling;
      next.remove();
      next = rest;
    }

    this.editor
      .waitForUpdate()
      .then(() => {
        if (renderVersion !== this._renderVersion) return;
        if (this._pendingRemoteInlineRangeSync) {
          this._pendingRemoteInlineRangeSync = false;
          this._syncRemoteInlineRange();
        }
        this._rendering = false;
        this.editor.slots.renderComplete.next();
        this.editor.syncInlineRange();
      })
      .catch((error) => {
        if (renderVersion === this._renderVersion) {
          this._rendering = false;
        }
        console.error(error);
      });
  };

  rerenderWholeEditor = () => {
    const rootElement = this.editor.rootElement;

    if (!rootElement || !rootElement.isConnected) return;

    rootElement.replaceChildren();
    this.render();
  };

  waitForUpdate = async () => {
    if (!this.editor.rootElement) return;
    const vLines = Array.from(
      this.editor.rootElement.querySelectorAll("v-line"),
    );
    await Promise.all(vLines.map((line) => line.updateComplete));
  };

  constructor(readonly editor: InlineEditor<TextAttributes>) {}
}
