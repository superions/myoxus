// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { CodeBlockPreviewIdentifier } from "@virgultum/editor/blocks/code";
import { DefaultTool, getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import { createTemplateJob } from "@virgultum/editor/gfx/template";
import {
  EDGELESS_TEXT_BLOCK_MIN_HEIGHT,
  EDGELESS_TEXT_BLOCK_MIN_WIDTH,
  EdgelessTextBlockModel,
  ImageBlockModel,
  NoteDisplayMode,
} from "@virgultum/editor/model";
import type { EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import { Text } from "@virgultum/editor/store";
import {
  MYOXUS_TOOLBAR_WIDGET,
  type MyoxusToolbarWidget,
} from "@virgultum/editor/widgets/toolbar";

import { insertFromMarkdown } from "../../utils";
import type { ChatContextValue } from "../components/ai-chat-content/type";
import type { AIItemConfig } from "../components/ai-item/types";
import { AIProvider } from "../provider";
import { reportResponse } from "../utils/action-reporter";
import { getAIPanelController } from "../utils/ai-widgets";
import type { AIContext, ContextValue } from "../utils/context";
import { getEdgelessCopilotWidget } from "../utils/edgeless";
import { preprocessHtml } from "../utils/html";
import {
  getCopilotSelectedElems,
  getSurfaceElementFromEditor,
} from "../utils/selection-utils";
import type { AIPanelController } from "../widgets/ai-panel/controller";
import type { EdgelessCopilotWidget } from "../widgets/edgeless-copilot";
import { EXCLUDING_INSERT_ACTIONS, generatingStages } from "./consts";
import { acceptSourceMindmap } from "./mindmap-source";

type FinishConfig = NonNullable<
  AIPanelController["config"]
>["finishStateConfig"];
type ErrorConfig = NonNullable<AIPanelController["config"]>["errorStateConfig"];
type ActionVariants<K extends keyof VirgultumPresets.AIActions> = Omit<
  Parameters<VirgultumPresets.AIActions[K]>[0],
  keyof VirgultumPresets.AITextActionOptions
>;

const READY_GUARDS: Partial<
  Record<keyof VirgultumPresets.AIActions, (data: ContextValue) => boolean>
> = {
  createSlides: (data) => Boolean(data.contents),
  brainstormMindmap: (data) => Boolean(data.node),
};

export function getToolbar(host: EditorHost) {
  const rootId = host.store.root?.id as string;
  const widget = host.view.getWidget(
    MYOXUS_TOOLBAR_WIDGET,
    rootId,
  ) as MyoxusToolbarWidget | null;
  return widget?.toolbar ?? null;
}

export function getTriggerEntry(host: EditorHost) {
  return getEdgelessCopilotWidget(host).visible ? "selection" : "toolbar";
}

export function discard(
  panel: AIPanelController,
  _copilot: EdgelessCopilotWidget,
): AIItemConfig {
  return {
    name: "Discard",
    icon: "DeleteIcon",
    testId: "answer-discard",
    showWhen: () => Boolean(panel.answer),
    handler: () => panel.discard(),
  };
}

export function retry(panel: AIPanelController): AIItemConfig {
  return {
    name: "Retry",
    icon: "ResetIcon",
    testId: "answer-retry",
    handler: () => {
      reportResponse("result:retry");
      panel.generate();
    },
  };
}

function insertMarkdownIntoBlock(
  host: EditorHost,
  markdown: string,
  parentId: string,
  index = 0,
) {
  insertFromMarkdown(host, markdown, host.store, parentId, index)
    .then(() => {
      host.std.get(GfxControllerIdentifier).selection.set({
        elements: [parentId],
        editing: false,
      });
    })
    .catch(console.error);
}

function createSurfaceTextContainer(
  host: EditorHost,
  markdown: string,
  kind: "edgelessText" | "note",
) {
  const { store } = host;
  const copilot = getEdgelessCopilotWidget(host);
  store.transact(() => {
    if (!store.root) return;
    const surface = store.getBlocksByFlavour("myoxus:surface")[0];
    const blockId =
      kind === "edgelessText"
        ? store.addBlock(
            "myoxus:edgeless-text",
            {
              xywh: copilot
                .determineInsertionBounds(
                  EDGELESS_TEXT_BLOCK_MIN_WIDTH,
                  EDGELESS_TEXT_BLOCK_MIN_HEIGHT,
                )
                .serialize(),
            },
            surface.id,
          )
        : store.addBlock(
            "myoxus:note",
            {
              xywh: copilot.determineInsertionBounds(800, 95).serialize(),
              displayMode: NoteDisplayMode.EdgelessOnly,
            },
            store.root.id,
          );
    insertMarkdownIntoBlock(host, markdown, blockId);
  });
}

function insertDefaultTextAnswer(host: EditorHost) {
  const { answer } = getAIPanelController(host);
  if (!answer) return;

  const selected = getCopilotSelectedElems(host);
  if (selected.length === 1 && selected[0] instanceof EdgelessTextBlockModel) {
    insertMarkdownIntoBlock(
      host,
      answer,
      selected[0].id,
      selected[0].children.length,
    );
    return;
  }

  const allEdgelessText =
    selected.length > 1 &&
    selected.every((el) => el instanceof EdgelessTextBlockModel);
  createSurfaceTextContainer(
    host,
    answer,
    allEdgelessText ? "edgelessText" : "note",
  );
}

function finalizeMindmapAcceptance(host: EditorHost) {
  const copilot = getEdgelessCopilotWidget(host);
  copilot.hideCopilotPanel();
  copilot.lockToolbar(false);
  // Skip the generic hide callback so the newly accepted mindmap keeps selection.
  getAIPanelController(host).hide(false);
  host.std.get(GfxControllerIdentifier).tool.setTool(DefaultTool);
  host.focus({ preventScroll: true });
}

export async function responseToExpandMindmap(
  host: EditorHost,
  ctx: AIContext,
) {
  if (await acceptSourceMindmap(host, ctx, { kind: "expand" })) {
    finalizeMindmapAcceptance(host);
  }
}

async function responseToBrainstormMindmap(host: EditorHost, ctx: AIContext) {
  const rect = getEdgelessCopilotWidget(host).selectionModelRect;
  if (
    await acceptSourceMindmap(host, ctx, {
      kind: "native",
      x: rect.x + rect.width + 100,
      y: rect.y,
    })
  ) {
    finalizeMindmapAcceptance(host);
  }
}

function extractProcessedHtml(host: EditorHost): string | undefined {
  const raw = getAIPanelController(host).answer;
  return raw ? preprocessHtml(raw) : undefined;
}

function insertMakeItRealBlock(host: EditorHost, ctx: AIContext) {
  const html = extractProcessedHtml(host);
  const surface = getSurfaceBlock(host.store);
  if (!html || !surface) return;

  const copilot = getEdgelessCopilotWidget(host);
  const panel = getAIPanelController(host);
  const { width, height } = ctx.get();
  const bounds = copilot.determineInsertionBounds(width || 800, height || 600);

  copilot.hideCopilotPanel();
  panel.hide();

  host.store.transact(() => {
    const useCodeBlock = host.std.getOptional(
      CodeBlockPreviewIdentifier("html"),
    );
    if (useCodeBlock) {
      const note = host.store.addBlock(
        "myoxus:note",
        { xywh: bounds.serialize() },
        host.store.root,
      );
      host.store.addBlock(
        "myoxus:code",
        { text: new Text(html), language: "html", preview: true },
        note,
      );
      return;
    }

    host.store.addBlock(
      "myoxus:embed-html",
      {
        html,
        design: "ai:makeItReal",
        xywh: bounds.serialize(),
      },
      surface.id,
    );
  });
}

async function insertSlidesOnCanvas(host: EditorHost, ctx: AIContext) {
  const { contents = [], images = [] } = ctx.get();
  if (contents.length === 0) return;

  try {
    for (let i = 0; i < contents.length; i++) {
      const job = createTemplateJob(host.std, "template");
      const slideImages = images[i] ?? [];
      await Promise.all(
        slideImages.map(async ({ id, url }) => {
          const blob = await fetch(url).then((res) => res.blob());
          job.job.assets.set(id, blob);
        }),
      );
      await job.insertTemplate(contents[i]);
    }
    getSurfaceElementFromEditor(host)?.refresh();
  } catch (err) {
    console.error("Error creating slides:", err);
  }
}

async function applyEdgelessResponse<
  K extends keyof VirgultumPresets.AIActions,
>(id: K, host: EditorHost, ctx: AIContext) {
  switch (id) {
    case "expandMindmap":
      await responseToExpandMindmap(host, ctx);
      break;
    case "brainstormMindmap":
      await responseToBrainstormMindmap(host, ctx);
      break;
    case "makeItReal":
      insertMakeItRealBlock(host, ctx);
      break;
    case "createSlides":
      await insertSlidesOnCanvas(host, ctx);
      break;
    default:
      insertDefaultTextAnswer(host);
      break;
  }
}

function buildContinueChatContext<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  host: EditorHost,
  ctx: AIContext,
): Partial<ChatContextValue> | null {
  switch (id) {
    case "expandMindmap":
    case "brainstormMindmap": {
      const node = ctx.get().node;
      return node ? { snapshot: JSON.stringify(node) } : null;
    }
    case "makeItReal": {
      const html = extractProcessedHtml(host);
      return html ? { html } : null;
    }
    case "createSlides":
      return { snapshot: JSON.stringify(ctx.get().contents ?? []) };
    default:
      return { combinedElementsMarkdown: getAIPanelController(host).answer };
  }
}

export function createInsertItems<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  host: EditorHost,
  ctx: AIContext,
  variants?: ActionVariants<K>,
): AIItemConfig[] {
  const isReady = READY_GUARDS[id] ?? (() => true);
  const label =
    id === "brainstormMindmap" &&
    (variants as { regenerate?: boolean } | undefined)?.regenerate
      ? "Replace"
      : "Insert below";

  const canInsert = () =>
    !EXCLUDING_INSERT_ACTIONS.includes(id) &&
    Boolean(getAIPanelController(host).answer);

  return [
    {
      name: `${label} - Loading...`,
      icon: "LoadingIcon",
      testId: "answer-insert-below-loading",
      showWhen: () => canInsert() && !isReady(ctx.get()),
    },
    {
      name: label,
      icon: "InsertBelowIcon",
      testId: label === "Replace" ? "answer-replace" : "answer-insert-below",
      showWhen: () => canInsert() && isReady(ctx.get()),
      handler: () => {
        reportResponse("result:insert");
        applyEdgelessResponse(id, host, ctx).catch(console.error);
        if (id !== "brainstormMindmap" && id !== "expandMindmap") {
          getAIPanelController(host).hide();
        }
      },
    },
  ];
}

