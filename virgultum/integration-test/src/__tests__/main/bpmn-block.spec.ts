// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  BpmnBlockPresentationExtension,
  commitBpmnSourceRevision,
  insertBpmnBlockCommand,
  readBpmnSourceRevisions,
} from "@virgultum/editor/blocks/bpmn";
import type { BpmnBlockModel, NoteBlockModel } from "@virgultum/model";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { beforeEach, describe, expect, test, vi } from "vitest";
import * as Y from "yjs";
import {
  duplicateSelectedModelsCommand,
  deleteSelectedModelsCommand,
} from "@virgultum/shared/commands";
import { html } from "lit";
import { signal } from "@preact/signals-core";
import { DocEmbedProvider } from "@virgultum/shared/services";
import { addNote } from "../utils/edgeless.js";
import { setupEditor } from "../utils/setup.js";
import { wait } from "../utils/common.js";

describe.each(["page", "edgeless"] as const)("BPMN %s consumer", (mode) => {
  beforeEach(async () =>
    setupEditor(mode, [
      // This fixture exercises public editor command/selection integration only.
      // Core's real Facade portal and session owner have separate consuming checks.
      BpmnBlockPresentationExtension(
        (props) =>
          html`<span
            data-source-state=${props.sourceState}
            data-readonly=${String(props.readonly)}
            >${props.title}</span
          >`,
      ),
      {
        setup: (di) => {
          di.addImpl(DocEmbedProvider, () => ({
            canRead: async (id) => id === doc.id,
            readable: (id) => signal(id === doc.id),
            waitForLoaded: async (id) => {
              if (id !== doc.id) throw new Error("Unknown fixture document");
            },
          }));
        },
      },
    ]),
  );

  test("public commands preserve conflict serialization and live read-only state across native modes", async () => {
    const noteId = addNote(doc);
    const paragraph = doc.getBlock(noteId)!.model.children[0];
    const std = editor.host!.std;
    const [, result] = std.command.exec(insertBpmnBlockCommand, {
      selectedModels: [paragraph],
    });
    expect(result.bpmnInsertion?.ok).toBe(true);
    const id = result.insertedBpmnBlockId!;
    await wait();
    const block = doc.getBlock(id)!.model as BpmnBlockModel;
    expect(document.querySelectorAll("myoxus-bpmn")).toHaveLength(1);
    expect(document.querySelector("myoxus-bpmn editor-host")).toBeNull();
    expect(doc.getBlocksByFlavour("myoxus:frame")).toHaveLength(0);
    if (mode === "edgeless") {
      const note = doc.getBlock(noteId)!.model as NoteBlockModel;
      const view = std.view.getBlock(noteId)!;
      const settleGeometry = async () => {
        await view.updateComplete;
        // Resize delivery schedules the persisted bound for the next frame.
        // Await that complete cycle rather than passing before the faulty write.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        );
      };
      await settleGeometry();
      const bound = note.props.xywh;
      const gfx = std.get(GfxControllerIdentifier);
      gfx.selection.set({ elements: [noteId], editing: true });
      await settleGeometry();
      expect(note.props.xywh).toBe(bound);
      gfx.selection.set({ elements: [], editing: false });
      await settleGeometry();
      expect(note.props.xywh).toBe(bound);
    }
    const original = [
      ...readBpmnSourceRevisions(block.yBlock).heads.values(),
    ][0];
    const parent = block.props.selectedHead;
    const peer = new Y.Doc();
    try {
      Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc.spaceDoc));
      const peerBlock = peer.getMap<Y.Map<unknown>>("blocks").get(id)!;
      commitBpmnSourceRevision(block.yBlock, {
        id: crypto.randomUUID(),
        parent,
        supersedes: [],
        source: original.replace("<process ", '<process name="Local" '),
      });
      commitBpmnSourceRevision(peerBlock, {
        id: crypto.randomUUID(),
        parent,
        supersedes: [],
        source: original.replace("<process ", '<process name="Concurrent" '),
      });
      Y.applyUpdate(doc.spaceDoc, Y.encodeStateAsUpdate(peer));
    } finally {
      peer.destroy();
    }
    await vi.waitFor(() =>
      expect(
        document
          .querySelector("myoxus-bpmn [data-source-state]")
          ?.getAttribute("data-source-state"),
      ).toBe("conflict"),
    );
    const source = [...readBpmnSourceRevisions(block.yBlock).heads.values()];
    doc.readonly = true;
    await vi.waitFor(() =>
      expect(
        document
          .querySelector("myoxus-bpmn [data-readonly]")
          ?.getAttribute("data-readonly"),
      ).toBe("true"),
    );
    const [, denied] = std.command.exec(insertBpmnBlockCommand, {
      selectedModels: [paragraph],
    });
    expect(denied.bpmnInsertion?.ok).toBe(false);
    expect(doc.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(1);
    doc.readonly = false;
    std.command.exec(duplicateSelectedModelsCommand, {
      selectedModels: [block],
    });
    await vi.waitFor(() =>
      expect(doc.getBlocksByFlavour("myoxus:bpmn")).toHaveLength(2),
    );
    const copiedId = doc
      .getBlocksByFlavour("myoxus:bpmn")
      .find((value) => value.id !== id)!.id;
    const copied = doc.getBlock(copiedId)!.model as BpmnBlockModel;
    expect([...readBpmnSourceRevisions(copied.yBlock).heads.values()]).toEqual(
      source,
    );
    expect(copied.props.selectedHead).not.toBe(block.props.selectedHead);
    expect(readBpmnSourceRevisions(copied.yBlock).status).toBe("conflict");
    std.command.exec(deleteSelectedModelsCommand, { selectedModels: [block] });
    expect(doc.getBlock(id)).toBeUndefined();
    expect([...readBpmnSourceRevisions(copied.yBlock).heads.values()]).toEqual(
      source,
    );
  });
});
