// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { DownloadIcon } from "@myoxus/icons/react";
import { Stack } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/core/services";
import type { ImageSelection } from "@virgultum/editor/shared/selection";
import type {
  BlockSelection,
  EditorHost,
  TextSelection,
} from "@virgultum/editor/std";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type { ChatAction } from "../_common/chat-actions-handle";
import { AIProvider } from "../provider";
import { copyText } from "../utils/editor-actions";
import type { CopilotGeneratedFile } from "./ai-chat-messages/type";
import {
  ChatMessageActions,
  type ChatMessageActionOption,
} from "./copy-more-view";
import { GeneratedFilesView } from "./generated-files-view";

interface ResponseActionsProps {
  notificationService: NotificationService;
  host?: EditorHost | null;
  actions?: ChatAction[];
  content?: string;
  messageId?: string;
  sessionId?: string;
  retry?: () => void | Promise<void>;
  generatedFiles?: CopilotGeneratedFile[];
  downloadSavedFile?: (
    file: CopilotGeneratedFile,
    current: () => boolean,
  ) => Promise<void>;
  exportable?: boolean;
}

export function CopilotResponseActions(props: ResponseActionsProps) {
  // Replacing a message resets pending UI and invalidates any unresolved export.
  return (
    <MessageActions
      key={JSON.stringify([props.sessionId, props.messageId])}
      {...props}
    />
  );
}

function MessageActions({
  notificationService,
  host,
  actions = [],
  content = "",
  messageId,
  sessionId,
  retry,
  generatedFiles = [],
  downloadSavedFile,
  exportable,
}: ResponseActionsProps) {
  const t = useI18n();
  const readonly = host?.std.store.readonly$;
  useSyncExternalStore(
    useCallback(
      (update: () => void) => readonly?.subscribe(update) ?? (() => {}),
      [readonly],
    ),
    () => readonly?.value ?? false,
  );
  const [exported, setExported] = useState<CopilotGeneratedFile[]>([]);
  const [fileStatus, setFileStatus] = useState<"idle" | "pending" | "failed">(
    "idle",
  );
  const fileOperation = useRef<symbol | null>(null);
  useLayoutEffect(
    () => () => {
      fileOperation.current = null;
    },
    [],
  );

  async function runFileAction(
    action: (current: () => boolean) => Promise<void>,
  ) {
    if (fileOperation.current) return;
    const operation = Symbol();
    fileOperation.current = operation;
    const current = () => fileOperation.current === operation;
    setFileStatus("pending");
    try {
      await action(current);
      if (current()) setFileStatus("idle");
    } catch {
      if (current()) setFileStatus("failed");
    } finally {
      if (current()) fileOperation.current = null;
    }
  }

  const notifySuccess = (title: string) =>
    notificationService.notify({ title, accent: "success", onClose: () => {} });
  const options: ChatMessageActionOption[] = host
    ? actions
        .filter((action) => action.showWhen(host))
        .map((action, index) => ({
          id: String(index),
          label: action.title,
          icon: action.icon,
          run: async () => {
            const selection = host.selection.value;
            const success = await action.handler(
              host,
              content,
              {
                text: selection.find((value) => value.type === "text") as
                  TextSelection | undefined,
                blocks: selection.filter(
                  (value) => value.type === "block",
                ) as BlockSelection[],
                images: selection.filter(
                  (value) => value.type === "image",
                ) as ImageSelection[],
              },
              sessionId,
              messageId,
            );
            if (success) notifySuccess(action.toast);
          },
        }))
    : [];
  if (exportable && messageId && AIProvider.session?.exportMessage) {
    for (const [format, label] of [
      ["pdf", t["com.myoxus.export.pdf.menu-label"]()],
      ["html", t["Export to HTML"]()],
    ] as const) {
      options.push({
        id: `export-${format}`,
        label,
        icon: <DownloadIcon />,
        run: async () => {
          const { exportMessage, downloadGeneratedFile } =
            AIProvider.session ?? {};
          if (!exportMessage || !downloadGeneratedFile) return;
          await runFileAction(async (current) => {
            const file = await exportMessage(messageId, format);
            if (!current()) return;
            setExported((files) => [
              ...files.filter((value) => value.id !== file.id),
              file,
            ]);
            await downloadGeneratedFile(file);
          });
        },
      });
    }
  }

  const files = [
    ...new Map(
      [...generatedFiles, ...exported].map((file) => [file.id, file]),
    ).values(),
  ];
  return (
    <Stack data-testid="chat-actions">
      <ChatMessageActions
        copy={
          content
            ? async () => {
                if (await copyText(content))
                  notifySuccess(t["Copied to clipboard"]());
              }
            : undefined
        }
        retry={retry}
        actions={options}
        onFailure={() =>
          notificationService.toast(t["com.myoxus.ai.chat-panel.error"]())
        }
      />
      {files.length || fileStatus !== "idle" ? (
        <GeneratedFilesView
          files={files}
          pending={fileStatus === "pending"}
          failed={fileStatus === "failed"}
          download={(file) => {
            void runFileAction((current) => {
              if (downloadSavedFile) return downloadSavedFile(file, current);
              const download = AIProvider.session?.downloadGeneratedFile;
              if (!download)
                return Promise.reject(
                  new Error("Saved file transport unavailable"),
                );
              return download(file);
            });
          }}
        />
      ) : null}
    </Stack>
  );
}
