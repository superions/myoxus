// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { type EditorHost, TextSelection } from "@virgultum/editor/std";

import {
  buildCopyConfig,
  buildErrorConfig,
  buildFinishConfig,
  buildGeneratingConfig,
} from "../ai-panel";
import { StreamObjectSchema } from "../components/ai-chat-messages";
import { type AIError, AIProvider } from "../provider";
import { reportResponse } from "../utils/action-reporter";
import { getAIPanelController } from "../utils/ai-widgets";
import { AIContext } from "../utils/context";
import {
  getSelectedImagesAsBlobs,
  getSelectedTextContent,
  getSelections,
  selectAboveBlocks,
} from "../utils/selection-utils";
import { mergeStreamObjects } from "../utils/stream-objects";
import type { AIPanelController } from "../widgets/ai-panel/controller";
import type { AIActionAnswer } from "../widgets/ai-panel/type";
import { actionToAnswerRenderer } from "./answer-renderer";

type ActionVariants<K extends keyof VirgultumPresets.AIActions> = Omit<
  Parameters<VirgultumPresets.AIActions[K]>[0],
  keyof VirgultumPresets.AITextActionOptions
>;

export function bindTextStream(
  stream: VirgultumPresets.TextStream,
  callbacks: {
    update: (answer: AIActionAnswer) => void;
    finish: (state: "success" | "error" | "aborted", err?: AIError) => void;
    signal?: AbortSignal;
  },
): void {
  const { update, finish, signal } = callbacks;

  (async () => {
    const answer: AIActionAnswer = { content: "" };
    signal?.addEventListener(
      "abort",
      () => {
        finish("aborted");
        reportResponse("aborted:stop");
      },
      { once: true },
    );

    for await (const chunk of stream) {
      if (signal?.aborted) return;

      let structured = false;
      try {
        const parsed = StreamObjectSchema.safeParse(JSON.parse(chunk));
        if (parsed.success) {
          answer.streamObjects = mergeStreamObjects([
            ...(answer.streamObjects ?? []),
            parsed.data,
          ]);
          structured = true;
        }
      } catch {
        // Plain text chunk.
      }
      if (!structured) {
        answer.content += chunk;
      }
      update(answer);
    }

    finish("success");
  })().catch((err: unknown) => {
    if (signal?.aborted) return;
    if (err instanceof Error && err.name === "AbortError") {
      finish("aborted");
      return;
    }
    finish("error", err as AIError);
  });
}

function createDocActionStream<K extends keyof VirgultumPresets.AIActions>(
  host: EditorHost,
  id: K,
  userInput: string,
  signal?: AbortSignal,
  variants?: ActionVariants<K>,
  trackerOptions?: VirgultumPresets.TrackerOptions,
): VirgultumPresets.TextStream | undefined {
  const action = AIProvider.actions[id];
  if (typeof action !== "function") return;

  return {
    async *[Symbol.asyncIterator]() {
      const { currentTextSelection, selectedBlocks } = getSelections(host);

      let markdown: string;
      let attachments: File[] = [];
      if (currentTextSelection?.isCollapsed()) {
        markdown = await selectAboveBlocks(host);
      } else {
        [markdown, attachments] = await Promise.all([
          getSelectedTextContent(host),
          getSelectedImagesAsBlobs(host),
        ]);
      }

      const combinedInput = userInput
        ? markdown
          ? `${markdown}\n${userInput}`
          : userInput
        : markdown;

      const options = {
        ...variants,
        attachments,
        input: combinedInput,
        stream: true,
        host,
        models: selectedBlocks?.map((block) => block.model),
        signal,
        control: trackerOptions?.control ?? "format-bar",
        where: trackerOptions?.where ?? "ai-panel",
        docId: host.store.id,
        workspaceId: host.store.workspace.id,
      };

      const stream = (await (
        action as (
          opts: Record<string, unknown>,
        ) => Promise<VirgultumPresets.TextStream | undefined>
      )(options)) as VirgultumPresets.TextStream | undefined;
      if (stream) {
        yield* stream;
      }
    },
  };
}

function configurePanelForDocAction<K extends keyof VirgultumPresets.AIActions>(
  panel: AIPanelController,
  id: K,
  generatingIcon: MyoxusIconExportName,
  variants?: ActionVariants<K>,
  trackerOptions?: VirgultumPresets.TrackerOptions,
): void {
  const { config, host } = panel;
  if (!config) return;

  const ctx = new AIContext();
  config.generateAnswer = ({ input, signal, update, finish }) => {
    const { selectedBlocks } = getSelections(host);
    if (!selectedBlocks?.length) return;
    const stream = createDocActionStream(
      host,
      id,
      input,
      signal,
      variants,
      trackerOptions,
    );
    if (stream) {
      bindTextStream(stream, { update, finish, signal });
    }
  };
  config.answerRenderer = actionToAnswerRenderer(id, host, ctx);
  config.finishStateConfig = buildFinishConfig(panel, id, ctx);
  config.generatingStateConfig = buildGeneratingConfig(generatingIcon);
  config.errorStateConfig = buildErrorConfig(panel);
  config.copy = buildCopyConfig(panel);
  config.discardCallback = () => reportResponse("result:discard");
}

export function actionToHandler<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  generatingIcon: MyoxusIconExportName,
  variants?: ActionVariants<K>,
  trackerOptions?: VirgultumPresets.TrackerOptions,
) {
  return (host: EditorHost) => {
    const panel = getAIPanelController(host);
    configurePanelForDocAction(
      panel,
      id,
      generatingIcon,
      variants,
      trackerOptions,
    );
    const { selectedBlocks } = getSelections(panel.host);
    const anchor = selectedBlocks?.at(-1);
    if (anchor) {
      panel.toggle(anchor, "generate");
    }
  };
}

export function handleInlineAskAIAction(host: EditorHost): void {
  const panel = getAIPanelController(host);
  const textSelection = host.selection.find(TextSelection);
  const blockId = textSelection
    ? (textSelection.to?.blockId ?? textSelection.blockId)
    : null;
  if (!blockId || !panel.config) return;

  const anchor = host.view.getBlock(blockId);
  if (!anchor) return;

  configurePanelForDocAction(panel, "chat", "AiIcon", undefined, {
    control: "chat-send",
    where: "inline-chat-panel",
  });
  panel.toggle(anchor, "input");
}
