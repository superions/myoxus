// SPDX-License-Identifier: MIT

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { PageIcon, ToolIcon as NativeToolIcon } from "@myoxus/icons/react";
import {
  DocEmbedProvider,
  type NotificationService,
} from "@virgultum/core/services";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import type { BlockStdScope } from "@virgultum/editor/std";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
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
    | {
        title: string;
        markdown: string;
        wordCount: number;
      }
    | ToolError
    | null;
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
  const initialPreviewPendingRef = useRef(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isError =
    data.type === "tool-result" &&
    !!data.result &&
    typeof data.result === "object" &&
    "type" in data.result &&
    data.result.type === "error";
  const isLoading = data.type !== "tool-result";
  const successResult =
    data.type === "tool-result" &&
    data.result &&
    typeof data.result === "object" &&
    "markdown" in data.result
      ? data.result
      : null;

  const openOrUpdatePreview = useCallback(() => {
    if (!preview) return;
    initialPreviewPendingRef.current = false;

    const errorView = isError
      ? toolFailedCard({
          name: t["com.myoxus.ai.chat-panel.doc-compose-failed"](),
          icon: <NativeToolIcon />,
        })
      : null;

    const content = errorView ? (
      errorView
    ) : isLoading ? (
      <ArtifactSkeleton icon={<PageIcon />} />
    ) : successResult ? (
      <StoredAnswerText
        host={std?.host}
        pageBridge={pageBridge}
        text={successResult.markdown}
      />
    ) : null;

    const controls =
      successResult && (std || pageBridge) ? (
        <DocComposeControls
          copyText={successResult.markdown}
          onCopied={() => {
            notificationService?.toast(t["Copied to clipboard"]());
          }}
          save={
            readOnly
              ? undefined
              : () => {
                  void (async () => {
                    try {
                      if (!mountedRef.current || readOnly) return;
                      if (!std && pageBridge) {
                        const saved = await pageBridge.saveAsDoc(
                          successResult.markdown,
                          data.args.title,
                        );
                        if (!saved && mountedRef.current) {
                          notificationService?.toast(
                            t["com.myoxus.ai.chat-panel.doc-create-failed"](),
                          );
                        }
                        return;
                      }
                      if (!std) return;
                      const workspace = std.store.workspace;
                      const refNodeSlots =
                        std.getOptional(RefNodeSlotsProvider);
                      const { docId } =
                        await MarkdownTransformer.importMarkdownToDoc({
                          collection: workspace,
                          schema: getMyoxusWorkspaceSchema(),
                          markdown: successResult.markdown,
                          fileName: data.args.title,
                          extensions: getStoreManager()
                            .config.init()
                            .value.get("store"),
                          access:
                            std.getOptional(DocEmbedProvider) ?? undefined,
                        });
                      if (!mountedRef.current) return;
                      if (docId) {
                        const open = await notificationService?.confirm({
                          title:
                            t[
                              "com.myoxus.ai.chat-panel.open-created-doc-title"
                            ](),
                          message:
                            t[
                              "com.myoxus.ai.chat-panel.open-created-doc-message"
                            ](),
                          cancelText: t["Cancel"](),
                          confirmText:
                            t["com.myoxus.ai.chat-panel.open-action"](),
                        });
                        if (open && mountedRef.current) {
                          refNodeSlots?.docLinkClicked.next({
                            pageId: docId,
                            openMode: "open-in-active-view",
                            host: std.host,
                          });
                        }
                      } else {
                        notificationService?.toast(
                          t["com.myoxus.ai.chat-panel.doc-create-failed"](),
                        );
                      }
                    } catch (e) {
                      console.error(e);
                      notificationService?.toast(
                        t["com.myoxus.ai.chat-panel.doc-create-failed"](),
                      );
                    }
                  })();
                }
          }
        />
      ) : undefined;

    preview.openPreview(ownerId, {
      title: data.args.title,
      icon: <PageIcon />,
      content,
      controls,
    });
  }, [
    data.args.title,
    isError,
    isLoading,
    notificationService,
    ownerId,
    pageBridge,
    preview,
    readOnly,
    std,
    successResult,
    t,
  ]);

  useEffect(() => {
    if (!preview) return;
    if (initialPreviewPendingRef.current || preview.isOwnerOpen(ownerId)) {
      openOrUpdatePreview();
    }
  }, [openOrUpdatePreview, ownerId, preview]);

  useEffect(() => {
    return () => {
      preview?.closePreview(ownerId);
    };
  }, [ownerId, preview]);

  if (isError) {
    return toolFailedCard({
      name: t["com.myoxus.ai.chat-panel.doc-compose-failed"](),
      icon: <NativeToolIcon />,
    });
  }

  return (
    <ArtifactCardView
      title={data.args.title}
      icon={<PageIcon />}
      loading={isLoading}
      open={preview ? openOrUpdatePreview : undefined}
    />
  );
}
