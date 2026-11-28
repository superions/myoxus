// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  BlockIcon,
  EdgelessIcon,
  InsertBleowIcon as InsertBelowIcon,
  LinkedPageIcon,
  PageIcon,
} from "@myoxus/icons/react";
import { EdgelessCRUDIdentifier } from "@virgultum/editor/blocks/surface";
import {
  Bound,
  getCommonBoundWithRotation,
  type SerializedXYWH,
} from "@virgultum/editor/global/gfx";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import {
  type DocMode,
  NoteBlockModel,
  NoteDisplayMode,
} from "@virgultum/editor/model";
import {
  getFirstBlockCommand,
  getLastBlockCommand,
  getSelectedBlocksCommand,
} from "@virgultum/editor/shared/commands";
import type { ImageSelection } from "@virgultum/editor/shared/selection";
import {
  DocModeProvider,
  EditPropsStore,
  NotificationProvider,
  TelemetryProvider,
} from "@virgultum/editor/shared/services";
import type {
  BlockComponent,
  BlockSelection,
  BlockStdScope,
  EditorHost,
  TextSelection,
} from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { Store } from "@virgultum/editor/store";
import { createElement, type ReactNode } from "react";

import { insertFromMarkdown } from "../../utils";
import {
  CHAT_BLOCK_HEIGHT,
  CHAT_BLOCK_WIDTH,
} from "../blocks/ai-chat-block/model/consts";
import type { ChatMessage } from "../components/ai-chat-messages";
import { chatI18n } from "../components/chat-i18n";
import { AIProvider, type AIUserInfo } from "../provider";
import { reportResponse } from "../utils/action-reporter";
import { insertBelow } from "../utils/editor-actions";

type Selections = {
  text?: TextSelection;
  blocks?: BlockSelection[];
  images?: ImageSelection[];
};

const ACTION_ICON_SIZE =
  "calc(var(--mantine-spacing-lg) + var(--mantine-spacing-xs))";

export type ChatAction = {
  icon: ReactNode;
  title: string;
  toast: string;
  showWhen: (host: EditorHost) => boolean;
  handler: (
    host: EditorHost,
    content: string,
    currentSelections: Selections,
    chatSessionId?: string,
    messageId?: string,
  ) => boolean | Promise<boolean>;
};

const isWritableHost = (host: EditorHost) => !host.std.store.readonly$.value;

export async function queryHistoryMessages(
  workspaceId: string,
  forkSessionId: string,
  docId?: string,
): Promise<VirgultumPresets.AIHistory["messages"]> {
  const histories = await AIProvider.histories?.chats(
    workspaceId,
    forkSessionId,
    docId,
  );
  return histories?.[0]?.messages ?? [];
}

export function constructUserInfoWithMessages(
  messages: ChatMessage[],
  userInfo: AIUserInfo | null,
) {
  return messages.map((message) => {
    const userMeta =
      message.role === "user"
        ? {
            userId: userInfo?.id,
            userName: userInfo?.name,
            avatarUrl: userInfo?.avatarUrl ?? undefined,
          }
        : {};
    return {
      ...message,
      ...userMeta,
      attachments: [],
      streamObjects: message.streamObjects ?? [],
    };
  });
}

export async function constructRootChatBlockMessages(
  doc: Store,
  forkSessionId: string,
) {
  const [userInfo, forkMessages] = await Promise.all([
    AIProvider.userInfo,
    queryHistoryMessages(doc.workspace.id, forkSessionId, doc.id),
  ]);
  return constructUserInfoWithMessages(forkMessages as ChatMessage[], userInfo);
}

export function promptDocTitle(host: EditorHost, autofill?: string) {
  const notification = host.std.getOptional(NotificationProvider);
  if (!notification) return Promise.resolve(undefined);

  return notification.prompt({
    title: chatI18n()["com.myoxus.editor.toolbar.create-linked-doc"](),
    message: chatI18n()["com.myoxus.editor.linked-doc.title-prompt"](),
    placeholder: chatI18n()["Untitled"](),
    autofill,
    confirmText: chatI18n()["Confirm"](),
    cancelText: chatI18n()["Cancel"](),
  });
}

