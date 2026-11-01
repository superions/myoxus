import { acceptSourceMindmap } from "./mindmap-source";
import {
  ChatWithAiIcon,
  DeleteIcon,
  InsertBleowIcon as InsertBelowIcon,
  PenIcon,
  ResetIcon,
} from "@myoxus/icons/lit";
import { CodeBlockPreviewIdentifier } from "@virgultum/editor/blocks/code";
import { addImages } from "@virgultum/editor/blocks/image";
import { DefaultTool, getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import { LoadingIcon } from "@virgultum/editor/components/icons";
import { createTemplateJob } from "@virgultum/editor/gfx/template";
import { Bound } from "@virgultum/editor/global/gfx";
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
import type { TemplateResult } from "lit";

import { insertFromMarkdown } from "../../utils";
import type { ChatContextValue } from "../components/ai-chat-content/type";
import type { AIItemConfig } from "../components/ai-item/types";
import { AIProvider } from "../provider";
import { reportResponse } from "../utils/action-reporter";
import { getAIPanelWidget } from "../utils/ai-widgets";
import type { AIContext } from "../utils/context";
import { getEdgelessCopilotWidget } from "../utils/edgeless";
import { preprocessHtml } from "../utils/html";
import { fetchImageToFile } from "../utils/image";
import {
  getCopilotSelectedElems,
  getSurfaceElementFromEditor,
} from "../utils/selection-utils";
import type { MyoxusAIPanelWidget } from "../widgets/ai-panel/ai-panel";
import type { EdgelessCopilotWidget } from "../widgets/edgeless-copilot";
import { EXCLUDING_INSERT_ACTIONS, generatingStages } from "./consts";

const EDGELESS_RESPONSE_ICON_SIZE =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";

type FinishConfig = Exclude<
  MyoxusAIPanelWidget["config"],
  null
>["finishStateConfig"];

type ErrorConfig = Exclude<
  MyoxusAIPanelWidget["config"],
  null
>["errorStateConfig"];

export function getToolbar(host: EditorHost) {
  const rootBlockId = host.store.root?.id as string;
  const toolbar = host.view.getWidget(
    MYOXUS_TOOLBAR_WIDGET,
    rootBlockId,
  ) as MyoxusToolbarWidget;

  return toolbar?.toolbar ?? null;
}

export function getTriggerEntry(host: EditorHost) {
  const copilotWidget = getEdgelessCopilotWidget(host);

  return copilotWidget.visible ? "selection" : "toolbar";
}

export function discard(
  panel: MyoxusAIPanelWidget,
  _: EdgelessCopilotWidget,
): AIItemConfig {
  return {
    name: "Discard",
    icon: DeleteIcon(),
    testId: "answer-discard",
    showWhen: () => !!panel.answer,
    handler: () => {
      panel.discard();
    },
  };
}

export function retry(panel: MyoxusAIPanelWidget): AIItemConfig {
  return {
    name: "Retry",
    icon: ResetIcon(),
    testId: "answer-retry",
    handler: () => {
      reportResponse("result:retry");
      panel.generate();
    },
  };
}

const extraConditions: Record<string, (data: any) => boolean> = {
  createSlides: (data) => !!data.contents,
  brainstormMindmap: (data) => !!data.node,
};
export function createInsertItems<T extends keyof VirgultumPresets.AIActions>(
  id: T,
  host: EditorHost,
  ctx: AIContext,
  variants?: Omit<
    Parameters<VirgultumPresets.AIActions[T]>[0],
    keyof VirgultumPresets.AITextActionOptions
  >,
): AIItemConfig[] {
  const extraCondition = extraConditions[id] || ((_: any) => true);
  const buttonText = getButtonText[id]?.(variants) ?? "Insert below";
  return [
    {
      name: `${buttonText} - Loading...`,
      icon: LoadingIcon({ size: EDGELESS_RESPONSE_ICON_SIZE }),
      testId: "answer-insert-below-loading",
      showWhen: () => {
        const panel = getAIPanelWidget(host);
        const data = ctx.get();
        return (
          !EXCLUDING_INSERT_ACTIONS.includes(id) &&
          !!panel.answer &&
          // required data for insert
          !extraCondition(data)
        );
      },
    },
    {
      name: buttonText,
      icon: InsertBelowIcon(),
      testId:
        buttonText === "Replace" ? "answer-replace" : `answer-insert-below`,
      showWhen: () => {
        const panel = getAIPanelWidget(host);
        const data = ctx.get();
        return (
          !EXCLUDING_INSERT_ACTIONS.includes(id) &&
          !!panel.answer &&
          // required data for insert
          !!extraCondition(data)
        );
      },
      handler: () => {
        reportResponse("result:insert");
        edgelessResponseHandler(id, host, ctx).catch(console.error);
        const panel = getAIPanelWidget(host);
        if (id !== "brainstormMindmap" && id !== "expandMindmap") panel.hide();
      },
    },
  ];
}

async function edgelessResponseHandler<
  T extends keyof VirgultumPresets.AIActions,
>(id: T, host: EditorHost, ctx: AIContext) {
  switch (id) {
    case "expandMindmap":
      await responseToExpandMindmap(host, ctx);
      break;
    case "brainstormMindmap":
      await responseToBrainstormMindmap(host, ctx);
      break;
    case "makeItReal":
      responseToMakeItReal(host, ctx);
      break;
    case "createSlides":
      await responseToCreateSlides(host, ctx);
      break;
    case "createImage":
    case "filterImage":
    case "processImage":
      responseToCreateImage(host);
      break;
    default:
      defaultHandler(host);
      break;
  }
}

export function asCaption<T extends keyof VirgultumPresets.AIActions>(
  id: T,
  host: EditorHost,
): AIItemConfig {
  return {
    name: "Use as caption",
    icon: PenIcon(),
    testId: "answer-use-as-caption",
    showWhen: () => {
      const panel = getAIPanelWidget(host);
      return id === "generateCaption" && !!panel.answer;
    },
    handler: () => {
      reportResponse("result:use-as-caption");
      const panel = getAIPanelWidget(host);
      const caption = panel.answer;
      if (!caption) return;

      const selectedElements = getCopilotSelectedElems(host);
      if (selectedElements.length !== 1) return;

      const imageBlock = selectedElements[0];
      if (!(imageBlock instanceof ImageBlockModel)) return;

      host.store.updateBlock(imageBlock, { caption });
      panel.hide();
    },
  };
}

function insertBelow(
  host: EditorHost,
  markdown: string,
  parentId: string,
  index = 0,
) {
  insertFromMarkdown(host, markdown, host.store, parentId, index)
    .then(() => {
      const gfx = host.std.get(GfxControllerIdentifier);

      gfx.selection.set({
        elements: [parentId],
        editing: false,
      });
    })
    .catch((err) => {
      console.error(err);
    });
}

function createBlockAndInsert(
  host: EditorHost,
  markdown: string,
  type: "edgelessText" | "note",
) {
  const doc = host.store;
  const edgelessCopilot = getEdgelessCopilotWidget(host);
  doc.transact(() => {
    if (!doc.root) return;
    let blockId = "";
    const bounds = edgelessCopilot.determineInsertionBounds(
      EDGELESS_TEXT_BLOCK_MIN_WIDTH,
      EDGELESS_TEXT_BLOCK_MIN_HEIGHT,
    );
    const surfaceBlock = doc.getBlocksByFlavour("myoxus:surface")[0];
    if (type === "edgelessText") {
      blockId = doc.addBlock(
        "myoxus:edgeless-text",
        {
          xywh: bounds.serialize(),
        },
        surfaceBlock.id,
      );
    } else {
      const bounds = edgelessCopilot.determineInsertionBounds(800, 95);
      blockId = doc.addBlock(
        "myoxus:note",
        {
          xywh: bounds.serialize(),
          displayMode: NoteDisplayMode.EdgelessOnly,
        },
        doc.root.id,
      );
    }

    insertBelow(host, markdown, blockId);
  });
}

/**
 * defaultHandler is the default handler for inserting AI response into the edgeless document.
 * Three situations are handled by this handler:
 * 1. When selection is a single EdgelessText block, insert the response to the last of the block.
 * 2. When selections are multiple EdgelessText blocks, insert the response to a new EdgelessBlock.
 * 3. Otherwise, insert the response to a new Note block.
 * @param host EditorHost
 */
const defaultHandler = (host: EditorHost) => {
  const panel = getAIPanelWidget(host);
  const selectedElements = getCopilotSelectedElems(host);
  if (!panel.answer) return;
  if (
    selectedElements.length === 1 &&
    selectedElements[0] instanceof EdgelessTextBlockModel
  ) {
    const edgelessTextBlockId = selectedElements[0].id;
    const index = selectedElements[0].children.length;
    insertBelow(host, panel.answer, edgelessTextBlockId, index);
  } else if (
    selectedElements.length > 1 &&
    selectedElements.every((el) => el instanceof EdgelessTextBlockModel)
  ) {
    createBlockAndInsert(host, panel.answer, "edgelessText");
  } else {
    createBlockAndInsert(host, panel.answer, "note");
  }
};

/**
 * Image handler for inserting generated image into the edgeless document.
 * Should make the inserting image size same with the input image if there is an input image.
 * @param host
 */
function responseToCreateImage(host: EditorHost) {
  const aiPanel = getAIPanelWidget(host);
  // `DataURL` or `URL`
  const data = aiPanel.answer;
  if (!data) return;

  const edgelessCopilot = getEdgelessCopilotWidget(host);
  const bounds = edgelessCopilot.determineInsertionBounds();
  const selectedElements = getCopilotSelectedElems(host);
  const selectedImageBlockModel = selectedElements.find(
    (model) => model instanceof ImageBlockModel,
  );
  const selectedBound = selectedImageBlockModel
    ? Bound.deserialize(selectedImageBlockModel.xywh)
    : null;

  edgelessCopilot.hideCopilotPanel();
  aiPanel.hide();

  const filename = "image";
  const imageProxy = host.std.clipboard.configs.get("imageProxy");

  fetchImageToFile(data, filename, imageProxy)
    .then((img) => {
      if (!img) return;

      const { minX, minY } = bounds;
      const gfx = host.std.get(GfxControllerIdentifier);
      const [x, y] = gfx.viewport.toViewCoord(minX, minY);

      host.store.transact(() => {
        addImages(host.std, [img], { point: [x, y] })
          .then((blockIds) => {
            const imageBlockId = blockIds[0];
            const imageBlock = host.store.getBlock(imageBlockId);
            if (!imageBlock || !selectedBound) return;

            // Update the image width and height to the same with the selected image
            const imageModel = imageBlock.model as ImageBlockModel;
            const imageBound = Bound.deserialize(imageModel.xywh);
            const newBound = new Bound(
              imageBound.x,
              imageBound.y,
              selectedBound.w,
              selectedBound.h,
            );
            host.store.updateBlock(imageModel, { xywh: newBound.serialize() });
          })
          .catch(console.error);
      });
    })
    .catch(console.error);
}

function finishSourceMindmapResponse(host: EditorHost) {
  const copilot = getEdgelessCopilotWidget(host);
  copilot.hideCopilotPanel();
  copilot.lockToolbar(false);
  // The generic hide callback clears selection; the accepted owner owns it now.
  getAIPanelWidget(host).hide(false);
  host.std.get(GfxControllerIdentifier).tool.setTool(DefaultTool);
  host.focus({ preventScroll: true });
}

export async function responseToExpandMindmap(
  host: EditorHost,
  ctx: AIContext,
) {
  if (await acceptSourceMindmap(host, ctx, { kind: "expand" }))
    finishSourceMindmapResponse(host);
}

async function responseToBrainstormMindmap(host: EditorHost, ctx: AIContext) {
  const rect = getEdgelessCopilotWidget(host).selectionModelRect;
  if (
    await acceptSourceMindmap(host, ctx, {
      kind: "native",
      x: rect.x + rect.width + 100,
      y: rect.y,
    })
  )
    finishSourceMindmapResponse(host);
}

function getMakeItRealHTML(host: EditorHost) {
  const aiPanel = getAIPanelWidget(host);
  let html = aiPanel.answer;
  if (!html) return;
  html = preprocessHtml(html);
  return html;
}

function responseToMakeItReal(host: EditorHost, ctx: AIContext) {
  const aiPanel = getAIPanelWidget(host);
  const html = getMakeItRealHTML(host);
  if (!html) return;

  const edgelessCopilot = getEdgelessCopilotWidget(host);
  const surface = getSurfaceBlock(host.store);
  if (!surface) return;

  const data = ctx.get();
  const bounds = edgelessCopilot.determineInsertionBounds(
    data.width || 800,
    data.height || 600,
  );

  edgelessCopilot.hideCopilotPanel();
  aiPanel.hide();

  host.store.transact(() => {
    const ifUseCodeBlock = host.std.getOptional(
      CodeBlockPreviewIdentifier("html"),
    );

    if (ifUseCodeBlock) {
      const note = host.store.addBlock(
        "myoxus:note",
        {
          xywh: bounds.serialize(),
        },
        host.store.root,
      );
      host.store.addBlock(
        "myoxus:code",
        { text: new Text(html), language: "html", preview: true },
        note,
      );
    } else {
      host.store.addBlock(
        "myoxus:embed-html",
        {
          html,
          design: "ai:makeItReal", // as tag
          xywh: bounds.serialize(),
        },
        surface.id,
      );
    }
  });
}

async function responseToCreateSlides(host: EditorHost, ctx: AIContext) {
  const data = ctx.get();
  const { contents = [], images = [] } = data;
  if (contents.length === 0) return;

  try {
    for (let i = 0; i < contents.length; i++) {
      const image = images[i] || [];
      const content = contents[i];
      const job = createTemplateJob(host.std, "template");

      const imagePromises = image.map(async ({ id, url }) => {
        const response = await fetch(url);
        const blob = await response.blob();
        job.job.assets.set(id, blob);
      });

      await Promise.all(imagePromises);
      await job.insertTemplate(content);
    }

    getSurfaceElementFromEditor(host)?.refresh();
  } catch (error) {
    console.error("Error creating slides:", error);
  }
}

const getButtonText: {
  [key in keyof Partial<VirgultumPresets.AIActions>]: (
    variants?: Omit<
      Parameters<VirgultumPresets.AIActions[key]>[0],
      keyof VirgultumPresets.AITextActionOptions
    >,
  ) => string | undefined;
} = {
  brainstormMindmap: (variants) => {
    return variants?.regenerate ? "Replace" : undefined;
  },
};

export function actionToResponse<T extends keyof VirgultumPresets.AIActions>(
  id: T,
  host: EditorHost,
  ctx: AIContext,
  variants?: Omit<
    Parameters<VirgultumPresets.AIActions[T]>[0],
    keyof VirgultumPresets.AITextActionOptions
  >,
): FinishConfig {
  return {
    responses: [
      {
        name: "Response",
        testId: "answer-responses",
        items: [
          {
            name: "Continue in chat",
            testId: "answer-continue-in-chat",
            icon: ChatWithAiIcon({}),
            handler: () => {
              reportResponse("result:continue-in-chat");
              edgelesContinueResponseHandler(id, host, ctx).catch(
                console.error,
              );
            },
          },
          ...createInsertItems(id, host, ctx, variants),
          asCaption(id, host),
          retry(getAIPanelWidget(host)),
          discard(getAIPanelWidget(host), getEdgelessCopilotWidget(host)),
        ],
      },
    ],
    actions: [],
  };
}

function continueExpandMindmap(ctx: AIContext) {
  const mindmapNode = ctx.get().node;
  if (!mindmapNode) {
    return null;
  }
  return {
    snapshot: JSON.stringify(mindmapNode),
  };
}

function continueBrainstormMindmap(ctx: AIContext) {
  const mindmap = ctx.get().node;
  if (!mindmap) {
    return null;
  }
  return {
    snapshot: JSON.stringify(mindmap),
  };
}

function continueMakeItReal(host: EditorHost) {
  const html = getMakeItRealHTML(host);
  if (!html) {
    return null;
  }
  return {
    html,
  };
}

function continueCreateSlides(ctx: AIContext) {
  const { contents = [] } = ctx.get();
  return {
    snapshot: JSON.stringify(contents),
  };
}

async function continueCreateImage(host: EditorHost) {
  const aiPanel = getAIPanelWidget(host);
  // `DataURL` or `URL`
  const data = aiPanel.answer;
  if (!data) return null;

  const filename = "image";
  const imageProxy = host.std.clipboard.configs.get("imageProxy");

  try {
    const image = await fetchImageToFile(data, filename, imageProxy);
    return image
      ? {
          images: [image],
        }
      : null;
  } catch (error) {
    console.error("Failed fetch image", error);
    return null;
  }
}

function continueDefaultHandler(host: EditorHost) {
  const panel = getAIPanelWidget(host);
  return {
    combinedElementsMarkdown: panel.answer,
  };
}

async function edgelesContinueResponseHandler<
  T extends keyof VirgultumPresets.AIActions,
>(id: T, host: EditorHost, ctx: AIContext) {
  let context: Partial<ChatContextValue> | null = null;
  switch (id) {
    case "expandMindmap":
      context = continueExpandMindmap(ctx);
      break;
    case "brainstormMindmap":
      context = continueBrainstormMindmap(ctx);
      break;
    case "makeItReal":
      context = continueMakeItReal(host);
      break;
    case "createSlides":
      context = continueCreateSlides(ctx);
      break;
    case "createImage":
    case "filterImage":
    case "processImage":
      context = await continueCreateImage(host);
      break;
    default:
      context = continueDefaultHandler(host);
      break;
  }

  const panel = getAIPanelWidget(host);
  AIProvider.slots.requestOpenWithChat.next({
    host,
    context,
    fromAnswer: true,
  });
  panel.hide();
}

export function actionToGenerating<T extends keyof VirgultumPresets.AIActions>(
  id: T,
  generatingIcon: TemplateResult<1>,
) {
  return {
    generatingIcon,
    stages: generatingStages[id],
  };
}

export function actionToErrorResponse<
  T extends keyof VirgultumPresets.AIActions,
>(
  panel: MyoxusAIPanelWidget,
  id: T,
  host: EditorHost,
  ctx: AIContext,
  variants?: Omit<
    Parameters<VirgultumPresets.AIActions[T]>[0],
    keyof VirgultumPresets.AITextActionOptions
  >,
): ErrorConfig {
  return {
    upgrade: () => {
      panel.hide();
    },
    login: () => {
      AIProvider.slots.requestLogin.next({ host: panel.host });
      panel.hide();
    },
    cancel: () => {
      panel.hide();
    },
    responses: [
      {
        name: "Response",
        items: createInsertItems(id, host, ctx, variants),
      },
      {
        name: "",
        items: [
          retry(getAIPanelWidget(host)),
          discard(getAIPanelWidget(host), getEdgelessCopilotWidget(host)),
        ],
      },
    ],
  };
}
