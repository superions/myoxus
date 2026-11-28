// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  EdgelessClipboardController,
  splitElements,
} from "@virgultum/editor/blocks/root";
import { TextElementModel } from "@virgultum/editor/model";
import type { EditorHost } from "@virgultum/editor/std";

import {
  actionToHandler,
  imageOnlyShowWhen,
  mindmapChildShowWhen,
  mindmapRootShowWhen,
  notAllAIChatBlockShowWhen,
  noteBlockOrTextShowWhen,
  noteWithCodeBlockShowWen,
} from "../../actions/edgeless-handler";
import {
  sourceMindmapOutline,
  sourceMindmapSelection,
} from "../../actions/mindmap-source";
import { textTones, translateLangs } from "../../actions/types";
import type {
  AIItemConfig,
  AIItemGroupConfig,
} from "../../components/ai-item/types";
import { AIProvider } from "../../provider";
import { getAIPanelController } from "../../utils/ai-widgets";
import type { AIContext } from "../../utils/context";
import { getEdgelessCopilotWidget } from "../../utils/edgeless";
import { extractSelectedContent } from "../../utils/extract";
import { canvasToBlob } from "../../utils/image";
import {
  getCopilotSelectedElems,
  imageCustomInput,
} from "../../utils/selection-utils";

/** Neutral bitmap backdrop for wireframe exports sent to AI providers (not UI chrome). */
const WIREFRAME_EXPORT_BACKGROUND = "white";

type EdgelessTextActionSpec = {
  name: string;
  testId: string;
  icon: MyoxusIconExportName;
  command: keyof VirgultumPresets.AIActions;
  generatingIcon: MyoxusIconExportName;
  beta?: boolean;
};

function makeNoteOrTextItems(
  specs: readonly EdgelessTextActionSpec[],
): AIItemConfig[] {
  return specs.map((spec) => ({
    name: spec.name,
    testId: spec.testId,
    icon: spec.icon,
    beta: spec.beta,
    showWhen: noteBlockOrTextShowWhen,
    handler: actionToHandler(spec.command, spec.generatingIcon),
  }));
}

async function extractMakeItRealInput(host: EditorHost, ctx: AIContext) {
  const selected = getCopilotSelectedElems(host);
  if (selected.length === 0) {
    const prompt = getAIPanelController(host).inputText?.trim();
    return prompt ? { input: prompt } : undefined;
  }

  const { notes, frames, shapes, images, edgelessTexts } =
    splitElements(selected);
  const totalCount =
    frames.length +
    images.length +
    notes.length +
    shapes.length +
    edgelessTexts.length;
  if (totalCount === 0) return;

  let content = ctx.get().content || "";
  const isSingleTextLike =
    images.length === 0 &&
    notes.length + shapes.length + edgelessTexts.length === 1 &&
    (notes.length === 1 ||
      edgelessTexts.length === 1 ||
      (shapes.length === 1 && shapes[0] instanceof TextElementModel));
  if (isSingleTextLike) {
    return { input: content };
  }

  if (!content) {
    content = getAIPanelController(host).inputText?.trim() || "";
  }

  const clipboard = host.std.getOptional(EdgelessClipboardController);
  if (!clipboard) return;

  const canvas = await clipboard.toCanvas(
    [...notes, ...frames, ...images],
    shapes,
    { dpr: 1, background: WIREFRAME_EXPORT_BACKGROUND },
  );
  if (!canvas) return;

  const png = await canvasToBlob(canvas);
  if (!png) return;

  ctx.set({ width: canvas.width, height: canvas.height });
  return { input: content, attachments: [png] };
}

const translateSubItems = translateLangs.map((lang) => ({
  type: lang,
  testId: `action-translate-${lang}`,
  handler: actionToHandler("translate", "AiIcon", { lang }),
}));

const toneSubItems = textTones.map((tone) => ({
  type: tone,
  testId: `action-change-tone-${tone.toLowerCase()}`,
  handler: actionToHandler("changeTone", "AiIcon", { tone }),
}));

