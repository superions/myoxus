// SPDX-License-Identifier: MIT

import { getStoreManager } from "@myoxus/core/editor/manager/store";
import { getMyoxusWorkspaceSchema } from "@myoxus/core/modules/workspace";
import { PageIcon, ToolIcon as NativeToolIcon } from "@myoxus/icons/react";
import {
  DocEmbedProvider,
  type NotificationService,
} from "@virgultum/core/services";
import { RefNodeSlotsProvider } from "@virgultum/editor/inlines/reference";
import type { BlockStdScope } from "@virgultum/editor/std";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";
import { useCallback, useEffect, useId, useRef } from "react";

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
  readOnly = false,
  notificationService,
}: {
  data: DocComposeToolCall | DocComposeToolResult;
  std?: BlockStdScope;
  readOnly?: boolean;
  notificationService?: NotificationService;
}) {
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
          name: "Doc compose failed",
          icon: <NativeToolIcon />,
        })
      : null;

    const content = errorView ? (
      errorView
    ) : isLoading ? (
      <ArtifactSkeleton icon={<PageIcon />} />
    ) : successResult ? (
      <StoredAnswerText host={std?.host} text={successResult.markdown} />
    ) : null;

    const controls =
      successResult && std ? (
        <DocComposeControls
          copy={() => {
            void navigator.clipboard
              .writeText(successResult.markdown)
              .then(() => {
                notificationService?.toast("Copied markdown to clipboard");
              })
              .catch(console.error);
          }}
          save={
            readOnly
              ? undefined
              : () => {
                  void (async () => {
                    try {
                      if (!mountedRef.current || readOnly) return;
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
                          title: "Open the doc you just created",
                          message:
                            "Doc saved successfully! Would you like to open it now?",
                          cancelText: "Cancel",
                          confirmText: "Open",
                        });
                        if (open && mountedRef.current) {
                          refNodeSlots?.docLinkClicked.next({
                            pageId: docId,
                            openMode: "open-in-active-view",
                            host: std.host,
                          });
                        }
                      } else {
                        notificationService?.toast("Failed to create document");
                      }
                    } catch (e) {
                      console.error(e);
                      notificationService?.toast("Failed to create document");
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
    preview,
    readOnly,
    std,
    successResult,
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
      name: "Doc compose failed",
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
