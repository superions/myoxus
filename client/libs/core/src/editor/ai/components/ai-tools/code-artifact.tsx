// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { useI18n } from "@myoxus/i18n";
import { CodeBlockIcon, ToolIcon } from "@myoxus/icons/react";
import { Box } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/core/services";
import type { BlockStdScope } from "@virgultum/editor/std";
import {
  type BlockSnapshot,
  nanoid,
  type SliceSnapshot,
  Text,
} from "@virgultum/editor/store";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { HtmlCodePreview } from "../../../view-extensions/code-block-preview/html-preview";
import { ArtifactSkeleton } from "../ai-artifact-skeleton";
import { HighlightedCode } from "../ai-message-content/stored-answer-text";
import { ArtifactCardView, CodeArtifactControls } from "./artifact-view";
import { useChatPreview } from "./preview-context";
import { toolFailedCard } from "./tool-cards";
import type { ToolError } from "./type";

export interface CodeArtifactToolCall {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: { title: string };
}

export interface CodeArtifactToolResult {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  args: { title: string };
  result: { title: string; html: string; size: number } | ToolError | null;
}

function isToolError(value: unknown): value is ToolError {
  return (
    !!value &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type?: unknown }).type === "error"
  );
}

function buildHtmlCodeSlice(html: string): SliceSnapshot {
  const codeBlock: BlockSnapshot = {
    type: "block",
    id: nanoid(),
    flavour: "myoxus:code",
    version: 1,
    props: {
      language: "html",
      wrap: false,
      caption: "",
      text: {
        "$virgultum:internal:text$": true,
        delta: [{ insert: html }],
      },
    },
    children: [],
  };
  return {
    type: "slice",
    content: [codeBlock],
    workspaceId: "fake-workspace-id",
    pageId: "fake-page-id",
  };
}

function downloadHtmlFile(title: string, html: string) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title || "artifact"}.html`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function CodeArtifactTool({
  data,
  std,
  independentMode,
  notificationService,
}: {
  data: CodeArtifactToolCall | CodeArtifactToolResult;
  std?: BlockStdScope;
  independentMode?: boolean;
  notificationService?: NotificationService;
}) {
  const t = useI18n();
  const ownerId = useId();
  const preview = useChatPreview();
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const hasAutoOpenedRef = useRef(false);
  const storeReadonly = useSignalValue(std?.store.readonly$) ?? false;

  const isLoading = data.type !== "tool-result";
  const isError = data.type === "tool-result" && isToolError(data.result);
  const htmlResult =
    data.type === "tool-result" &&
    data.result &&
    typeof data.result === "object" &&
    "html" in data.result
      ? data.result
      : null;

  const syncPreview = useCallback(() => {
    if (!preview) return;
    hasAutoOpenedRef.current = true;

    const content = isError ? (
      toolFailedCard({
        name: t["com.myoxus.ai.chat-panel.code-artifact-failed"](),
        icon: <ToolIcon />,
      })
    ) : isLoading ? (
      <ArtifactSkeleton icon={<CodeBlockIcon />} />
    ) : htmlResult ? (
      <Box h="100%" w="100%" display="flex" style={{ flexDirection: "column" }}>
        {mode === "preview" ? (
          <HtmlCodePreview source={htmlResult.html} />
        ) : (
          <HighlightedCode
            source={htmlResult.html}
            language="html"
            showLineNumbers
          />
        )}
      </Box>
    ) : null;

    const controls =
      htmlResult && std ? (
        <CodeArtifactControls
          mode={mode}
          setMode={setMode}
          copy={() =>
            std.clipboard
              .writeToClipboard((items) => ({
                ...items,
                "text/plain": htmlResult.html,
                "text/html": htmlResult.html,
                "VIRGULTUM/SNAPSHOT": JSON.stringify({
                  snapshot: buildHtmlCodeSlice(htmlResult.html),
                  blobs: {},
                }),
              }))
              .then(() => {
                notificationService?.toast(t["Copied to clipboard"]());
                return true;
              })
              .catch((error) => {
                console.error(error);
                return false;
              })
          }
          download={() => {
            try {
              downloadHtmlFile(htmlResult.title, htmlResult.html);
            } catch (error) {
              console.error(error);
            }
          }}
          insert={
            independentMode || storeReadonly
              ? undefined
              : () => {
                  try {
                    const { store } = std;
                    if (independentMode || store.readonly$.value) return;
                    const notes = store.getBlocksByFlavour("myoxus:note");
                    const parentId = notes[0]?.id ?? store.root?.id;
                    if (!parentId) return;
                    store.addBlock(
                      "myoxus:code",
                      {
                        text: new Text(htmlResult.html),
                        language: "html",
                        preview: true,
                      },
                      parentId,
                    );
                    notificationService?.toast(
                      t["com.myoxus.ai.chat-panel.inserted"](),
                    );
                  } catch (error) {
                    console.error(error);
                  }
                }
          }
        />
      ) : undefined;

    preview.openPreview(ownerId, {
      title: data.args.title,
      icon: <CodeBlockIcon />,
      content,
      controls,
    });
  }, [
    data.args.title,
    htmlResult,
    independentMode,
    isError,
    isLoading,
    mode,
    notificationService,
    ownerId,
    preview,
    std,
    storeReadonly,
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
      name: t["com.myoxus.ai.chat-panel.code-artifact-failed"](),
      icon: <ToolIcon />,
    });
  }

  return (
    <ArtifactCardView
      title={data.args.title}
      icon={<CodeBlockIcon />}
      loading={isLoading}
      open={preview ? syncPreview : undefined}
    />
  );
}
