// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import { splitElements } from "@virgultum/editor/blocks/root";
import { DefaultTool } from "@virgultum/editor/blocks/surface";
import {
  CodeBlockModel,
  EdgelessTextBlockModel,
  EmbedSyncedDocModel,
  ImageBlockModel,
  NoteBlockModel,
  ShapeElementModel,
  TextElementModel,
} from "@virgultum/editor/model";
import { matchModels } from "@virgultum/editor/shared/utils";
import type { EditorHost } from "@virgultum/editor/std";
import {
  GfxControllerIdentifier,
  type GfxModel,
} from "@virgultum/editor/std/gfx";
import { Slice } from "@virgultum/editor/store";

import { getContentFromSlice } from "../../utils";
import { AIChatBlockModel } from "../blocks";
import { AIProvider } from "../provider";
import { reportResponse } from "../utils/action-reporter";
import { getAIPanelController } from "../utils/ai-widgets";
import { AIContext } from "../utils/context";
import {
  getEdgelessCopilotWidget,
  isMindmapChild,
  isMindMapRoot,
} from "../utils/edgeless";
import { copyTextAnswer } from "../utils/editor-actions";
import {
  getCopilotSelectedElems,
  getSelectedNoteAnchor,
  getSelections,
} from "../utils/selection-utils";
import type { AIPanelController } from "../widgets/ai-panel/controller";
import type { EdgelessCopilotWidget } from "../widgets/edgeless-copilot";
import { actionToAnswerRenderer } from "./answer-renderer";
import { EXCLUDING_COPY_ACTIONS } from "./consts";
import { bindTextStream } from "./doc-handler";
import {
  actionToErrorResponse,
  actionToGenerating,
  actionToResponse,
  getToolbar,
} from "./edgeless-response";
import {
  captureMindmapSourceBasis,
  sourceMindmapOutline,
  sourceMindmapSelection,
} from "./mindmap-source";

type ActionVariants<K extends keyof VirgultumPresets.AIActions> = Omit<
  Parameters<VirgultumPresets.AIActions[K]>[0],
  keyof VirgultumPresets.AITextActionOptions
>;

type CustomInputExtractor = (
  host: EditorHost,
  ctx: AIContext,
) => Promise<{
  input?: string;
  content?: string;
  attachments?: Array<string | Blob>;
  seed?: string;
  mindmap?: string;
} | void>;

async function extractContainerBlockText(
  host: EditorHost,
  blocks: Array<EdgelessTextBlockModel | NoteBlockModel>,
): Promise<string[]> {
  const rendered = await Promise.all(
    blocks.map((model) =>
      getContentFromSlice(host, Slice.fromModels(host.store, model.children)),
    ),
  );
  return rendered.map((text) => text.trim()).filter(Boolean);
}

export async function getContentFromSelected(
  host: EditorHost,
  selected: GfxModel[],
): Promise<string> {
  if (selected.length === 1) {
    const mindmap = sourceMindmapSelection(selected[0]);
    if (mindmap) return sourceMindmapOutline(mindmap);
  }

  const notes: NoteBlockModel[] = [];
  const edgelessTexts: EdgelessTextBlockModel[] = [];
  const syncedDocs: EmbedSyncedDocModel[] = [];
  const plainTexts: string[] = [];
  const shapeTexts: string[] = [];
  const captions: string[] = [];

  for (const item of selected) {
    if (item instanceof NoteBlockModel) {
      notes.push(item);
    } else if (item instanceof TextElementModel) {
      plainTexts.push(item.text.toString());
    } else if (item instanceof ShapeElementModel && item.text?.length) {
      shapeTexts.push(item.text.toString());
    } else if (item instanceof ImageBlockModel && item.props.caption?.length) {
      captions.push(item.props.caption);
    } else if (item instanceof EdgelessTextBlockModel) {
      edgelessTexts.push(item);
    } else if (item instanceof EmbedSyncedDocModel) {
      syncedDocs.push(item);
    }
  }

  const pageNote = notes.find((note) => note.isPageBlock());
  const titlePrefix =
    pageNote && host.std.store.meta?.title
      ? `# ${host.std.store.meta.title}\n`
      : "";

  const [noteParts, edgelessTextParts, syncedDocText] = await Promise.all([
    extractContainerBlockText(host, notes),
    extractContainerBlockText(host, edgelessTexts),
    syncedDocs.length
      ? getContentFromSlice(
          host,
          Slice.fromModels(host.store, syncedDocs),
        ).then((text) => text.trim())
      : Promise.resolve(""),
  ]);

  return [
    `${titlePrefix}${noteParts.join("\n")}`,
    edgelessTextParts.join("\n"),
    syncedDocText,
    plainTexts.join("\n"),
    shapeTexts.join("\n"),
    captions.join("\n"),
  ]
    .join("\n")
    .trim();
}

