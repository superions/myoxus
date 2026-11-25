// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createDatabaseFromTemplateMutation,
  createDatabaseMutation,
  InitialDatabaseViewKind,
  ProjectOptionPreset,
  ProjectStructurePreset,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import { computed, signal } from "@preact/signals-core";
import {
  localFootnoteDefinitions,
  localFootnoteInsertionNote,
  localFootnotePresentation,
} from "@virgultum/core/commands";
import {
  defaultDocumentIndexProps,
  type DocumentIndexProps,
  type FootnotePlacement,
} from "@virgultum/core/models";
import {
  DefaultEditorI18nService,
  type EditorSlashControls,
  type EditorSlashState,
} from "@virgultum/core/services";
import { Text, type BlockModel, type Store } from "@virgultum/core/store";
import {
  isValidUrl,
  normalizeUrl,
  openSingleFileWith,
  readImageSize,
} from "@virgultum/core/utils";
import {
  loomUrlRegex,
  parseGitForgeUrl,
  youtubeUrlRegex,
} from "@virgultum/embeds/provider-data";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import { canUseServerBackedDatabases } from "../../../modules/database/availability";
import { getPrimaryView } from "../../../modules/database/model";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { DocsService } from "../../../modules/doc";
import { FeatureFlagService } from "../../../modules/feature-flag";
import { GraphQLService } from "../../../modules/server/services/graphql";
import { useBuildingBlockPicker } from "../../../modules/template-doc/view/building-block-picker";
import { ViewService } from "../../../modules/workbench";
import { WorkspaceService } from "../../../modules/workspace";
import { DatabasePagesService } from "../../../modules/workspace-pages/database-pages-service";
import { Configuration as DocumentIndexConfiguration } from "../../view-extensions/editor-view/document-index";
import { EditorEmbedCardCreate } from "../../view-extensions/editor-view/editor-chrome/embed-card-create";
import { EditorLinkEditor } from "../../view-extensions/editor-view/editor-chrome/link-editor";
import { EditorSlashMenu } from "../../view-extensions/editor-view/editor-chrome/slash-menu";
import { attachmentFileLimit } from "../../view-extensions/editor-view/file-size-limit";
import { FootnoteInsertion } from "../../view-extensions/editor-view/footnote";
import { configureEditorI18n } from "../editor-i18n";
import { capturePageBuildingBlockTarget } from "./building-block-target";
import { bindFloatingAnchor } from "./page-floating-anchor";
import type { PageInteraction, PickerStart } from "./page-interaction";
import {
  buildPageSlashItems,
  filterPageSlashItems,
  resolveInsertParent,
  toEditorSlashOption,
  type PageSlashEmbedKind,
  type PageSlashEntry,
} from "./page-slash-registry";
import { useTemplateVariablePicker } from "./template-variable-picker";

type SlashSubmenuFrame = {
  readonly heading: string;
  readonly items: readonly PageSlashEntry[];
  readonly returnTo: string;
};

type ActiveSlashModal =
  | {
      kind: "embed";
      embedKind: PageSlashEmbedKind;
      model: BlockModel;
      offset: number;
    }
  | {
      kind: "inline-link";
      model: BlockModel;
      offset: number;
      rect: DOMRect;
    }
  | {
      kind: "directory";
      model: BlockModel;
    }
  | {
      kind: "footnote";
      placement: FootnotePlacement;
      model: BlockModel;
      offset: number;
      rect: DOMRect;
    };

const FIGMA_URL_RE =
  /^https:\/\/(?:[\w.-]+\.)?figma\.com\/(?:file|proto|design|board|deck|slides)\//i;

function isValidEmbedUrl(kind: PageSlashEmbedKind, raw: string): boolean {
  const value = raw.trim();
  if (!isValidUrl(value)) return false;
  switch (kind) {
    case "bookmark":
      return true;
    case "youtube":
      return youtubeUrlRegex.test(value);
    case "loom":
      return loomUrlRegex.test(value);
    case "figma":
      return FIGMA_URL_RE.test(value);
    case "github":
      return Boolean(parseGitForgeUrl(value));
  }
}

