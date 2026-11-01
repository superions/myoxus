// SPDX-License-Identifier: MIT
import {
  TranscriptionBlockFlavour,
  type TranscriptionBlockModel,
} from "@myoxus/core/editor/ai/blocks/transcription-block/model";
import { Entity, LiveData } from "@myoxus/infra";
import { computed } from "@preact/signals-core";
import type { AttachmentBlockModel } from "@virgultum/editor/model";
import { Text } from "@virgultum/editor/store";

import type { AudioMediaManagerService } from "../services/audio-media-manager";
import type { AudioMedia } from "./audio-media";
import { AudioTranscriptionJob } from "./audio-transcription-job";

export function transcriptTimestamp(seconds: number) {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export class AudioAttachmentBlock extends Entity<AttachmentBlockModel> {
  private readonly refCount$ = new LiveData<number>(0);
  readonly audioMedia: AudioMedia;
  constructor(readonly audioMediaManagerService: AudioMediaManagerService) {
    super();
    const mediaRef = audioMediaManagerService.ensureMediaEntity(this.props);
    this.audioMedia = mediaRef.media;
    this.disposables.push(() => mediaRef.release());
    this.disposables.push(() => this.transcriptionJob.dispose());
  }

  rendering$ = this.refCount$.map((refCount) => refCount > 0);
  expanded$ = new LiveData<boolean>(false);

  readonly transcriptionBlock$ = LiveData.fromSignal(
    computed(() => {
      for (const key of [...this.props.childMap.value.keys()].reverse()) {
        const block = this.props.store.getBlock$(key);
        if (block?.flavour === TranscriptionBlockFlavour)
          return block.model as unknown as TranscriptionBlockModel;
      }
      return null;
    }),
  );

  readonly hasTranscription$ = LiveData.computed((get) => {
    const block = get(this.transcriptionBlock$);
    return block ? get(LiveData.fromSignal(block.childMap)).size > 0 : false;
  });

  readonly transcriptionJob = this.createJob();

  private createJob() {
    const blobId = this.props.props.sourceId;
    if (!blobId) throw new Error("No audio source available");
    return this.framework.createEntity(AudioTranscriptionJob, { blobId });
  }

  mount() {
    // Restoring a viewer never submits work or inserts a model, including readonly
    // and public rendering. Existing persisted children remain the content owner.
    if (this.refCount$.value === 0) void this.transcriptionJob.restore();
    this.refCount$.value++;
  }

  unmount() {
    this.refCount$.value--;
  }
  readonly transcribe = () => this.transcriptionJob.start();

  /** One explicit editable action inserts at this exact source. Preserve existing
   * block IDs and content; a repeated action cannot replace or duplicate it. */
  insertTranscript(title: string) {
    const result = this.transcriptionJob.result$.value;
    const store = this.props.store;
    if (
      store.readonly ||
      !result?.text ||
      this.hasTranscription$.value ||
      this.props.props.sourceId !== this.transcriptionJob.props.blobId ||
      !store.getBlock(this.props.id)
    )
      return false;
    store.transact(() => {
      const existing = this.transcriptionBlock$.value;
      const metadata = {
        jobId: this.transcriptionJob.id,
        createdBy: this.transcriptionJob.currentUserId,
      };
      // Newly added models materialize after this transaction. Initialize their
      // metadata at creation instead of looking them up through the store.
      const parent =
        existing?.id ??
        store.addBlock(TranscriptionBlockFlavour, metadata, this.props.id);
      if (existing) store.updateBlock(existing, metadata);
      const callout = store.addBlock("myoxus:callout", {}, parent);
      store.addBlock(
        "myoxus:paragraph",
        { type: "h6", text: new Text(title) },
        callout,
      );
      const lines = result.segments.length
        ? result.segments.map((segment) =>
            [
              segment.startSeconds === undefined
                ? ""
                : transcriptTimestamp(segment.startSeconds),
              segment.speaker ?? "",
              segment.text,
            ]
              .filter(Boolean)
              .join(" "),
          )
        : [result.text];
      for (const line of lines)
        store.addBlock(
          "myoxus:paragraph",
          { text: new Text(line.replace(/\r/g, "")) },
          callout,
        );
    });
    this.expanded$.value = true;
    return true;
  }
}