function resolveViewportCenter(mode: DocMode, std: BlockStdScope) {
  if (mode === "edgeless") {
    const { centerX, centerY } = std.get(GfxControllerIdentifier).viewport;
    return { x: centerX, y: centerY };
  }

  const stored = std.get(EditPropsStore).getStorage("viewport");
  if (!stored) return { x: 400, y: 50 };
  if ("xywh" in stored) {
    const bound = Bound.deserialize(stored.xywh);
    return { x: bound.x + bound.w / 2, y: bound.y + bound.h / 2 };
  }
  return { x: stored.centerX, y: stored.centerY };
}

function appendAIChatBlock(
  host: EditorHost,
  messages: ChatMessage[],
  sessionId: string,
  center: { x: number; y: number },
  index: string,
) {
  if (!messages.length || !sessionId) return;

  const { store } = host;
  const surface = store
    .getAllModels()
    .find((block) => block.flavour === "myoxus:surface");
  if (!surface) return;

  const bound = new Bound(
    center.x - CHAT_BLOCK_WIDTH / 2,
    center.y - CHAT_BLOCK_HEIGHT / 2,
    CHAT_BLOCK_WIDTH,
    CHAT_BLOCK_HEIGHT,
  );

  return store.addBlock(
    "myoxus:embed-ai-chat",
    {
      xywh: bound.serialize(),
      messages: JSON.stringify(messages),
      index,
      sessionId,
      rootWorkspaceId: store.workspace.id,
      rootDocId: store.id,
    },
    surface.id,
  );
}

function resolveSelectedTailBlock(
  host: EditorHost,
  selections: Selections,
): BlockComponent | null {
  const [, { selectedBlocks }] = host.command.exec(getSelectedBlocksCommand, {
    currentTextSelection: selections.text,
    currentBlockSelections: selections.blocks,
    currentImageSelections: selections.images,
  });
  return selectedBlocks?.length
    ? selectedBlocks[selectedBlocks.length - 1]
    : null;
}

async function insertAnswerBelowBlock(
  host: EditorHost,
  content: string,
  target: BlockComponent | null,
): Promise<boolean> {
  if (!target) return false;
  reportResponse("result:insert");
  await insertBelow(host, content, target);
  return true;
}

const ADD_TO_EDGELESS_AS_NOTE: ChatAction = {
  icon: createElement(EdgelessIcon, {
    width: ACTION_ICON_SIZE,
    height: ACTION_ICON_SIZE,
  }),
  get title() {
    return chatI18n()["com.myoxus.ai.chat-panel.add-as-note"]();
  },
  get toast() {
    return chatI18n()["com.myoxus.ai.chat-panel.note-created"]();
  },
  showWhen: isWritableHost,
  handler: async (host, content) => {
    reportResponse("result:add-note");
    const { store } = host;
    const gfx = host.std.get(GfxControllerIdentifier);
    const selected = gfx.selection.selectedElements;
    const props: { displayMode: NoteDisplayMode; xywh?: SerializedXYWH } = {
      displayMode: NoteDisplayMode.EdgelessOnly,
    };

    if (selected.length > 0) {
      const bound = getCommonBoundWithRotation(
        selected.map((el) => Bound.deserialize(el.xywh)),
      );
      props.xywh = new Bound(bound.x, bound.maxY + 10, bound.w).serialize();
    }

    const noteId = store.addBlock("myoxus:note", props, store.root?.id);
    await insertFromMarkdown(host, content, store, noteId, 0);
    gfx.selection.set({ elements: [noteId], editing: false });
    return true;
  },
};

