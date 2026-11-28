// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { PageIcon, ToolIcon } from "@myoxus/icons/react";
import {
  DocEmbedProvider,
  type NotificationService,
} from "@virgultum/core/services";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import type { BlockStdScope } from "@virgultum/editor/std";
import { MarkdownTransformer } from "@virgultum/editor/interchange";
import { useCallback, useEffect, useId, useRef } from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import { ArtifactSkeleton } from "../ai-artifact-skeleton";
import { StoredAnswerText } from "../ai-message-content/stored-answer-text";
import { ArtifactCardView, DocComposeControls } from "./artifact-view";
import { useChatPreview } from "./preview-context";
import { toolFailedCard } from "./tool-cards";
import type { ToolError } from "./type";

export interface DocComposeToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { title: string };
}

export interface DocComposeToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { title: string };
  result:
    { title: string; markdown: string; wordCount: number } | ToolError | null;
}

function isToolError(value: unknown): value is ToolError {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: unknown }).type === "error"
  );
}

export function DocComposeTool({
  data,
  std,
  pageBridge,
  readOnly = false,
  notificationService,
}: {
  data: DocComposeToolCall | DocComposeToolResult;
  std?: BlockStdScope;
  pageBridge?: PageAiBridge | null;
  readOnly?: boolean;
  notificationService?: NotificationService;
}) {
  const t = useI18n();
  const ownerId = useId();
  const preview = useChatPreview();
  const hasAutoOpenedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isLoading = data.type !== "tool-result";
  const isError = data.type === "tool-result" && isToolError(data.result);
  const composed =
    data.type === "tool-result" &&
    data.result &&
    typeof data.result === "object" &&
    "markdown" in data.result
      ? data.result
      : null;

  const saveDocument = useCallback(async () => {
    if (!composed || !mountedRef.current || readOnly) return;
    try {
      if (!std && pageBridge) {
        const ok = await pageBridge.saveAsDoc(
          composed.markdown,
          data.args.title,
        );
        if (!ok && mountedRef.current) {
          notificationService?.toast(
            t["com.myoxus.ai.chat-panel.doc-create-failed"](),
          );
        }
        return;
      }
      if (!std) return;

      const refNodeSlots = std.getOptional(RefNodeSlotsProvider);
      const { docId } = await MarkdownTransformer.importMarkdownToDoc({
        collection: std.store.workspace,
        schema: getMyoxusWorkspaceSchema(),
        markdown: composed.markdown,
        fileName: data.args.title,
        extensions: getStoreManager().config.init().value.get("store"),
        access: std.getOptional(DocEmbedProvider) ?? undefined,
      });
      if (!mountedRef.current) return;
      if (!docId) {
        notificationService?.toast(
          t["com.myoxus.ai.chat-panel.doc-create-failed"](),
        );
        return;
      }

      const openNow = await notificationService?.confirm({
        title: t["com.myoxus.ai.chat-panel.open-created-doc-title"](),
        message: t["com.myoxus.ai.chat-panel.open-created-doc-message"](),
        cancelText: t["Cancel"](),
        confirmText: t["com.myoxus.ai.chat-panel.open-action"](),
      });
      if (openNow && mountedRef.current) {
        refNodeSlots?.docLinkClicked.next({
          pageId: docId,
          openMode: "open-in-active-view",
          host: std.host,
        });
      }
    } catch (error) {
      console.error(error);
      notificationService?.toast(
        t["com.myoxus.ai.chat-panel.doc-create-failed"](),
      );
    }
  }, [
    composed,
    data.args.title,
    notificationService,
    pageBridge,
    readOnly,
    std,
    t,
  ]);

  const syncPreview = useCallback(() => {
    if (!preview) return;
    hasAutoOpenedRef.current = true;

    const content = isError ? (
      toolFailedCard({
        name: t["com.myoxus.ai.chat-panel.doc-compose-failed"](),
        icon: <ToolIcon />,
      })
    ) : isLoading ? (
      <ArtifactSkeleton icon={<PageIcon />} />
    ) : composed ? (
      <StoredAnswerText
        host={std?.host}
        pageBridge={pageBridge}
        text={composed.markdown}
      />
    ) : null;

    const controls =
      composed && (std || pageBridge) ? (
        <DocComposeControls
          copyText={composed.markdown}
          onCopied={() =>
            notificationService?.toast(t["Copied to clipboard"]())
          }
          save={readOnly ? undefined : () => void saveDocument()}
        />
      ) : undefined;

    preview.openPreview(ownerId, {
      title: data.args.title,
      icon: <PageIcon />,
      content,
      controls,
    });
  }, [
    composed,
    data.args.title,
    isError,
    isLoading,
    notificationService,
    ownerId,
    pageBridge,
    preview,
    readOnly,
    saveDocument,
    std,
    t,
  ]);

  useEffect(() => {
    if (!preview) return;
    if (!hasAutoOpenedRef.current || preview.isOwnerOpen(ownerId)) {
      syncPreview();
    }
  }, [ownerId, preview, syncPreview]);

  useEffect(
    () => () => {
      preview?.closePreview(ownerId);
    },
    [ownerId, preview],
  );

  if (isError) {
    return toolFailedCard({
      name: t["com.myoxus.ai.chat-panel.doc-compose-failed"](),
      icon: <ToolIcon />,
    });
  }

  return (
    <ArtifactCardView
      title={data.args.title}
      icon={<PageIcon />}
      loading={isLoading}
      open={preview ? syncPreview : undefined}
    />
  );
}
