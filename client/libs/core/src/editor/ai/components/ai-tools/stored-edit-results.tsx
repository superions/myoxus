// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useSignalValue } from "@myoxus/core/modules/doc-info/utils";
import { useI18n } from "@myoxus/i18n";
import {
  CopyIcon,
  ExpandCloseIcon,
  ExpandFullIcon,
  InsertBleowIcon,
  LinkedPageIcon,
} from "@myoxus/icons/react";
import track from "@myoxus/track";
import { Group, IconButton, Notice, Stack } from "@myoxus/ui-facade";
import type { NotificationService } from "@virgultum/core/services";
import { isInsidePageEditor } from "@virgultum/core/utils";
import type {
  BlockSelection,
  EditorHost,
  TextSelection,
} from "@virgultum/editor/std";
import {
  Fragment,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { PageAiBridge } from "../../../virgultum/doc-editor/page-ai-bridge";
import { diffMarkdown } from "../../utils/apply-model/markdown-diff";
import { copyText } from "../../utils/editor-actions";
import { DocEditResultView } from "./doc-edit-result-view";
import { SectionEditResultView } from "./section-edit-result-view";

type EditView = {
  host?: EditorHost | null;
  pageBridge?: PageAiBridge | null;
  notificationService?: NotificationService;
  readOnly?: boolean;
  renderRichText: (text: string) => ReactNode;
};

function notify(
  service: NotificationService | undefined,
  title: string,
  accent: "success" | "error",
  message?: string,
) {
  service?.notify({ title, accent, message, onClose: () => {} });
}

async function copy(service: NotificationService | undefined, value: string) {
  if (await copyText(value)) notify(service, "Copied to clipboard", "success");
}

export function StoredSectionEdit({
  host,
  pageBridge,
  notificationService,
  readOnly,
  content,
  renderRichText,
}: EditView & { content: string }) {
  const t = useI18n();
  const activeStore = host?.store ?? pageBridge?.store;
  const storeReadOnly = useSignalValue(activeStore?.readonly$);
  const editable = !!(host || pageBridge) && !readOnly && !storeReadOnly;
  const lifetime = useRef(0);
  useLayoutEffect(
    () => () => {
      lifetime.current++;
    },
    [host, pageBridge, readOnly, storeReadOnly],
  );
  const insert = async () => {
    const owner = lifetime.current;
    if (readOnly || activeStore?.readonly) return;
    if (!host && pageBridge) {
      await pageBridge.insertMarkdown(content);
      return;
    }
    const { PAGE_INSERT, EDGELESS_INSERT } =
      await import("../../_common/chat-actions-handle");
    if (!host || readOnly || host.store.readonly || owner !== lifetime.current)
      return;
    const current = host.selection.value;
    const action = isInsidePageEditor(host) ? PAGE_INSERT : EDGELESS_INSERT;
    await action.handler(host, content, {
      text: current.find((v): v is TextSelection => v.type === "text"),
      blocks: current.filter((v): v is BlockSelection => v.type === "block"),
    });
  };
  const save = async () => {
    const owner = lifetime.current;
    if (readOnly || activeStore?.readonly) return;
    if (!host && pageBridge) {
      await pageBridge.saveAsDoc(content);
      return;
    }
    const { SAVE_AS_DOC } = await import("../../_common/chat-actions-handle");
    if (host && !readOnly && !host.store.readonly && owner === lifetime.current)
      await SAVE_AS_DOC.handler(host, content);
  };
  const actions = (
    <Group>
      <IconButton
        aria-label={t.Copy()}
        tooltip={t.Copy()}
        onClick={() => void copy(notificationService, content)}
      >
        <CopyIcon />
      </IconButton>
      {editable && (
        <>
          <IconButton
            aria-label={t["com.myoxus.common.insert"]()}
            tooltip={t["com.myoxus.common.insert"]()}
            onClick={() => void insert()}
          >
            <InsertBleowIcon />
          </IconButton>
          <IconButton
            aria-label={t["com.myoxus.ai.chat-panel.save-as-doc"]()}
            tooltip={t["com.myoxus.ai.chat-panel.save-as-doc"]()}
            onClick={() => void save()}
          >
            <LinkedPageIcon />
          </IconButton>
        </>
      )}
    </Group>
  );
  return (
    <SectionEditResultView actions={actions}>
      {renderRichText(content)}
    </SectionEditResultView>
  );
}

interface SavedChange {
  op: string;
  updates: string;
  originalContent: string;
  changedContent: string;
}

function isSavedChange(value: unknown): value is SavedChange {
  return (
    !!value &&
    typeof value === "object" &&
    ["op", "updates", "originalContent", "changedContent"].every(
      (key) => typeof (value as Record<string, unknown>)[key] === "string",
    )
  );
}

const stripComments = (source: string) =>
  source.replace(/<!--[\s\S]*?-->/g, "");

function Changes({
  change,
  renderRichText,
}: {
  change: SavedChange;
  renderRichText: EditView["renderRichText"];
}) {
  const { patches, oldBlocks } = diffMarkdown(
    change.originalContent,
    change.changedContent,
  );
  const original = new Map(oldBlocks.map((block) => [block.id, block.content]));
  return (
    <Stack gap="sm">
      {patches.map((patch) => {
        if (patch.op === "insert")
          return (
            <Notice key={patch.block.id} title="Inserted" tone="info">
              {renderRichText(stripComments(patch.block.content))}
            </Notice>
          );
        return (
          <Fragment key={patch.id}>
            <Notice
              title={patch.op === "delete" ? "Deleted" : "Original"}
              tone="error"
            >
              {renderRichText(stripComments(original.get(patch.id) ?? ""))}
            </Notice>
            {patch.op === "replace" && (
              <Notice title="Modified" tone="info">
                {renderRichText(stripComments(patch.content))}
              </Notice>
            )}
          </Fragment>
        );
      })}
    </Stack>
  );
}

type EditAction = "apply" | "accept" | "reject";

function SavedOperation({
  change,
  host,
  pageBridge,
  notificationService,
  readOnly,
  docId,
  instruction,
  collapsed,
  toggle,
  renderRichText,
}: EditView & {
  change: SavedChange;
  docId: string;
  instruction: string;
  collapsed: boolean;
  toggle: () => void;
}) {
  const t = useI18n();
  const activeStore = host?.store ?? pageBridge?.store;
  const readonlyStore = useSignalValue(activeStore?.readonly$);
  const editable = !!(host || pageBridge) && !readOnly && !readonlyStore;
  const [busy, setBusy] = useState<EditAction | null>(null);
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    setBusy(null);
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [host, pageBridge, docId, readOnly, readonlyStore]);
  const run = async (action: EditAction) => {
    if (
      (!host && !pageBridge) ||
      active.current ||
      activeStore?.readonly ||
      readOnly
    )
      return;
    const task = new AbortController();
    active.current = task;
    setBusy(action);
    // A reopened or revoked Peek must never receive an older async edit.
    const current = () => !task.signal.aborted && !activeStore?.readonly;
    try {
      if (!host && pageBridge) {
        const event = { instruction, operation: change.op };
        if (action === "reject") {
          track.applyModel.chat.$.reject(event);
          return;
        }
        track.applyModel.chat.$[action](event);
        await pageBridge.applyDocUpdate(change.op, change.updates);
        return;
      }
      if (!host) return;
      const { BlockDiffProvider } = await import("../../services/block-diff");
      if (!current()) return;
      const service = host.std.getOptional(BlockDiffProvider);
      const event = { instruction, operation: change.op };
      if (action === "reject") {
        track.applyModel.chat.$.reject(event);
        service?.setChangedMarkdown(null);
        service?.rejectAll();
        return;
      }
      const { AIProvider } = await import("../../provider");
      if (!current()) return;
      const markdown = await AIProvider.context?.applyDocUpdates(
        host.std.workspace.id,
        docId,
        change.op,
        change.updates,
      );
      if (!markdown || !current()) return;
      track.applyModel.chat.$[action](event);
      await service?.apply(host.store, markdown);
      if (action === "accept" && current())
        await service?.acceptAll(host.store);
    } catch (error) {
      if (current())
        notify(
          notificationService,
          "Failed to apply updates",
          "error",
          error instanceof Error ? error.message : "Unknown error",
        );
    } finally {
      if (active.current === task) {
        active.current = null;
        setBusy(null);
      }
    }
  };
  const label = collapsed ? t.Expand() : t.Collapse();
  const copyChange = () => {
    if (!host && !pageBridge) return;
    track.applyModel.chat.$.copy();
    void copy(notificationService, stripComments(change.changedContent));
  };
  return (
    <DocEditResultView
      docId={docId}
      operation={change.op}
      collapsed={collapsed}
      applying={busy === "apply"}
      accepting={busy === "accept"}
      apply={editable ? () => void run("apply") : undefined}
      accept={editable ? () => void run("accept") : undefined}
      reject={editable ? () => void run("reject") : undefined}
      actions={
        <Group>
          <IconButton aria-label={label} tooltip={label} onClick={toggle}>
            {collapsed ? <ExpandFullIcon /> : <ExpandCloseIcon />}
          </IconButton>
          <IconButton
            aria-label={t.Copy()}
            tooltip={t.Copy()}
            onClick={copyChange}
          >
            <CopyIcon />
          </IconButton>
        </Group>
      }
    >
      <Changes change={change} renderRichText={renderRichText} />
    </DocEditResultView>
  );
}

export function StoredDocumentEdit({
  changes,
  ...props
}: EditView & { changes: unknown[]; docId: string; instruction: string }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <>
      {changes.filter(isSavedChange).map((change) => (
        <SavedOperation
          {...props}
          key={change.op}
          change={change}
          collapsed={collapsed}
          toggle={() => setCollapsed((value) => !value)}
        />
      ))}
    </>
  );
}