export const PAGE_INSERT: ChatAction = {
  icon: createElement(InsertBelowIcon, {
    width: ACTION_ICON_SIZE,
    height: ACTION_ICON_SIZE,
  }),
  get title() {
    return chatI18n()["com.myoxus.common.insert"]();
  },
  get toast() {
    return chatI18n()["com.myoxus.ai.chat-panel.inserted"]();
  },
  showWhen: isWritableHost,
  handler: async (host, content, selections) => {
    const selected = resolveSelectedTailBlock(host, selections);
    if (selected) {
      return insertAnswerBelowBlock(host, content, selected);
    }

    const [, { firstBlock: noteBlock }] = host.command.exec(
      getFirstBlockCommand,
      { flavour: "myoxus:note" },
    );
    const lastChild = noteBlock?.lastChild();
    const fallback = lastChild ? host.std.view.getBlock(lastChild.id) : null;
    return insertAnswerBelowBlock(host, content, fallback);
  },
};

export const EDGELESS_INSERT: ChatAction = {
  icon: PAGE_INSERT.icon,
  get title() {
    return PAGE_INSERT.title;
  },
  get toast() {
    return PAGE_INSERT.toast;
  },
  showWhen: isWritableHost,
  handler: async (host, content, selections) => {
    const selected = resolveSelectedTailBlock(host, selections);
    if (selected) {
      return insertAnswerBelowBlock(host, content, selected);
    }

    const elements = host.std.get(GfxControllerIdentifier).selection
      .selectedElements;
    if (elements.length === 1 && elements[0] instanceof NoteBlockModel) {
      const [, { lastBlock }] = host.command.exec(getLastBlockCommand, {
        root: elements[0],
      });
      const tail = lastBlock ? host.std.view.getBlock(lastBlock.id) : null;
      return insertAnswerBelowBlock(host, content, tail);
    }

    return Boolean(
      await ADD_TO_EDGELESS_AS_NOTE.handler(host, content, selections),
    );
  },
};

const SAVE_AS_BLOCK: ChatAction = {
  icon: createElement(BlockIcon, {
    width: ACTION_ICON_SIZE,
    height: ACTION_ICON_SIZE,
  }),
  get title() {
    return chatI18n()["com.myoxus.ai.chat-panel.save-as-block"]();
  },
  get toast() {
    return chatI18n()["com.myoxus.ai.chat-panel.block-saved"]();
  },
  showWhen: isWritableHost,
  handler: async (host, _content, _selections, chatSessionId, messageId) => {
    if (!chatSessionId || !messageId) return false;

    const notifications = host.std.getOptional(NotificationProvider);
    const docMode = host.std.get(DocModeProvider);
    const layer = host.std.get(GfxControllerIdentifier).layer;
    const currentMode = docMode.getEditorMode() || "page";
    const viewportCenter = resolveViewportCenter(currentMode, host.std);
    const blockIndex = layer.generateIndex();

    if (currentMode !== "edgeless") {
      docMode.setEditorMode("edgeless" as DocMode);
      notifications?.notify({
        title: chatI18n()["com.myoxus.ai.chat-panel.save-as-block"](),
        accent: "info",
        message: chatI18n()["com.myoxus.ai.chat-panel.block-mode"](),
        onClose: () => {},
      });
    }

    try {
      const forkedSessionId = await AIProvider.forkChat?.({
        workspaceId: host.store.workspace.id,
        docId: host.store.id,
        sessionId: chatSessionId,
        latestMessageId: messageId,
      });
      if (!forkedSessionId) return false;

      const messages = await constructRootChatBlockMessages(
        host.store,
        forkedSessionId,
      );
      const blockId = appendAIChatBlock(
        host,
        messages,
        forkedSessionId,
        viewportCenter,
        blockIndex,
      );
      if (!blockId) return false;

      host.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "manually save",
        page: "whiteboard editor",
        module: "ai chat panel",
        segment: "right sidebar",
        type: "chat block",
        category: "root",
      });
      return true;
    } catch (err) {
      console.error(err);
      notifications?.notify({
        title: chatI18n()["com.myoxus.ai.chat-panel.block-save-failed"](),
        accent: "error",
        onClose: () => {},
      });
      return false;
    }
  },
};

