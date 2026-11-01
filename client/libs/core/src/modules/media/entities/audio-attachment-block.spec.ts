// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import { TranscriptionBlockSchemaExtension } from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import {
  AttachmentBlockSchemaExtension,
  CalloutBlockSchemaExtension,
  NoteBlockSchemaExtension,
  ParagraphBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/model";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { Text } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { encodeStateAsUpdate } from "yjs";
import { expect, test, vi } from "vitest";

import { AudioMediaManagerService } from "../services/audio-media-manager";
import { AudioAttachmentBlock } from "./audio-attachment-block";
import { audioJobHarness } from "./audio-transcription-test-harness";

function harness() {
  const workspace = new TestWorkspace({ id: "audio-readonly" });
  workspace.meta.initialize();
  const doc = workspace.createDoc("audio-doc");
  doc.load();
  const store = doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      AttachmentBlockSchemaExtension,
      CalloutBlockSchemaExtension,
      ParagraphBlockSchemaExtension,
      TranscriptionBlockSchemaExtension,
    ],
  });
  const root = store.addBlock("myoxus:page", { title: new Text("Audio") });
  const note = store.addBlock("myoxus:note", {}, root);
  const attachment = store.addBlock(
    "myoxus:attachment",
    {
      sourceId: "canonical-audio",
      name: "known-german.wav",
      size: 1000,
      type: "audio/wav",
    },
    note,
  );
  const model = store.getBlock(attachment)!.model as AttachmentBlockModel;
  const release = vi.fn();
  const h = audioJobHarness((framework) =>
    framework
      .service(AudioMediaManagerService, {
        ensureMediaEntity: () => ({ media: {}, release }),
      } as unknown as AudioMediaManagerService)
      .entity(AudioAttachmentBlock, [AudioMediaManagerService]),
  );
  h.setState(h.finished);
  const create = () => h.provider.createEntity(AudioAttachmentBlock, model);
  return { ...h, doc, workspace, store, model, create, release };
}

test("constructor, mount and readonly preview do not write Yjs; explicit insertion is source-bound and idempotent", async () => {
  const h = harness();
  h.store.readonly = true;
  const before = encodeStateAsUpdate(h.doc.spaceDoc);
  const block = h.create();
  block.mount();
  await block.transcriptionJob.restore();
  expect(block.transcriptionJob.result$.value?.text).toBe(h.finished.text);
  expect(encodeStateAsUpdate(h.doc.spaceDoc)).toEqual(before);
  expect(block.insertTranscript("Transcript")).toBe(false);
  expect(encodeStateAsUpdate(h.doc.spaceDoc)).toEqual(before);
  h.store.readonly = false;
  h.store.updateBlock(h.model, { sourceId: "different-audio" });
  expect(block.insertTranscript("Transcript")).toBe(false);
  h.store.updateBlock(h.model, { sourceId: "canonical-audio" });
  expect(block.insertTranscript("Transcript")).toBe(true);
  const inserted = encodeStateAsUpdate(h.doc.spaceDoc);
  const id = block.transcriptionBlock$.value!.id;
  expect(block.insertTranscript("Transcript")).toBe(false);
  expect(encodeStateAsUpdate(h.doc.spaceDoc)).toEqual(inserted);
  const callout = h.store.getBlock(
    block.transcriptionBlock$.value!.children[0].id,
  )!.model;
  expect(
    callout.children.map((child) => (child.props as any).text?.toString()),
  ).toEqual(["Transcript", "0:00 Am Montag planen wir die Arbeit."]);
  block.unmount();
  block.dispose();
  const reload = h.create();
  reload.mount();
  await reload.transcriptionJob.restore();
  expect(reload.transcriptionBlock$.value!.id).toBe(id);
  expect(encodeStateAsUpdate(h.doc.spaceDoc)).toEqual(inserted);
  reload.unmount();
  reload.dispose();
  h.workspace.dispose();
});

test("insertion reuses an empty persisted transcription ID and never replaces historical text", async () => {
  const h = harness();
  const legacyId = h.store.addBlock(
    "myoxus:transcription",
    { jobId: "retained-job", transcription: { retained: true } },
    h.model.id,
  );
  const block = h.create();
  await block.transcriptionJob.restore();
  expect(block.insertTranscript("Transcript")).toBe(true);
  expect(block.transcriptionBlock$.value!.id).toBe(legacyId);
  expect(block.transcriptionBlock$.value!.props.transcription).toEqual({
    retained: true,
  });
  const retained = encodeStateAsUpdate(h.doc.spaceDoc);
  expect(block.insertTranscript("Replacement")).toBe(false);
  expect(encodeStateAsUpdate(h.doc.spaceDoc)).toEqual(retained);
  block.dispose();
  h.workspace.dispose();
});
