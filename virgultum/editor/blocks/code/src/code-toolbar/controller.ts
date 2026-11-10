// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { computed, signal } from "@preact/signals-core";
import { getMoreMenuConfig } from "@virgultum/components/toolbar";
import type { MyoxusIconExportName } from "@myoxus/icons/names";
import {
  CommentProviderIdentifier,
  DocModeProvider,
  EditorI18nProvider,
  TelemetryProvider,
  editorMessage,
  resolveEditorMessage,
  type EditorCodeToolbarControls,
  type EditorCodeToolbarState,
  type EditorI18nMessage,
  type SelectionAction,
} from "@virgultum/shared/services";
import { BlockSelection } from "@virgultum/std";
import { isInsidePageEditor } from "@virgultum/shared/utils";
import { CodeBlockConfigExtension } from "../code-block-config";
import { CodeBlockPreviewIdentifier } from "../code-preview-extension";
import type { CodeBlockToolbarContext } from "./context";
import { duplicateCodeBlock } from "./utils";

export type CodeToolbarActions = (
  context: CodeBlockToolbarContext,
) => SelectionAction[];
const preferenceKey = "virgultum:code-block:lang-list";

/** A hover session owns commands; cached preferences never replace the language registry. */
export function createCodeToolbarControls(
  context: CodeBlockToolbarContext,
  extraActions: () => readonly CodeToolbarActions[],
): EditorCodeToolbarControls {
  const block = context.blockComponent;
  const { model, store, std } = block;
  const recent = signal<string[]>([]);
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(preferenceKey) ?? "[]",
    );
    if (Array.isArray(saved))
      recent.value = saved.flatMap((item) =>
        typeof item?.name === "string" ? [item.name] : [],
      );
  } catch {
    /* A preference is optional; the configured registry remains authoritative. */
  }
  const alive = () =>
    !context.abortController.signal.aborted &&
    block.isConnected &&
    store.getBlock(model.id)?.model === model;
  const writable = () => alive() && !store.readonly;
  const guarded =
    (run: () => void, write = true) =>
    () => {
      if (write ? writable() : alive()) run();
    };
  const text = (message: EditorI18nMessage) =>
    resolveEditorMessage(
      message,
      std.getOptional(EditorI18nProvider) ?? undefined,
    );
  const action = (
    id: string,
    message: EditorI18nMessage,
    icon: MyoxusIconExportName,
    run: () => void,
    active?: boolean,
  ): SelectionAction => ({
    id,
    label: text(message),
    icon,
    disabled: false,
    active,
    run: guarded(run),
  });
  const track = (
    event: "codeBlockLanguageSelect" | "htmlBlockTogglePreview",
    control: string,
  ) =>
    std.getOptional(TelemetryProvider)?.track(event, {
      page: std.getOptional(DocModeProvider)?.getEditorMode() ?? "page",
      segment: "code block",
      module:
        event === "codeBlockLanguageSelect"
          ? "language selector"
          : "code toolbar container",
      control,
    });
  const snapshot = computed<EditorCodeToolbarState>(() => {
    const readonly = store.readonly;
    const copy = action(
      "copy-code",
      editorMessage("com.myoxus.editor.toolbar.copy-code", "Copy code"),
      "CopyIcon",
      () => block.copyCode(),
    );
    copy.run = guarded(() => block.copyCode(), false);
    const primary: SelectionAction[] = [];
    if (
      std.getOptional(CodeBlockPreviewIdentifier(model.props.language ?? ""))
    ) {
      const preview = action(
        "preview",
        editorMessage("com.myoxus.editor.toolbar.preview", "Preview"),
        "PresentationIcon",
        () => {},
        block.preview$.value,
      );
      preview.run = guarded(() => {
        block.setPreviewState(!block.preview$.value);
        track("htmlBlockTogglePreview", "preview toggle button");
      }, false);
      primary.push(preview);
    }
    if (!readonly)
      primary.push(
        ...extraActions()
          .flatMap((factory) => factory(context))
          .map((item) => protect(item, true)),
      );
    primary.push(copy);
    if (!readonly)
      primary.push(
        action(
          "caption",
          editorMessage("com.myoxus.editor.toolbar.caption", "Caption"),
          "CaptionIcon",
          () => block.captionEditor?.show(),
        ),
      );
    if (std.getOptional(CommentProviderIdentifier)) {
      const comment = action(
        "comment",
        editorMessage("com.myoxus.editor.toolbar.comment", "Comment"),
        "CommentIcon",
        () => {},
      );
      comment.run = guarded(
        () =>
          std
            .getOptional(CommentProviderIdentifier)
            ?.addComment([new BlockSelection({ blockId: model.id })]),
        false,
      );
      primary.push(comment);
    }
    const more: SelectionAction[] = [];
    if (!readonly) {
      more.push(
        action(
          "wrap",
          editorMessage("com.myoxus.editor.code.wrap", "Wrap lines"),
          "TextIcon",
          () => block.setWrap(!model.props.wrap),
          model.props.wrap,
        ),
      );
      if (
        std.getOptional(CodeBlockConfigExtension.identifier)?.showLineNumbers ??
        true
      )
        more.push(
          action(
            "line-number",
            editorMessage(
              "com.myoxus.editor.code.line-numbers",
              "Line numbers",
            ),
            "NumberedListIcon",
            () =>
              store.updateBlock(model, {
                lineNumber: !(model.props.lineNumber ?? true),
              }),
            model.props.lineNumber ?? true,
          ),
        );
    }
    more.push(
      ...getMoreMenuConfig(std)
        .actions(context)
        .map((item) => protect(item)),
    );
    if (!readonly)
      more.push(
        action(
          "duplicate",
          editorMessage("com.myoxus.editor.keyboard.duplicate", "Duplicate"),
          "DuplicateIcon",
          () => {
            const id = duplicateCodeBlock(model);
            void context.host.updateComplete
              .then(() => {
                if (
                  !block.isConnected ||
                  store.getBlock(id)?.model === undefined
                )
                  return;
                context.host.selection.setGroup("note", [
                  new BlockSelection({ blockId: id }),
                ]);
                if (isInsidePageEditor(context.host))
                  context.host.view
                    .getBlock(id)
                    ?.scrollIntoView({ block: "nearest" });
              })
              .catch(console.error);
            context.close();
          },
        ),
        {
          ...action(
            "delete",
            editorMessage("Delete", "Delete"),
            "DeleteIcon",
            () => {
              store.deleteBlock(model);
              context.close();
            },
          ),
          variant: "destructive",
        },
      );
    const rank = (id: string) => {
      if (id === model.props.language) return -1;
      const index = recent.value.indexOf(id);
      return index < 0 ? Infinity : index;
    };
    return {
      language: model.props.language ?? "",
      languageName: block.languageName$.value,
      languages: block.langs
        .map((lang) => ({
          value: lang.id,
          label: lang.name,
          aliases: lang.aliases,
        }))
        .sort(
          (a, b) =>
            rank(a.value) - rank(b.value) || a.label.localeCompare(b.label),
        ),
      readonly,
      primary,
      more,
    };
  });
  function protect(item: SelectionAction, write = false): SelectionAction {
    return {
      ...item,
      actions: item.actions?.map((child) => protect(child, write)),
      control:
        item.control?.type === "menu"
          ? {
              ...item.control,
              items: item.control.items.map((child) => protect(child, write)),
            }
          : item.control,
      run: item.run
        ? (anchor, event) => {
            if (write ? writable() : alive()) item.run!(anchor, event);
          }
        : undefined,
    };
  }
  return {
    getSnapshot: () => snapshot.value,
    subscribe: (listener) => snapshot.subscribe(listener),
    setActive: context.setActive,
    chooseLanguage: (language) => {
      if (!writable() || !block.langs.some((lang) => lang.id === language))
        return;
      store.transact(() => {
        model.props.language = language;
      });
      recent.value = [
        language,
        ...recent.value.filter((id) => id !== language),
      ];
      try {
        // Keep the deployed preference format usable by already-open clients.
        localStorage.setItem(
          preferenceKey,
          JSON.stringify(
            snapshot.value.languages.map(({ value, label, aliases }) => ({
              name: value,
              label,
              aliases,
            })),
          ),
        );
      } catch {
        /* Storage may be disabled. */
      }
      track("codeBlockLanguageSelect", language);
    },
  };
}
