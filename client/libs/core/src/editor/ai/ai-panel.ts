// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { Bound } from "@virgultum/editor/global/gfx";
import {
  ImageBlockModel,
  NoteBlockModel,
  NoteDisplayMode,
} from "@virgultum/editor/model";
import {
  isInsideEdgelessEditor,
  matchModels,
} from "@virgultum/editor/shared/utils";
import type { EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";

import { insertFromMarkdown } from "../utils";
import {
  EXCLUDING_REPLACE_ACTIONS,
  INSERT_ABOVE_ACTIONS,
} from "./actions/consts";
import {
  pageResponseHandler,
  replaceWithMarkdown,
} from "./actions/page-response";
import type {
  AIItemConfig,
  AIItemGroupConfig,
} from "./components/ai-item/types";
import { createAIScrollableTextRenderer } from "./components/ai-scrollable-text-renderer";
import { AIProvider } from "./provider";
import { reportResponse } from "./utils/action-reporter";
import { getAIPanelController } from "./utils/ai-widgets";
import { AIContext } from "./utils/context";
import { findNoteBlockModel } from "./utils/edgeless";
import { copyTextAnswer } from "./utils/editor-actions";
import { getSelections } from "./utils/selection-utils";
import type { AIPanelController } from "./widgets/ai-panel/controller";
import type { MyoxusAIPanelWidgetConfig } from "./widgets/ai-panel/type";

function buildUseAsCaptionItem<K extends keyof VirgultumPresets.AIActions>(
  host: EditorHost,
  id?: K,
): AIItemConfig {
  return {
    name: "Use as caption",
    iconName: "PenIcon",
    testId: "answer-use-as-caption",
    showWhen: () =>
      id === "generateCaption" && Boolean(getAIPanelController(host).answer),
    handler: () => {
      reportResponse("result:use-as-caption");
      const panel = getAIPanelController(host);
      const caption = panel.answer;
      if (!caption) return;

      const { selectedBlocks } = getSelections(host);
      if (selectedBlocks?.length !== 1) return;

      const model = selectedBlocks[0].model;
      if (!(model instanceof ImageBlockModel)) return;

      host.store.updateBlock(model, { caption });
      panel.hide();
    },
  };
}

function buildCreateNewNoteItem(host: EditorHost): AIItemConfig {
  return {
    name: "Create new note",
    iconName: "PageIcon",
    testId: "answer-create-new-note",
    showWhen: () =>
      Boolean(getAIPanelController(host).answer) &&
      isInsideEdgelessEditor(host),
    handler: () => {
      reportResponse("result:add-note");
      const { selectedBlocks } = getSelections(host);
      const firstBlock = selectedBlocks?.[0];
      if (!firstBlock) return;

      const noteModel = findNoteBlockModel(firstBlock);
      if (!noteModel) return;

      const originBound = Bound.deserialize(noteModel.xywh);
      const nextBound = new Bound(
        originBound.x - originBound.w - 20,
        originBound.y,
        originBound.w,
        72,
      );
      const { store } = host;
      const panel = getAIPanelController(host);
      const gfx = host.std.get(GfxControllerIdentifier);

      store.transact(() => {
        if (!store.root || !panel.answer) return;
        const noteBlockId = store.addBlock(
          "myoxus:note",
          {
            xywh: nextBound.serialize(),
            displayMode: NoteDisplayMode.EdgelessOnly,
            index: gfx.layer.generateIndex(),
          },
          store.root.id,
        );

        insertFromMarkdown(host, panel.answer, store, noteBlockId)
          .then(() => {
            gfx.selection.set({ elements: [noteBlockId], editing: false });
            const created = store.getBlock(noteBlockId)?.model;
            if (!created || !matchModels(created, [NoteBlockModel])) return;
            gfx.fitToScreen({
              bounds: [originBound, Bound.deserialize(created.xywh)],
              padding: [20, 20, 20, 20],
            });
          })
          .catch(console.error);
      });

      panel.hide();
    },
  };
}

function createInsertResponseHandler<
  K extends keyof VirgultumPresets.AIActions,
>(
  panel: AIPanelController,
  id: K,
  ctx: AIContext,
  place: "after" | "before",
): () => void {
  const { host } = panel;
  return () => {
    reportResponse("result:insert");
    const pending = pageResponseHandler(id, host, ctx, place);
    if (id === "brainstormMindmap") {
      pending
        .then((accepted) => {
          if (accepted) {
            panel.hide();
            host.focus({ preventScroll: true });
          }
        })
        .catch(console.error);
    } else {
      pending.catch(console.error);
      panel.hide();
    }
  };
}

function buildResponseGroups<K extends keyof VirgultumPresets.AIActions>(
  panel: AIPanelController,
  id: K,
  ctx: AIContext,
): AIItemGroupConfig[] {
  const { host } = panel;

  return [
    {
      name: "Response",
      testId: "answer-responses",
      items: [
        {
          name: "Insert below",
          testId: "answer-insert-below",
          iconName: "InsertBelowIcon",
          showWhen: () =>
            Boolean(panel.answer) &&
            (!id || !INSERT_ABOVE_ACTIONS.includes(id)),
          handler: createInsertResponseHandler(panel, id, ctx, "after"),
        },
        {
          name: "Insert above",
          testId: "answer-insert-above",
          iconName: "InsertAboveIcon",
          showWhen: () =>
            Boolean(panel.answer) &&
            Boolean(id) &&
            INSERT_ABOVE_ACTIONS.includes(id),
          handler: createInsertResponseHandler(panel, id, ctx, "before"),
        },
        buildUseAsCaptionItem(host, id),
        {
          name: "Replace selection",
          testId: "answer-replace",
          iconName: "ReplaceIcon",
          showWhen: () =>
            Boolean(panel.answer) && !EXCLUDING_REPLACE_ACTIONS.includes(id),
          handler: () => {
            reportResponse("result:replace");
            replaceWithMarkdown(host).catch(console.error);
            panel.hide();
          },
        },
        buildCreateNewNoteItem(host),
      ],
    },
    {
      name: "",
      testId: "answer-common-responses",
      items: [
        {
          name: "Continue in chat",
          iconName: "ChatWithAiIcon",
          testId: "answer-continue-in-chat",
          handler: () => {
            reportResponse("result:continue-in-chat");
            AIProvider.slots.requestOpenWithChat.next({ host });
            panel.hide();
          },
        },
        {
          name: "Regenerate",
          iconName: "ResetIcon",
          testId: "answer-regenerate",
          handler: () => {
            reportResponse("result:retry");
            panel.generate();
          },
        },
        {
          name: "Discard",
          iconName: "DeleteIcon",
          testId: "answer-discard",
          handler: () => panel.discard(),
        },
      ],
    },
  ];
}

export function buildErrorResponseConfig(
  panel: AIPanelController,
): AIItemGroupConfig[] {
  return [
    {
      name: "",
      items: [
        {
          name: "Retry",
          iconName: "ResetIcon",
          testId: "error-retry",
          showWhen: () => true,
          handler: () => {
            reportResponse("result:retry");
            panel.generate();
          },
        },
        {
          name: "Discard",
          iconName: "DeleteIcon",
          testId: "error-discard",
          showWhen: () => Boolean(panel.answer),
          handler: () => panel.discard(),
        },
      ],
    },
  ];
}

export function buildFinishConfig<K extends keyof VirgultumPresets.AIActions>(
  panel: AIPanelController,
  id: K,
  ctx: AIContext,
) {
  return {
    responses: buildResponseGroups(panel, id, ctx),
    actions: [],
  };
}

export function buildErrorConfig(panel: AIPanelController) {
  return {
    login: () => {
      AIProvider.slots.requestLogin.next({ host: panel.host });
      panel.hide();
    },
    cancel: () => panel.hide(),
    responses: buildErrorResponseConfig(panel),
  };
}

export function buildGeneratingConfig(generatingIcon?: MyoxusIconExportName) {
  return {
    generatingIcon: generatingIcon ?? "AiIcon",
  };
}

export function buildCopyConfig(panel: AIPanelController) {
  return {
    allowed: true,
    onCopy: () => copyTextAnswer(panel),
  };
}

export function buildAIPanelConfig(
  panel: AIPanelController,
): MyoxusAIPanelWidgetConfig {
  const ctx = new AIContext();
  return {
    answerRenderer: createAIScrollableTextRenderer(
      { host: panel.host },
      320,
      true,
    ),
    finishStateConfig: buildFinishConfig(panel, "chat", ctx),
    generatingStateConfig: buildGeneratingConfig(),
    errorStateConfig: buildErrorConfig(panel),
    copy: buildCopyConfig(panel),
  };
}
