// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type GfxCommonBlockProps,
  GfxCompatible,
} from "@virgultum/editor/std/gfx";
import {
  BlockModel,
  BlockSchemaExtension,
  defineBlockSchema,
} from "@virgultum/editor/store";

type PersistedAIChatBlockProps = {
  /** Serialized JSON array of ChatMessage entries. */
  messages: string;
  /** Forked session identifier stored on the block. */
  sessionId: string;
  /** Workspace ID owning the source chat session. */
  rootWorkspaceId: string;
  /** Document ID owning the source chat session. */
  rootDocId: string;
} & Omit<GfxCommonBlockProps, "rotate">;

export const AIChatBlockSchema = defineBlockSchema({
  flavour: "myoxus:embed-ai-chat",
  props: (): PersistedAIChatBlockProps => ({
    xywh: "[0,0,0,0]",
    index: "a0",
    lockedBySelf: false,
    scale: 1,
    messages: "",
    sessionId: "",
    rootWorkspaceId: "",
    rootDocId: "",
  }),
  metadata: {
    version: 1,
    role: "content",
    children: [],
  },
  toModel: () => new AIChatBlockModel(),
});

export const AIChatBlockSchemaExtension =
  BlockSchemaExtension(AIChatBlockSchema);

export class AIChatBlockModel extends GfxCompatible<PersistedAIChatBlockProps>(
  BlockModel,
) {}