function createEdgelessStream<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  host: EditorHost,
  ctx: AIContext,
  input: string,
  signal?: AbortSignal,
  variants?: ActionVariants<K>,
  customInput?: CustomInputExtractor,
  trackerOptions?: VirgultumPresets.TrackerOptions,
): VirgultumPresets.TextStream | undefined {
  const action = AIProvider.actions[id];
  if (typeof action !== "function") return;

  return {
    async *[Symbol.asyncIterator]() {
      const models = getCopilotSelectedElems(host);
      const baseOptions: Record<string, unknown> = {
        ...variants,
        signal,
        stream: true,
        host,
        models,
        docId: host.store.id,
        workspaceId: host.store.workspace.id,
        control: trackerOptions?.control ?? "format-bar",
        where: trackerOptions?.where ?? "ai-panel",
      };

      if (customInput) {
        baseOptions.input = input;
        if (ctx.get().content === "" && input) {
          ctx.set({ content: input });
        }
        const extracted = await customInput(host, ctx);
        if (extracted) {
          Object.assign(baseOptions, extracted);
        }
      } else {
        baseOptions.input = await getContentFromSelected(
          getAIPanelController(host).host,
          models,
        );
      }

      const stream = (await (
        action as (
          opts: Record<string, unknown>,
        ) => Promise<VirgultumPresets.TextStream | undefined>
      )(baseOptions)) as VirgultumPresets.TextStream | undefined;
      if (stream) {
        yield* stream;
      }
    },
  };
}

function configureEdgelessPanel<K extends keyof VirgultumPresets.AIActions>(
  panel: AIPanelController,
  copilot: EdgelessCopilotWidget,
  id: K,
  generatingIcon: MyoxusIconExportName,
  ctx: AIContext,
  variants?: ActionVariants<K>,
  customInput?: CustomInputExtractor,
  trackerOptions?: VirgultumPresets.TrackerOptions,
): void {
  const { config, host } = panel;
  if (!config) return;

  config.answerRenderer = actionToAnswerRenderer(id, host, ctx);
  config.generateAnswer = ({ input, signal, update, finish }) => {
    if (!customInput && getCopilotSelectedElems(host).length === 0) return;
    const stream = createEdgelessStream(
      id,
      host,
      ctx,
      input,
      signal,
      variants,
      customInput,
      trackerOptions,
    );
    if (stream) {
      bindTextStream(stream, { update, finish, signal });
    }
  };
  config.finishStateConfig = actionToResponse(id, host, ctx, variants);
  config.generatingStateConfig = actionToGenerating(id, generatingIcon);
  config.errorStateConfig = actionToErrorResponse(
    panel,
    id,
    host,
    ctx,
    variants,
  );
  config.copy = {
    allowed: !EXCLUDING_COPY_ACTIONS.includes(id),
    onCopy: () => copyTextAnswer(panel),
  };
  config.discardCallback = () => reportResponse("result:discard");
  config.hideCallback = () => {
    copilot.gfx.tool.setTool(DefaultTool);
    copilot.gfx.selection.set({ elements: [], editing: false });
    host.selection.clear();
    copilot.lockToolbar(false);
  };
}

