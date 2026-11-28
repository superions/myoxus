// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  CodeBlockModel,
  ImageBlockModel,
  ListBlockModel,
  ParagraphBlockModel,
} from "@virgultum/editor/model";
import { getSelectedModelsCommand } from "@virgultum/editor/shared/commands";
import { matchModels } from "@virgultum/editor/shared/utils";
import type { Chain, InitCommandCtx } from "@virgultum/editor/std";

import { actionToHandler } from "../actions/doc-handler";
import { textTones, translateLangs } from "../actions/types";
import type {
  AIItemConfig,
  AIItemGroupConfig,
  AISubItemConfig,
} from "../components/ai-item/types";
import { AIProvider } from "../provider";
import { getAIPanelController } from "../utils/ai-widgets";
import { getEdgelessCopilotWidget } from "../utils/get-edgeless-copilot-widget";
import { continueInChat, reviewCodeActions } from "./code-actions";

type SimpleActionSpec = {
  name: string;
  testId: string;
  icon: MyoxusIconExportName;
  command: keyof VirgultumPresets.AIActions;
  generatingIcon: MyoxusIconExportName;
  beta?: boolean;
  showWhen?: AIItemConfig["showWhen"];
};

const BLOCK_BAR_TRACKER: VirgultumPresets.TrackerOptions = {
  control: "block-action-bar",
  where: "ai-panel",
};

const hasTextBlockSelection = (chain: Chain<InitCommandCtx>) => {
  const [, ctx] = chain
    .pipe(getSelectedModelsCommand, { types: ["block", "text"] })
    .run();
  return Boolean(
    ctx.selectedModels?.some((model) =>
      matchModels(model, [ParagraphBlockModel, ListBlockModel]),
    ),
  );
};

const hasNonHeadingTextSelection = (chain: Chain<InitCommandCtx>) => {
  const [, ctx] = chain
    .pipe(getSelectedModelsCommand, { types: ["block", "text"] })
    .run();
  if (!ctx.selectedModels?.length) return false;
  return ctx.selectedModels.every(
    (model) =>
      matchModels(model, [ParagraphBlockModel, ListBlockModel]) &&
      !model.props.type.startsWith("h"),
  );
};

const hasSingleCodeSelection = (chain: Chain<InitCommandCtx>) => {
  const [, ctx] = chain
    .pipe(getSelectedModelsCommand, { types: ["block", "text"] })
    .run();
  return (
    ctx.selectedModels?.length === 1 &&
    matchModels(ctx.selectedModels[0], [CodeBlockModel])
  );
};

const hasSingleImageSelection = (chain: Chain<InitCommandCtx>) => {
  const [, ctx] = chain
    .pipe(getSelectedModelsCommand, { types: ["block"] })
    .run();
  return (
    ctx.selectedModels?.length === 1 &&
    matchModels(ctx.selectedModels[0], [ImageBlockModel])
  );
};

function makeTextItems(specs: readonly SimpleActionSpec[]): AIItemConfig[] {
  return specs.map((spec) => ({
    name: spec.name,
    testId: spec.testId,
    icon: spec.icon,
    iconName: spec.icon,
    beta: spec.beta,
    showWhen: spec.showWhen ?? hasTextBlockSelection,
    handler: actionToHandler(spec.command, spec.generatingIcon),
  }));
}

export const translateSubItem: AISubItemConfig[] = translateLangs.map(
  (lang) => ({
    type: lang,
    testId: `action-translate-${lang}`,
    handler: actionToHandler("translate", "AiIcon", { lang }),
  }),
);

export const toneSubItem: AISubItemConfig[] = textTones.map((tone) => ({
  type: tone,
  testId: `action-change-tone-${tone.toLowerCase()}`,
  handler: actionToHandler("changeTone", "AiIcon", { tone }),
}));

const othersGroup: AIItemGroupConfig = {
  name: "Others",
  items: [
    {
      ...continueInChat,
      icon: "CommentIcon",
      handler: (host) => {
        const panel = getAIPanelController(host);
        const copilot = getEdgelessCopilotWidget(host);
        AIProvider.slots.requestOpenWithChat.next({ host, autoSelect: true });
        copilot?.hideCopilotPanel();
        panel.hide();
      },
    },
  ],
};

