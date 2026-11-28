// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/editor/store";

export const TranscriptionBlockFlavour = "myoxus:transcription";

export type TranscriptionBlockProps = {
  transcription: Record<string, unknown>;
  jobId?: string;
  createdBy?: string;
};

export const TranscriptionBlockSchema = defineBlockSchema({
  flavour: TranscriptionBlockFlavour,
  props: (): TranscriptionBlockProps => ({
    transcription: {},
    jobId: undefined,
    createdBy: undefined,
  }),
  metadata: {
    version: 1,
    role: "attachment-viewer",
    parent: ["myoxus:attachment"],
    children: ["myoxus:callout"],
  },
  toModel: () => new TranscriptionBlockModel(),
});

export class TranscriptionBlockModel extends BlockModel<TranscriptionBlockProps> {}

export const TranscriptionBlockSchemaExtension = BlockSchemaExtension(
  TranscriptionBlockSchema,
);