export const SAVE_AS_DOC = {
  icon: createElement(PageIcon, {
    width: ACTION_ICON_SIZE,
    height: ACTION_ICON_SIZE,
  }),
  get title() {
    return chatI18n()["com.myoxus.ai.chat-panel.save-as-doc"]();
  },
  get toast() {
    return chatI18n()["com.myoxus.ai.chat-panel.doc-created"]();
  },
  showWhen: () => true,
  handler: async (host: EditorHost, content: string) => {
    reportResponse("result:add-page");
    const workspace = host.store.workspace;
    const targetDoc = workspace.createDoc().getStore();
    try {
      targetDoc.load();
      const rootId = targetDoc.addBlock("myoxus:page");
      targetDoc.addBlock("myoxus:surface", {}, rootId);
      const noteId = targetDoc.addBlock("myoxus:note", {}, rootId);
      await insertFromMarkdown(host, content, targetDoc, noteId, 0);
      if (!targetDoc.getModelById(noteId)?.children.length) {
        throw new Error("The saved answer has no importable content");
      }
    } catch (err) {
      workspace.removeDoc(targetDoc.id);
      console.error(err);
      host.std
        .getOptional(NotificationProvider)
        ?.toast(chatI18n()["com.myoxus.workspace-home.layout.save-failed"]());
      return false;
    }

    host.std.getOptional(RefNodeSlotsProvider)?.docLinkClicked.next({
      pageId: targetDoc.id,
      host,
    });
    return true;
  },
};

const CREATE_AS_LINKED_DOC: ChatAction = {
  icon: createElement(LinkedPageIcon, {
    width: ACTION_ICON_SIZE,
    height: ACTION_ICON_SIZE,
  }),
  get title() {
    return chatI18n()["com.myoxus.editor.toolbar.create-linked-doc"]();
  },
  get toast() {
    return chatI18n()["com.myoxus.ai.chat-panel.doc-created"]();
  },
  showWhen: isWritableHost,
  handler: async (host, content) => {
    reportResponse("result:add-page");
    const { store } = host;
    const surface = store
      .getAllModels()
      .find((block) => block.flavour === "myoxus:surface");
    if (!surface) return false;

    const mode = host.std.get(DocModeProvider).getEditorMode();
    if (mode !== "edgeless") return false;

    const targetDoc = store.workspace.createDoc().getStore();
    targetDoc.load();
    const rootId = targetDoc.addBlock("myoxus:page");
    targetDoc.addBlock("myoxus:surface", {}, rootId);
    const noteId = targetDoc.addBlock("myoxus:note", {}, rootId);
    await insertFromMarkdown(host, content, targetDoc, noteId, 0);

    const gfx = host.std.get(GfxControllerIdentifier);
    const selected = gfx.selection.selectedElements;
    const cardWidth = 364;
    const cardHeight = 390;
    let x = 0;
    let y = 0;

    if (selected.length > 0) {
      const bound = getCommonBoundWithRotation(
        selected.map((el) => Bound.deserialize(el.xywh)),
      );
      x = bound.x;
      y = bound.y + bound.h + 100;
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const center = resolveViewportCenter(mode, host.std);
      x = center.x - cardWidth / 2;
      y = center.y - cardHeight / 2;
    }

    host.std.get(EdgelessCRUDIdentifier).addBlock(
      "myoxus:embed-linked-doc",
      {
        xywh: `[${x}, ${y}, ${cardWidth}, ${cardHeight}]`,
        style: "vertical",
        pageId: targetDoc.id,
      },
      surface.id,
    );
    return true;
  },
};

export const PageEditorActions = [PAGE_INSERT, SAVE_AS_DOC, SAVE_AS_BLOCK];

export const EdgelessEditorActions = [
  EDGELESS_INSERT,
  ADD_TO_EDGELESS_AS_NOTE,
  SAVE_AS_DOC,
  SAVE_AS_BLOCK,
];

export const ChatBlockPeekViewActions = [
  ADD_TO_EDGELESS_AS_NOTE,
  CREATE_AS_LINKED_DOC,
];