export const pageAIGroups: AIItemGroupConfig[] = [
  {
    name: "review text",
    items: makeTextItems([
      {
        name: "Fix spelling",
        testId: "action-fix-spelling",
        icon: "DoneIcon",
        command: "fixSpelling",
        generatingIcon: "AiIcon",
      },
      {
        name: "Fix grammar",
        testId: "action-fix-grammar",
        icon: "DoneIcon",
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
    items: reviewCodeActions.map(({ command, ...item }) => ({
      ...item,
      icon: "ExplainIcon",
      showWhen: hasSingleCodeSelection,
      handler: actionToHandler(command, "AiIcon"),
    })),
  },
  {
    name: "review image",
    items: [
      {
        name: "Explain this image",
        testId: "action-explain-image",
        icon: "PenIcon",
        iconName: "PenIcon",
        showWhen: hasSingleImageSelection,
        handler: actionToHandler("explainImage", "AiIcon"),
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
        iconName: "LanguageIcon",
        showWhen: hasTextBlockSelection,
        subItem: translateSubItem,
      },
      {
        name: "Change tone to",
        testId: "action-change-tone",
        icon: "ToneIcon",
        iconName: "ToneIcon",
        showWhen: hasTextBlockSelection,
        subItem: toneSubItem,
      },
      ...makeTextItems([
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
    items: makeTextItems([
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
        showWhen: hasNonHeadingTextSelection,
      },
      {
        name: "Generate outline",
        testId: "action-generate-outline",
        icon: "PenIcon",
        command: "writeOutline",
        generatingIcon: "PenIcon",
      },
      {
        name: "Brainstorm ideas with mind map",
        testId: "action-brainstorm-mindmap",
        icon: "MindmapIcon",
        command: "brainstormMindmap",
        generatingIcon: "PenIcon",
      },
      {
        name: "Generate presentation",
        testId: "action-generate-presentation",
        icon: "PresentationIcon",
        command: "createSlides",
        generatingIcon: "PresentationIcon",
        beta: true,
      },
      {
        name: "Make it real",
        testId: "action-make-it-real",
        icon: "MakeItRealIcon",
        command: "makeItReal",
        generatingIcon: "CodeIcon",
        beta: true,
      },
      {
        name: "Find actions",
        testId: "action-find-actions",
        icon: "SearchIcon",
        command: "findActions",
        generatingIcon: "AiIcon",
        beta: true,
      },
    ]),
  },
  {
    name: "draft from text",
    items: makeTextItems([
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
  othersGroup,
];

export function buildAIImageItemGroups(): AIItemGroupConfig[] {
  return [
    {
      name: "review image",
      items: [
        {
          name: "Explain this image",
          testId: "action-explain-image",
          icon: "ImageIcon",
          iconName: "ImageIcon",
          showWhen: () => true,
          handler: actionToHandler(
            "explainImage",
            "AiIcon",
            undefined,
            BLOCK_BAR_TRACKER,
          ),
        },
      ],
    },
    {
      name: "touch up image",
      items: [
        {
          name: "Generate a caption",
          testId: "action-generate-caption",
          icon: "PenIcon",
          iconName: "PenIcon",
          showWhen: () => true,
          beta: true,
          handler: actionToHandler(
            "generateCaption",
            "AiIcon",
            undefined,
            BLOCK_BAR_TRACKER,
          ),
        },
      ],
    },
    othersGroup,
  ];
}

export function buildAICodeItemGroups(): AIItemGroupConfig[] {
  return [
    {
      name: "review code",
      items: reviewCodeActions.map(({ command, ...item }) => ({
        ...item,
        icon: "ExplainIcon",
        handler: actionToHandler(
          command,
          "AiIcon",
          undefined,
          BLOCK_BAR_TRACKER,
        ),
      })),
    },
    othersGroup,
  ];
}