function insertLocalFootnoteOnStore(
  store: Store,
  model: BlockModel,
  offset: number,
  placement: FootnotePlacement,
  existingId?: string,
): string | null {
  const note = localFootnoteInsertionNote(store, model);
  if (
    !note ||
    store.readonly ||
    store.getModelById(model.id) !== model ||
    !model.text ||
    offset < 0 ||
    offset > model.text.length
  )
    return null;
  const defs = localFootnoteDefinitions(store);
  const existing = existingId
    ? defs.find((d) => d.id === existingId)
    : undefined;
  let label = existing?.props.label ?? "1";
  if (!existing) {
    const occupied = new Set(defs.map((d) => d.props.label));
    let n = 1;
    while (occupied.has(String(n))) n++;
    label = String(n);
  }
  let defId = existing?.id;
  store.captureSync();
  store.transact(() => {
    if (!defId) {
      defId = store.addBlock(
        "myoxus:footnote-definition",
        { label, placement },
        note,
      );
      store.addBlock("myoxus:paragraph", { text: new Text() }, defId);
    }
    model.text!.insert(" ", offset, {
      footnote: { label, definitionId: defId! },
    });
  });
  store.captureSync();
  return defId ?? null;
}

/** Native AGPL Page Slash menu controller mounting `EditorSlashMenu` directly on `Store`. */
export default function PageSlash({
  owner,
  page,
  start,
  root,
  enableAI,
  close,
}: {
  owner: PageInteraction;
  page: Store;
  start: PickerStart;
  root: HTMLElement;
  enableAI: boolean;
  close: () => void;
}) {
  const t = useI18n();
  const framework = useFramework();
  const workspace = useService(WorkspaceService).workspace;
  const docsService = useService(DocsService);
  const featureFlags = useService(FeatureFlagService);
  const workspaceDialog = useService(WorkspaceDialogService);
  const canUseServerDatabase = canUseServerBackedDatabases(workspace);
  const enableMermaid = Boolean(
    featureFlags.flags.enable_mermaid_block.value ?? true,
  );
  const isTemplateDocument = Boolean(
    docsService.list.doc$(page.id).value?.isTemplate$.value,
  );

  const [controls, setControls] = useState<EditorSlashControls | null>(null);
  const [modal, setModal] = useState<ActiveSlashModal | null>(null);
  const [holdingPicker, setHoldingPicker] = useState(false);

  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
  const {
    openBuildingBlockPicker,
    insertNamedBuildingBlock,
    buildingBlockPicker,
  } = useBuildingBlockPicker();

  const editorI18n = useMemo(
    () => new DefaultEditorI18nService(configureEditorI18n()),
    [],
  );

  const menuClosedRef = useRef(false);
  const hasModalRef = useRef(false);
  hasModalRef.current = Boolean(modal || holdingPicker);

  const finishAll = useCallback(() => {
    setModal(null);
    setHoldingPicker(false);
    close();
  }, [close]);

  const activeRangeRef = useRef<{ model: BlockModel; offset: number } | null>(
    null,
  );
  const caretRectRef = useRef<DOMRect | null>(null);

  const insertBlockAfter = useCallback(
    (model: BlockModel, flavour: string, props: Record<string, unknown>) => {
      if (page.readonly || page.getModelById(model.id) !== model) return null;
      const target = resolveInsertParent(page, model, flavour);
      if (!target) return null;
      let blockId: string | null = null;
      page.captureSync();
      page.transact(() => {
        blockId = page.addBlock(
          flavour,
          props,
          target.parent,
          target.index + 1,
        );
        if (
          blockId &&
          target.anchor === model &&
          model.text?.length === 0 &&
          model.children.length === 0
        ) {
          page.deleteBlock(model);
        }
      });
      page.captureSync();
      return blockId;
    },
    [page],
  );

  const insertServerDatabaseBlock = useCallback(
    (model: BlockModel, databaseId: string, viewId?: string | null) => {
      insertBlockAfter(model, "myoxus:database", {
        serverDatabaseId: databaseId,
        serverViewId: viewId ?? null,
      });
    },
    [insertBlockAfter],
  );

  useLayoutEffect(() => {
    const input = root.querySelector<HTMLElement>("[data-page-body]");
    if (!input) {
      close();
      return;
    }
    menuClosedRef.current = false;
    const stop = new AbortController();
    const state = signal<{
      query: string;
      entries: PageSlashEntry[];
      stack: SlashSubmenuFrame[];
      returnTo?: string;
    }>({
      query: "",
      entries: [],
      stack: [],
    });
    const keys = new Set<(event: KeyboardEvent) => void>();
    let releaseAnchor: (() => void) | undefined;
    let currentQuery: string | undefined;
    let composing = false;

    const getCaretRect = () => {
      const sel = document.getSelection();
      if (sel?.rangeCount) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width || r.height || r.left || r.top) {
          caretRectRef.current = r;
          return r;
        }
      }
      return caretRectRef.current ?? input.getBoundingClientRect();
    };

    const closeMenu = (keepMountedForModal = false) => {
      if (menuClosedRef.current) return;
      menuClosedRef.current = true;
      stop.abort();
      releaseAnchor?.();
      keys.clear();
      setControls(null);
      if (!keepMountedForModal && !hasModalRef.current) close();
    };

    const makeEntries = (model: BlockModel, offset: number) =>
      buildPageSlashItems(t, {
        store: page,
        model,
        offset,
        canUseServerDatabase,
        enableMermaid,
        enableAI,
        isTemplateDocument,
        openLinkPicker: () => owner.openLinkPicker(model.id, offset),
        openInlineLink: () => {
          hasModalRef.current = true;
          setModal({
            kind: "inline-link",
            model,
            offset,
            rect: getCaretRect(),
          });
        },
        openEmbedModal: (embedKind) => {
          hasModalRef.current = true;
          setModal({ kind: "embed", embedKind, model, offset });
        },
        openIframeBlock: () => {
          insertBlockAfter(model, "myoxus:embed-iframe", { url: "" });
        },
        openImageUpload: () => {
          void (async () => {
            const file = await openSingleFileWith("Images");
            if (!file || page.readonly || page.getModelById(model.id) !== model)
              return;
            if (file.size > attachmentFileLimit.maxFileSize) {
              attachmentFileLimit.onOverFileSize();
              return;
            }
            const [imageSize, sourceId] = await Promise.all([
              readImageSize(file),
              page.blobSync.set(file),
            ]);
            insertBlockAfter(model, "myoxus:image", {
              size: file.size,
              sourceId,
              ...imageSize,
            });
          })().catch(console.error);
        },
        openAttachmentUpload: () => {
          void (async () => {
            const file = await openSingleFileWith();
            if (!file || page.readonly || page.getModelById(model.id) !== model)
              return;
            if (file.size > attachmentFileLimit.maxFileSize) {
              attachmentFileLimit.onOverFileSize();
              return;
            }
            const sourceId = await page.blobSync.set(file);
            insertBlockAfter(model, "myoxus:attachment", {
              name: file.name,
              size: file.size,
              type: file.type || "application/octet-stream",
              sourceId,
            });
          })().catch(console.error);
        },
        openEventDialog: () => {
          workspaceDialog.open(
            "event-edit",
            { sourceDocId: page.id },
            (createdEventId) => {
              if (!createdEventId) return;
              insertBlockAfter(model, "myoxus:event", {
                eventId: createdEventId,
                workspaceId: workspace.id,
              });
            },
          );
        },
        openDirectoryModal: () => {
          hasModalRef.current = true;
          setModal({ kind: "directory", model });
        },
        openFootnoteMenu: (placement) => {
          hasModalRef.current = true;
          setModal({
            kind: "footnote",
            placement,
            model,
            offset,
            rect: getCaretRect(),
          });
        },
        openTemplateVariablePicker: () => {
          if (!model.text) return;
          hasModalRef.current = true;
          setHoldingPicker(true);
          let nextCaret = offset;
          openTemplateVariablePicker({
            i18n: editorI18n,
            templateSource: isTemplateDocument,
            canWrite: () =>
              !page.readonly &&
              root.isConnected &&
              page.getModelById(model.id) === model,
            insert: (token) => {
              if (!isTemplateDocument || !model.text) return;
              page.captureSync();
              page.transact(() => model.text!.insert(token, offset));
              nextCaret = offset + token.length;
              page.captureSync();
            },
            insertField: (field) => {
              if (
                (field.type === "input" && !isTemplateDocument) ||
                !model.text
              )
                return;
              page.captureSync();
              page.transact(() =>
                model.text!.insert(" ", offset, { documentField: field }),
              );
              nextCaret = offset + 1;
              page.captureSync();
            },
            onClose: () => {
              if (page.getModelById(model.id))
                owner.focusPoint(model.id, nextCaret);
              finishAll();
            },
          });
        },
        openBuildingBlockPicker: () => {
          try {
            const target = capturePageBuildingBlockTarget(
              page,
              model.id,
              offset,
              root,
              (id, caret) => owner.focusPoint(id, caret ?? 0),
            );
            hasModalRef.current = true;
            setHoldingPicker(true);
            openBuildingBlockPicker(target);
          } catch {
            notify.error({
              title: t["com.myoxus.templates.blocks.insert"](),
              message: t["com.myoxus.templates.blocks.no-body"](),
            });
          }
        },
        insertNamedBuildingBlock: (slug) => {
          try {
            const target = capturePageBuildingBlockTarget(
              page,
              model.id,
              offset,
              root,
              (id, caret) => owner.focusPoint(id, caret ?? 0),
            );
            insertNamedBuildingBlock(target, slug);
          } catch {
            notify.error({
              title: t["com.myoxus.templates.blocks.insert"](),
              message: t["com.myoxus.templates.blocks.no-body"](),
            });
          }
        },
        openTaskCardCreate: () => {
          // Lazily reuse the existing server task-card creation flow on an
          // ephemeral BlockStdScope only when the user invokes this action.
          void (async () => {
            const [{ BlockStdScope }, { openTaskCardCreation }] =
              await Promise.all([
                import("@virgultum/core/runtime"),
                import("../../../modules/database/tasks/create-task-card"),
              ]);
            const std = new BlockStdScope({ store: page, extensions: [] });
            await openTaskCardCreation(framework, { std, model });
            std.unmount();
          })().catch(console.error);
        },
        openEmbedExistingDatabase: () => {
          const returnFocusRef = {
            current: root.querySelector<HTMLElement>("[data-page-body]"),
          };
          workspaceDialog.open(
            "database-selector",
            { init: [], returnFocusRef },
            (result) => {
              if (!result) return;
              insertServerDatabaseBlock(
                model,
                result.databaseId,
                result.viewId,
              );
            },
          );
        },
        createServerTable: () => {
          void (async () => {
            const graphQL = framework.get(GraphQLService);
            const response = await graphQL.gql({
              query: createDatabaseMutation,
              variables: {
                input: {
                  initialViewKind: InitialDatabaseViewKind.Table,
                  title: t["com.myoxus.database.create.table-title"](),
                  workspaceId: workspace.id,
                },
              },
            });
            const record = response.createDatabase;
            framework.get(DatabasePagesService).invalidate();
            const view = getPrimaryView(record);
            insertServerDatabaseBlock(model, record.database.id, view.id);
            notify.success({
              title: t["com.myoxus.database.slash.created"](),
            });
          })().catch((error) => {
            console.error(error);
            notify.error({
              title: t["com.myoxus.database.slash.create-failed"](),
            });
          });
        },
        createServerProject: () => {
          void (async () => {
            const graphQL = framework.get(GraphQLService);
            const response = await graphQL.gql({
              query: createDatabaseFromTemplateMutation,
              variables: {
                input: {
                  complexityPreset: ProjectOptionPreset.ThreeStep,
                  includeSampleRows: false,
                  priorityPreset: ProjectOptionPreset.ThreeStep,
                  structurePreset: ProjectStructurePreset.Phases,
                  templateId: "myoxus.project.simple_project",
                  title: t["com.myoxus.database.create.project-title"](),
                  workspaceId: workspace.id,
                },
              },
            });
            const record = response.createDatabaseFromTemplate;
            framework.get(DatabasePagesService).invalidate();
            const view = getPrimaryView(record);
            insertServerDatabaseBlock(model, record.database.id, view.id);
            notify.success({
              title: t["com.myoxus.database.slash.created"](),
            });
          })().catch((error) => {
            console.error(error);
            notify.error({
              title: t["com.myoxus.database.slash.create-failed"](),
            });
          });
        },
        insertMermaidDiagram: (templateId, label) => {
          void (async () => {
            const { MERMAID_PRODUCT_TEMPLATES, createMermaidBlockInsertProps } =
              await import("@virgultum/block-mermaid");
            if (page.readonly || page.getModelById(model.id) !== model) return;
            const template = MERMAID_PRODUCT_TEMPLATES.find(
              (item) => item.id === templateId,
            );
            const { flavour: _f, ...mermaidProps } =
              createMermaidBlockInsertProps({
                source: template?.source ?? "flowchart TD\n  A --> B",
                title: template?.label ?? label,
              });
            insertBlockAfter(model, "myoxus:mermaid", mermaidProps);
          })().catch(console.error);
        },
        insertBpmnDiagram: () => {
          void (async () => {
            const { createBpmnBlockInsertProps, insertPreparedBpmnBlock } =
              await import("@virgultum/block-bpmn");
            if (page.readonly || page.getModelById(model.id) !== model) return;
            const target = resolveInsertParent(page, model, "myoxus:bpmn");
            if (!target) return;
            const props = createBpmnBlockInsertProps();
            page.captureSync();
            const result = insertPreparedBpmnBlock(
              page,
              target.anchor,
              props,
              "after",
            );
            if (
              result.ok &&
              target.anchor === model &&
              model.text?.length === 0 &&
              model.children.length === 0
            ) {
              page.deleteBlock(model);
            }
            page.captureSync();
            if (!result.ok) {
              notify.error({
                title: t["com.myoxus.common.operation-failed"](),
              });
            }
          })().catch(console.error);
        },
        copyLine: () => {
          const abort = new AbortController();
          void import("./page-block-copy")
            .then(({ copyPageBlock }) =>
              copyPageBlock(model, framework, abort.signal),
            )
            .then(() => {
              notify.success({ title: t["Copied to clipboard"]() });
            })
            .catch(console.error);
        },
        openAiPrompt: () => {
          framework.getOptional(ViewService)?.view.showTool("chat");
        },
      });

    const snapshot = computed<EditorSlashState>(() => {
      const { query, entries, stack, returnTo } = state.value;
      const top = stack.at(-1);
      const visible = top
        ? filterPageSlashItems(top.items, query, t.language)
        : filterPageSlashItems(entries, query, t.language);
      return {
        open: true,
        query,
        options: visible.map(toEditorSlashOption),
        depth: stack.length,
        heading: top?.heading,
        returnTo,
      };
    });

    const refresh = () => {
      if (stop.signal.aborted || composing || owner.isComposing) return;
      const current = owner.pickerRange(start);
      if (!current || current.query.startsWith(" ")) {
        closeMenu();
        return;
      }
      if (currentQuery === current.query) return;
      currentQuery = current.query;
      activeRangeRef.current = {
        model: current.line.model,
        offset: current.from.offset,
      };
      getCaretRect();
      const entries = makeEntries(current.line.model, current.from.offset);
      state.value = {
        query: currentQuery,
        entries,
        stack: currentQuery ? [] : state.value.stack,
        returnTo: undefined,
      };
    };

    const later = () => queueMicrotask(refresh);
    const opts = { signal: stop.signal };
    input.addEventListener(
      "keydown",
      (event) => {
        if (event.isComposing || composing) return;
        keys.forEach((handler) => handler(event));
        if (event.defaultPrevented) {
          event.stopImmediatePropagation();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopImmediatePropagation();
          closeMenu();
        }
      },
      { ...opts, capture: true },
    );
    input.addEventListener("beforeinput", later, opts);
    input.addEventListener(
      "compositionstart",
      () => {
        composing = true;
      },
      opts,
    );
    input.addEventListener(
      "compositionend",
      () => {
        composing = false;
        later();
      },
      opts,
    );
    document.addEventListener("selectionchange", later, opts);

    const findEntry = (
      id: string,
      list: readonly PageSlashEntry[],
    ): PageSlashEntry | undefined => {
      for (const entry of list) {
        if (entry.id === id) return entry;
        if (entry.subMenu) {
          const nested = findEntry(id, entry.subMenu);
          if (nested) return nested;
        }
      }
      return undefined;
    };

    const control: EditorSlashControls = {
      input,
      getSnapshot: () => snapshot.value,
      subscribe: (listener) => snapshot.subscribe(listener),
      subscribeKeys: (listener) => {
        keys.add(listener);
        return () => {
          keys.delete(listener);
        };
      },
      choose: (id) => {
        if (stop.signal.aborted) return;
        refresh();
        if (stop.signal.aborted) return;
        const { stack, entries, query } = state.value;
        const pool = stack.at(-1)?.items ?? entries;
        const entry = findEntry(id, pool);
        if (!entry) return;
        if (entry.subMenu?.length) {
          state.value = {
            ...state.value,
            stack: [
              ...stack,
              {
                heading: entry.label,
                items: entry.subMenu,
                returnTo: entry.id,
              },
            ],
            returnTo: undefined,
          };
          return;
        }
        if (entry.runSync) {
          const runSync = entry.runSync;
          owner.consumeSlash(start, query, ({ line, offset }) =>
            runSync(page, line.model, offset),
          );
          closeMenu(false);
          return;
        }
        if (entry.runAsync) {
          const consumed = owner.consumeSlash(start, query);
          if (!consumed) {
            closeMenu(false);
            return;
          }
          entry.runAsync();
          closeMenu(hasModalRef.current);
        }
      },
      back: () => {
        if (stop.signal.aborted) return;
        const { stack } = state.value;
        if (!stack.length) return;
        const popped = stack.at(-1)!;
        state.value = {
          ...state.value,
          stack: stack.slice(0, -1),
          returnTo: popped.returnTo,
        };
      },
      cancel: () => closeMenu(false),
      setAnchor: (el) => {
        releaseAnchor?.();
        if (!el || stop.signal.aborted) return;
        releaseAnchor = bindFloatingAnchor(
          { contextElement: input, getBoundingClientRect: getCaretRect },
          el,
          { minWidth: 1, minHeight: 16 },
        );
      },
    };

    refresh();
    if (!stop.signal.aborted) setControls(control);

    return () => {
      stop.abort();
      releaseAnchor?.();
      keys.clear();
    };
  }, [
    owner,
    page,
    start,
    root,
    enableAI,
    close,
    t,
    framework,
    workspace,
    canUseServerDatabase,
    enableMermaid,
    isTemplateDocument,
    workspaceDialog,
    editorI18n,
    openTemplateVariablePicker,
    openBuildingBlockPicker,
    insertNamedBuildingBlock,
    insertBlockAfter,
    insertServerDatabaseBlock,
    finishAll,
  ]);

  const embedMeta = useMemo(() => {
    if (modal?.kind !== "embed") return null;
    switch (modal.embedKind) {
      case "bookmark":
        return {
          flavour: "myoxus:bookmark",
          title: t["Link"](),
          description: t["com.myoxus.editor.slash.bookmark-description"](),
        };
      case "youtube":
        return {
          flavour: "myoxus:embed-youtube",
          title: t["com.myoxus.editor.slash.youtube"](),
          description: t["com.myoxus.editor.slash.youtube-description"](),
        };
      case "github":
        return {
          flavour: "myoxus:embed-github",
          title: t["com.myoxus.editor.slash.github"](),
          description: t["com.myoxus.editor.slash.github-description"](),
        };
      case "figma":
        return {
          flavour: "myoxus:embed-figma",
          title: t["com.myoxus.editor.slash.figma"](),
          description: t["com.myoxus.editor.slash.figma-description"](),
        };
      case "loom":
        return {
          flavour: "myoxus:embed-loom",
          title: t["com.myoxus.editor.slash.loom"](),
          description: t["com.myoxus.editor.slash.loom-description"](),
        };
    }
  }, [modal, t]);

  const footnotePresentation = useMemo(
    () =>
      modal?.kind === "footnote" ? localFootnotePresentation(page) : undefined,
    [modal, page],
  );

  return (
    <>
      {controls ? <EditorSlashMenu controls={controls} /> : null}
      {templateVariablePicker}
      {holdingPicker ? (
        <div
          onKeyDown={(event) => {
            if (event.key === "Escape") finishAll();
          }}
        >
          {buildingBlockPicker}
        </div>
      ) : null}
      {modal?.kind === "embed" && embedMeta ? (
        <EditorEmbedCardCreate
          controls={{
            title: embedMeta.title,
            description: embedMeta.description,
            setAnchor: () => {},
            isValidUrl: (raw) => isValidEmbedUrl(modal.embedKind, raw),
            confirm: (raw) => {
              const url = normalizeUrl(raw.trim());
              if (isValidEmbedUrl(modal.embedKind, url)) {
                insertBlockAfter(modal.model, embedMeta.flavour, { url });
              }
              finishAll();
            },
            close: () => {
              owner.focusPoint(modal.model.id, modal.offset);
              finishAll();
            },
          }}
        />
      ) : null}
      {modal?.kind === "inline-link" ? (
        <EditorLinkEditor
          controls={{
            editing: true,
            text: "",
            url: "",
            setAnchor: (el) => {
              if (!el) return;
              Object.assign(el.style, {
                position: "fixed",
                left: `${modal.rect.left}px`,
                top: `${modal.rect.top}px`,
                width: "1px",
                height: `${Math.max(modal.rect.height, 16)}px`,
                pointerEvents: "none",
              });
            },
            isValidUrl: (raw) => isValidUrl(raw.trim()),
            confirm: (rawUrl, text) => {
              const url = normalizeUrl(rawUrl.trim());
              const label = (text ?? "").trim() || url;
              if (
                !isValidUrl(url) ||
                page.readonly ||
                page.getModelById(modal.model.id) !== modal.model ||
                !modal.model.text
              ) {
                finishAll();
                return;
              }
              page.captureSync();
              page.transact(() =>
                modal.model.text!.insert(label, modal.offset, { link: url }),
              );
              page.captureSync();
              owner.focusPoint(modal.model.id, modal.offset + label.length);
              finishAll();
            },
            close: () => {
              owner.focusPoint(modal.model.id, modal.offset);
              finishAll();
            },
          }}
        />
      ) : null}
      {modal?.kind === "directory" ? (
        <DocumentIndexConfiguration
          value={defaultDocumentIndexProps()}
          apply={(value: DocumentIndexProps) => {
            insertBlockAfter(modal.model, "myoxus:document-index", value);
            finishAll();
          }}
          close={finishAll}
        />
      ) : null}
      {modal?.kind === "footnote" && footnotePresentation ? (
        <div
          style={{
            position: "fixed",
            left: `${modal.rect.left}px`,
            top: `${modal.rect.bottom}px`,
          }}
        >
          <FootnoteInsertion
            placement={modal.placement}
            definitions={localFootnoteDefinitions(page)
              .filter(
                (def) =>
                  footnotePresentation.get(def.id)?.placement ===
                  modal.placement,
              )
              .map((def) => ({
                id: def.id,
                ...footnotePresentation.get(def.id),
                excerpt: def.children
                  .map((child) => child.text?.toString() ?? "")
                  .join(" ")
                  .slice(0, 80),
              }))}
            choose={(existingId) => {
              insertLocalFootnoteOnStore(
                page,
                modal.model,
                modal.offset,
                modal.placement,
                existingId,
              );
              owner.focusPoint(modal.model.id, modal.offset + 1);
              finishAll();
            }}
            cancel={() => {
              owner.focusPoint(modal.model.id, modal.offset);
              finishAll();
            }}
          />
        </div>
      ) : null}
    </>
  );
}