export function asCaption<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  host: EditorHost,
): AIItemConfig {
  return {
    name: "Use as caption",
    icon: "PenIcon",
    testId: "answer-use-as-caption",
    showWhen: () =>
      id === "generateCaption" && Boolean(getAIPanelController(host).answer),
    handler: () => {
      reportResponse("result:use-as-caption");
      const panel = getAIPanelController(host);
      if (!panel.answer) return;

      const selected = getCopilotSelectedElems(host);
      if (selected.length !== 1 || !(selected[0] instanceof ImageBlockModel)) {
        return;
      }
      host.store.updateBlock(selected[0], { caption: panel.answer });
      panel.hide();
    },
  };
}

export function actionToResponse<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  host: EditorHost,
  ctx: AIContext,
  variants?: ActionVariants<K>,
): FinishConfig {
  const panel = getAIPanelController(host);
  const copilot = getEdgelessCopilotWidget(host);

  return {
    responses: [
      {
        name: "Response",
        testId: "answer-responses",
        items: [
          {
            name: "Continue in chat",
            testId: "answer-continue-in-chat",
            icon: "ChatWithAiIcon",
            handler: () => {
              reportResponse("result:continue-in-chat");
              AIProvider.slots.requestOpenWithChat.next({
                host,
                context: buildContinueChatContext(id, host, ctx),
                fromAnswer: true,
              });
              panel.hide();
            },
          },
          ...createInsertItems(id, host, ctx, variants),
          asCaption(id, host),
          retry(panel),
          discard(panel, copilot),
        ],
      },
    ],
    actions: [],
  };
}

export function actionToGenerating<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  generatingIcon: MyoxusIconExportName,
) {
  return {
    generatingIcon,
    stages: generatingStages[id],
  };
}

export function actionToErrorResponse<
  K extends keyof VirgultumPresets.AIActions,
>(
  panel: AIPanelController,
  id: K,
  host: EditorHost,
  ctx: AIContext,
  variants?: ActionVariants<K>,
): ErrorConfig {
  return {
    login: () => {
      AIProvider.slots.requestLogin.next({ host: panel.host });
      panel.hide();
    },
    cancel: () => panel.hide(),
    responses: [
      {
        name: "Response",
        items: createInsertItems(id, host, ctx, variants),
      },
      {
        name: "",
        items: [retry(panel), discard(panel, getEdgelessCopilotWidget(host))],
      },
    ],
  };
}