export function actionToHandler<K extends keyof VirgultumPresets.AIActions>(
  id: K,
  generatingIcon: MyoxusIconExportName,
  variants?: ActionVariants<K>,
  customInput?: CustomInputExtractor,
  trackerOptions?: VirgultumPresets.TrackerOptions,
) {
  return (host: EditorHost) => {
    const panel = getAIPanelController(host);
    const copilot = getEdgelessCopilotWidget(host);
    const selectedElements = getCopilotSelectedElems(host);
    const { selectedBlocks } = getSelections(host);
    const ctx = new AIContext({
      selectedElements,
      mindmapSourceBasis:
        id === "brainstormMindmap" || id === "expandMindmap"
          ? captureMindmapSourceBasis(selectedElements[0])
          : undefined,
    });

    copilot.hideCopilotPanel();
    copilot.lockToolbar(true);
    configureEdgelessPanel(
      panel,
      copilot,
      id,
      generatingIcon,
      ctx,
      variants,
      customInput,
      trackerOptions,
    );

    const toolbar = getToolbar(host);
    const isEmpty = selectedElements.length === 0;
    let anchor: Element | null | undefined = null;

    if (selectedBlocks?.length) {
      anchor = selectedBlocks.at(-1);
    } else if (copilot.visible && copilot.selectionElem) {
      anchor = copilot.selectionElem;
    } else if (toolbar?.dataset.open) {
      anchor = toolbar;
    } else if (!isEmpty) {
      const lastId = selectedElements.at(-1)?.id;
      if (!lastId) return;
      anchor = getSelectedNoteAnchor(host, lastId);
    }

    if (!anchor) {
      host.std.get(GfxControllerIdentifier)?.tool.setTool(DefaultTool);
      copilot.lockToolbar(false);
      return;
    }

    const resolveShouldPromptInput = async () => {
      if (id !== "makeItReal") return isEmpty;
      if (isEmpty) return true;
      const { notes, shapes, images, edgelessTexts, embedSyncedDocs } =
        splitElements(selectedElements);
      const targets = [
        ...notes,
        ...shapes,
        ...images,
        ...edgelessTexts,
        ...embedSyncedDocs,
      ];
      if (targets.length === 0) return true;
      const content = await getContentFromSelected(host, targets);
      ctx.set({ content });
      return content.length === 0;
    };

    resolveShouldPromptInput()
      .then((openInput) => {
        panel.toggle(anchor, openInput ? "input" : "generate");
      })
      .catch(console.error);
  };
}

export function noteBlockOrTextShowWhen(
  _chain: unknown,
  _mode: unknown,
  host: EditorHost,
): boolean {
  return getCopilotSelectedElems(host).some(
    (el) =>
      el instanceof NoteBlockModel ||
      el instanceof TextElementModel ||
      el instanceof EdgelessTextBlockModel,
  );
}

export function noteWithCodeBlockShowWen(
  _chain: unknown,
  _mode: unknown,
  host: EditorHost,
): boolean {
  const selected = getCopilotSelectedElems(host);
  return (
    selected.length > 0 &&
    selected[0] instanceof NoteBlockModel &&
    selected[0].children.length === 1 &&
    matchModels(selected[0].children[0], [CodeBlockModel])
  );
}

export function mindmapChildShowWhen(
  _chain: unknown,
  _mode: unknown,
  host: EditorHost,
): boolean {
  const selected = getCopilotSelectedElems(host);
  return selected.length === 1 && isMindmapChild(selected[0]);
}

export function imageOnlyShowWhen(
  _chain: unknown,
  _mode: unknown,
  host: EditorHost,
): boolean {
  const selected = getCopilotSelectedElems(host);
  return selected.length === 1 && selected[0] instanceof ImageBlockModel;
}

export function mindmapRootShowWhen(
  _chain: unknown,
  _mode: unknown,
  host: EditorHost,
): boolean {
  const selected = getCopilotSelectedElems(host);
  return selected.length === 1 && isMindMapRoot(selected[0]);
}

export function notAllAIChatBlockShowWhen(
  _chain: unknown,
  _mode: unknown,
  host: EditorHost,
): boolean {
  const selected = getCopilotSelectedElems(host);
  return (
    selected.length === 0 ||
    !selected.every((model) => model instanceof AIChatBlockModel)
  );
}