export const edgelessAIGroups: AIItemGroupConfig[] = [
  {
    name: "review text",
    items: makeNoteOrTextItems([
      {
        name: "Fix spelling",
        testId: "action-fix-spelling",
        icon: "PenIcon",
        command: "fixSpelling",
        generatingIcon: "AiIcon",
      },
      {
        name: "Fix grammar",
        testId: "action-fix-grammar",
        icon: "PenIcon",
        command: "improveGrammar",
        generatingIcon: "AiIcon",
      },
      {
        name: "Explain selection",
        testId: "action-explain-selection",
        icon: "SelectionIcon",
        command: "explain",
        generatingIcon: "AiIcon",
      },
    ]),
  },
  {
    name: "review code",
    items: [
      {
        name: "Explain this code",
        icon: "ExplainIcon",
        testId: "action-explain-code",
        showWhen: noteWithCodeBlockShowWen,
        handler: actionToHandler("explainCode", "AiIcon"),
      },
      {
        name: "Check code error",
        icon: "ExplainIcon",
        testId: "action-check-code-error",
        showWhen: noteWithCodeBlockShowWen,
        handler: actionToHandler("checkCodeErrors", "AiIcon"),
      },
    ],
  },
  {
    name: "review image",
    items: [
      {
        name: "Explain this image",
        icon: "PenIcon",
        testId: "action-explain-image",
        showWhen: imageOnlyShowWhen,
        handler: actionToHandler(
          "explainImage",
          "AiIcon",
          undefined,
          imageCustomInput,
        ),
      },
    ],
  },
  {
    name: "edit text",
    items: [
      {
        name: "Translate to",
        testId: "action-translate",
        icon: "LanguageIcon",
        showWhen: noteBlockOrTextShowWhen,
        subItem: translateSubItems,
      },
      {
        name: "Change tone to",
        testId: "action-change-tone",
        icon: "ToneIcon",
        showWhen: noteBlockOrTextShowWhen,
        subItem: toneSubItems,
      },
      ...makeNoteOrTextItems([
        {
          name: "Improve writing",
          testId: "action-improve-writing",
          icon: "ImproveWritingIcon",
          command: "improveWriting",
          generatingIcon: "AiIcon",
        },
        {
          name: "Make it longer",
          testId: "action-make-it-longer",
          icon: "LongerIcon",
          command: "makeLonger",
          generatingIcon: "AiIcon",
        },
        {
          name: "Make it shorter",
          testId: "action-make-it-shorter",
          icon: "ShorterIcon",
          command: "makeShorter",
          generatingIcon: "AiIcon",
        },
        {
          name: "Continue writing",
          testId: "action-continue-writing",
          icon: "PenIcon",
          command: "continueWriting",
          generatingIcon: "PenIcon",
        },
      ]),
    ],
  },
  {
    name: "generate from text",
    items: [
      ...makeNoteOrTextItems([
        {
          name: "Summarize",
          testId: "action-summarize",
          icon: "PenIcon",
          command: "summary",
          generatingIcon: "PenIcon",
        },
        {
          name: "Generate headings",
          testId: "action-generate-headings",
          icon: "PenIcon",
          command: "createHeadings",
          generatingIcon: "PenIcon",
          beta: true,
        },
        {
          name: "Generate outline",
          testId: "action-generate-outline",
          icon: "PenIcon",
          command: "writeOutline",
          generatingIcon: "PenIcon",
        },
      ]),
      {
        name: "Expand from this mind map node",
        icon: "MindmapNodeIcon",
        testId: "action-expand-mindmap-node",
        showWhen: mindmapChildShowWhen,
        beta: true,
        handler: actionToHandler(
          "expandMindmap",
          "MindmapIcon",
          undefined,
          (host) => {
            const selection = sourceMindmapSelection(
              getCopilotSelectedElems(host)[0],
            );
            return Promise.resolve(
              selection
                ? {
                    input: selection.node.label,
                    mindmap: sourceMindmapOutline(selection),
                  }
                : {},
            );
          },
        ),
      },
      {
        name: "Brainstorm ideas with mind map",
        icon: "MindmapIcon",
        testId: "action-brainstorm-mindmap",
        showWhen: noteBlockOrTextShowWhen,
        handler: actionToHandler("brainstormMindmap", "MindmapIcon"),
      },
      {
        name: "Regenerate mind map",
        icon: "MindmapIcon",
        testId: "action-regenerate-mindmap",
        showWhen: mindmapRootShowWhen,
        handler: actionToHandler("brainstormMindmap", "MindmapIcon", {
          regenerate: true,
        }),
      },
      {
        name: "Generate presentation",
        icon: "PresentationIcon",
        testId: "action-generate-presentation",
        showWhen: noteBlockOrTextShowWhen,
        beta: true,
        handler: actionToHandler("createSlides", "PresentationIcon"),
      },
      {
        name: "Make it real",
        icon: "MakeItRealIcon",
        testId: "action-make-it-real",
        beta: true,
        showWhen: notAllAIChatBlockShowWhen,
        handler: actionToHandler(
          "makeItReal",
          "CodeIcon",
          undefined,
          extractMakeItRealInput,
        ),
      },
      {
        name: "Generate a caption",
        icon: "PenIcon",
        testId: "action-generate-caption",
        showWhen: imageOnlyShowWhen,
        beta: true,
        handler: actionToHandler(
          "generateCaption",
          "AiIcon",
          undefined,
          imageCustomInput,
        ),
      },
      {
        name: "Find actions",
        icon: "SearchIcon",
        testId: "action-find-actions",
        showWhen: noteBlockOrTextShowWhen,
        beta: true,
        handler: actionToHandler("findActions", "AiIcon"),
      },
    ],
  },
  {
    name: "draft from text",
    items: makeNoteOrTextItems([
      {
        name: "Write an article about this",
        testId: "action-write-article",
        icon: "PenIcon",
        command: "writeArticle",
        generatingIcon: "PenIcon",
      },
      {
        name: "Write a tweet about this",
        testId: "action-write-twitter-post",
        icon: "PenIcon",
        command: "writeTwitterPost",
        generatingIcon: "PenIcon",
      },
      {
        name: "Write a poem about this",
        testId: "action-write-poem",
        icon: "PenIcon",
        command: "writePoem",
        generatingIcon: "PenIcon",
      },
      {
        name: "Write a blog post about this",
        testId: "action-write-blog-post",
        icon: "PenIcon",
        command: "writeBlogPost",
        generatingIcon: "PenIcon",
      },
      {
        name: "Brainstorm ideas about this",
        testId: "action-brainstorm",
        icon: "PenIcon",
        command: "brainstorm",
        generatingIcon: "PenIcon",
      },
    ]),
  },
  {
    name: "others",
    items: [
      {
        name: "Continue in AI Chat",
        testId: "action-continue-with-ai",
        icon: "CommentIcon",
        showWhen: () => true,
        handler: (host) => {
          const panel = getAIPanelController(host);
          const copilot = getEdgelessCopilotWidget(host);
          extractSelectedContent(host)
            .then((context) => {
              AIProvider.slots.requestOpenWithChat.next({
                host,
                mode: "edgeless",
                autoSelect: true,
                context,
              });
            })
            .catch(console.error);
          copilot.hideCopilotPanel();
          panel.hide();
        },
      },
    ],
  },
];
