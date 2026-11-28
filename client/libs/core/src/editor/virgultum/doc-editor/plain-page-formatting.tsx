// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import { useFramework, useServiceOptional } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import {
  DefaultEditorI18nService,
  type EditorSelectionControls,
  type SelectionAction,
} from "@virgultum/core/services";
import type { BlockModel, Store } from "@virgultum/core/store";
import { isMyoxusLabelTone } from "@virgultum/core/styles/text";
import { isValidUrl } from "@virgultum/core/utils/url";
import { useMemo, useState } from "react";

import { DocCommentManagerService } from "../../../modules/comment/services/doc-comment-manager";
import { createTaskReferenceInserter } from "../../../modules/database/tasks/task-reference-insertion";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { DocsService } from "../../../modules/doc";
import { DocLinksService } from "../../../modules/doc-link";
import { DocumentMetadataCacheService } from "../../../modules/document-metadata/services/document-metadata-cache";
import { GuardService } from "../../../modules/permissions";
import { WorkspaceServerService } from "../../../modules/server";
import { TemplateDocService } from "../../../modules/template-doc";
import { ViewService, WorkbenchService } from "../../../modules/workbench";
import { AIProvider } from "../../ai/provider/ai-provider";
import { TASK_CAPTURE_TEXT_LIMIT } from "../../view-extensions/editor-config/toolbar/task-capture-selection";
import { EditorLinkEditor } from "../../view-extensions/editor-view/editor-chrome/link-editor";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import { configureEditorI18n } from "../editor-i18n";
import type {
  PageBlockConversionTarget,
  PageInteraction,
} from "./page-interaction";
import { useTemplateVariablePicker } from "./template-variable-picker";

export function PageFormatting({
  page,
  controller,
  rect,
  dismiss,
  changed,
  enableAI,
  canComment,
  initialLinkOpen,
}: {
  page: Store;
  controller: PageInteraction;
  rect: DOMRect;
  dismiss: () => void;
  changed: () => void;
  enableAI: boolean;
  canComment?: boolean;
  initialLinkOpen?: boolean;
}) {
  const t = useI18n();
  const framework = useFramework();
  const docsService = useServiceOptional(DocsService);
  const workbench = useServiceOptional(WorkbenchService)?.workbench;
  const view = useServiceOptional(ViewService)?.view;
  const docCommentManager = useServiceOptional(DocCommentManagerService);
  const templateList = useServiceOptional(TemplateDocService)?.list;
  const [editingLink, setEditingLink] = useState(Boolean(initialLinkOpen));
  const { openTemplateVariablePicker, templateVariablePicker } =
    useTemplateVariablePicker();
  const editorI18n = useMemo(
    () => new DefaultEditorI18nService(configureEditorI18n()),
    [],
  );

  const tone = controller.labelTone();
  const alignment = controller.alignment();
  const eyebrow = controller.eyebrowState();
  const run = (key: string, value?: string | null) => () => {
    controller.format(key, value);
    changed();
  };

  if (editingLink) {
    const selectedText = controller.selectedText();
    return (
      <EditorLinkEditor
        controls={{
          editing: false,
          url: "",
          text: selectedText,
          close: () => {
            setEditingLink(false);
            controller.restore();
            dismiss();
          },
          setAnchor: (el) => {
            if (el)
              Object.assign(el.style, {
                pointerEvents: "none",
                position: "fixed",
                top: `${rect.top}px`,
                left: `${rect.left}px`,
                width: `${rect.width}px`,
                height: `${rect.height}px`,
              });
          },
          isValidUrl,
          confirm: (url, text) => {
            controller.applyLink(url, text);
            setEditingLink(false);
            changed();
            dismiss();
          },
        }}
      />
    );
  }

  const primary: SelectionAction[] = (
    [
      ["bold", "BoldIcon", t["Bold"]()],
      ["italic", "ItalicIcon", t["com.myoxus.keyboardShortcuts.italic"]()],
      [
        "underline",
        "UnderLineIcon",
        t["com.myoxus.keyboardShortcuts.underline"](),
      ],
      [
        "strike",
        "StrikeThroughIcon",
        t["com.myoxus.keyboardShortcuts.strikethrough"](),
      ],
      ["code", "CodeIcon", t["com.myoxus.editor.keyboard.code"]()],
    ] as const
  ).map(([id, icon, label]) => ({
    id,
    icon,
    label,
    disabled: false,
    active: controller.markActive(id),
    run: run(id),
  }));

  primary.push(
    {
      id: "color",
      icon: "TextColorIcon",
      label: t["com.myoxus.editor.toolbar.text-color"](),
      disabled: false,
      control: {
        type: "menu",
        items: [
          {
            id: "default",
            label: t["com.myoxus.editor.keyboard.default-color"](),
            disabled: false,
            run: run("color", null),
          },
          ...(
            [
              "red",
              "orange",
              "yellow",
              "green",
              "teal",
              "blue",
              "purple",
              "grey",
            ] as const
          ).map((name) => ({
            id: name,
            swatch: `var(--myoxus-text-highlight-foreground-${name})`,
            label: t[`com.myoxus.editor.table.color.${name}`](),
            disabled: false,
            run: run(
              "color",
              `var(--myoxus-text-highlight-foreground-${name})`,
            ),
          })),
        ],
      },
    },
    {
      id: "background",
      icon: "HighLightLinearIcon",
      label: t["com.myoxus.editor.toolbar.text-marker"](),
      disabled: false,
      control: {
        type: "menu",
        items: [
          {
            id: "default",
            disabled: false,
            label: t["com.myoxus.editor.toolbar.remove-text-marker"](),
            run: run("background", null),
          },
          ...(["yellow", "green", "pink", "orange", "blue"] as const).map(
            (name) => ({
              id: name,
              disabled: false,
              label: t[`com.myoxus.editor.text-marker.${name}`](),
              swatch: `var(--myoxus-sem-text-marker-${name})`,
              run: run("background", `var(--myoxus-sem-text-marker-${name})`),
            }),
          ),
        ],
      },
    },
  );

  const convertItem = (
    target: PageBlockConversionTarget,
    label: string,
    icon: SelectionAction["icon"],
  ): SelectionAction => ({
    id: `convert-${target}`,
    label,
    icon,
    disabled: false,
    run: () => {
      controller.convertSelectedBlocks(target);
      changed();
    },
  });

  const formats = primary.splice(0, 5);
  formats.push({
    id: "link",
    label: t["com.myoxus.editor.keyboard.link"](),
    icon: "LinkIcon",
    disabled: false,
    run: () => setEditingLink(true),
  });

  primary.unshift(
    {
      id: "a.conversions",
      label: t["com.myoxus.editor.toolbar.conversions"](),
      icon: "TextIcon",
      disabled: false,
      control: {
        type: "menu",
        onClose: () => controller.restore(),
        items: [
          convertItem("text", t["Text"](), "TextIcon"),
          convertItem("h1", t["Heading"]({ number: "1" }), "Heading1Icon"),
          convertItem("h2", t["Heading"]({ number: "2" }), "Heading2Icon"),
          convertItem("h3", t["Heading"]({ number: "3" }), "Heading3Icon"),
          convertItem("h4", t["Heading"]({ number: "4" }), "Heading4Icon"),
          convertItem("h5", t["Heading"]({ number: "5" }), "Heading5Icon"),
          convertItem("h6", t["Heading"]({ number: "6" }), "Heading6Icon"),
          convertItem(
            "bulleted",
            t["com.myoxus.editor.slash.bulleted-list"](),
            "BulletedListIcon",
          ),
          convertItem(
            "numbered",
            t["com.myoxus.editor.slash.numbered-list"](),
            "NumberedListIcon",
          ),
          convertItem(
            "todo",
            t["com.myoxus.editor.slash.todo-list"](),
            "CheckBoxCheckLinearIcon",
          ),
          convertItem(
            "quote",
            t["com.myoxus.editor.keyboard.quote"](),
            "QuoteIcon",
          ),
          convertItem(
            "code",
            t["com.myoxus.editor.slash.code-block"](),
            "CodeBlockIcon",
          ),
          convertItem(
            "callout",
            t["com.myoxus.editor.slash.callout"](),
            "FontIcon",
          ),
        ],
      },
    },
    {
      id: "b.align",
      label: t["com.myoxus.editor.toolbar.alignment"](),
      disabled: !alignment,
      control: {
        type: "choice",
        presentation: "icons",
        value: alignment ?? null,
        options: [
          {
            value: "left",
            icon: "TextAlignLeftIcon",
            label: t["com.myoxus.editor.toolbar.align-left"](),
          },
          {
            value: "center",
            icon: "TextAlignCenterIcon",
            label: t["com.myoxus.editor.toolbar.align-center"](),
          },
          {
            value: "right",
            icon: "TextAlignRightIcon",
            label: t["com.myoxus.editor.toolbar.align-right"](),
          },
        ],
        change: (value) => {
          controller.align(value);
          changed();
        },
      },
    },
    { id: "b.inline-text", label: "", disabled: false, actions: formats },
  );

  if (enableAI) {
    primary.unshift({
      id: "A.ai",
      label: t["com.myoxus.editor.toolbar.ask-ai"](),
      icon: "AiIcon",
      disabled: false,
      run: () => {
        const quoted = controller.selectedText().trim();
        view?.showTool("chat");
        AIProvider.slots.requestOpenWithChat.next({
          host: null,
          docId: page.id,
          mode: "page",
          autoSelect: true,
          ...(quoted
            ? {
                input: quoted,
                context: { quote: quoted, markdown: quoted },
              }
            : {}),
        });
        dismiss();
      },
    });
  }

  if (eyebrow !== undefined) {
    primary.push({
      id: "b.eyebrow",
      icon: "TextTypeIcon",
      label: t["com.myoxus.editor.paragraph.eyebrow"](),
      disabled: false,
      active: eyebrow,
      run: () => {
        controller.toggleEyebrow();
        changed();
      },
    });
  }

  primary.push(
    {
      id: "c.label-tone",
      label: `${t["com.myoxus.editor.label-tone.label"]()}: ${t[`com.myoxus.editor.label-tone.${isMyoxusLabelTone(tone) || tone === "mixed" ? tone : "clear"}`]()}`,
      icon: "TagsIcon",
      active: isMyoxusLabelTone(tone),
      disabled: false,
      control: {
        type: "menu",
        onClose: () => controller.restore(),
        items: (
          [
            "neutral",
            "info",
            "positive",
            "warning",
            "danger",
            "accent",
            "clear",
          ] as const
        ).map((value) => ({
          id: value,
          label: t[`com.myoxus.editor.label-tone.${value}`](),
          disabled: false,
          active: (tone ?? "clear") === value,
          run: run("labelTone", value === "clear" ? null : value),
        })),
      },
    },
    {
      id: "d.template-variable",
      label: t["com.myoxus.editor.field.document-fields"](),
      icon: "TextTypeIcon",
      disabled: false,
      run: () => {
        const isTemplate = Boolean(templateList?.isTemplate$(page.id).value);
        openTemplateVariablePicker({
          i18n: editorI18n,
          templateSource: isTemplate,
          canWrite: () => !page.readonly,
          insert: (token) => {
            controller.insertTemplateToken(token);
            changed();
          },
          insertField: (field) => {
            controller.insertDocumentField(field);
            changed();
          },
          onClose: () => {
            controller.restore();
            dismiss();
          },
        });
      },
    },
  );

  if (docsService) {
    primary.push({
      id: "f.convert-to-linked-doc",
      label: t["com.myoxus.editor.toolbar.create-linked-doc"](),
      icon: "LinkedPageIcon",
      disabled: false,
      run: () => {
        const title = controller.selectedText().trim().slice(0, 120);
        const created = docsService.createDoc({ title });
        controller.replaceSelectionWithLinkedDoc(created.id);
        changed();
        dismiss();
      },
    });
  }

  if (canComment && docCommentManager) {
    primary.push({
      id: "g.comment",
      label: t["com.myoxus.editor.toolbar.comment"](),
      icon: "CommentIcon",
      disabled: false,
      run: () => {
        const selection = controller.selectedTextSelection();
        if (!selection) return;
        const preview = controller.selectedText().trim().slice(0, 200);
        workbench?.activeView$.value?.showTool("comment");
        const ref = docCommentManager.get(page);
        void ref.obj
          .addComment([selection], preview || "New comment")
          .finally(() => {
            ref.release();
          });
        dismiss();
      },
    });
  }

  const captureSource = (() => {
    const selection = controller.selectedTextSelection();
    if (!selection || selection.isCollapsed()) return null;
    const fromModel = page.getModelById(selection.from.blockId);
    const toModel = selection.to
      ? page.getModelById(selection.to.blockId)
      : fromModel;
    const endpoints = [fromModel, toModel].filter(
      (model): model is BlockModel => Boolean(model),
    );
    if (
      !endpoints.length ||
      endpoints.some(
        (model) => !["myoxus:paragraph", "myoxus:list"].includes(model.flavour),
      )
    )
      return null;
    const excerpt = controller.selectedText().trim();
    if (!excerpt || excerpt.length > TASK_CAPTURE_TEXT_LIMIT) return null;
    let note: BlockModel | null = fromModel ?? null;
    const seen = new Set<string>();
    while (note && note.flavour !== "myoxus:note") {
      if (seen.has(note.id)) {
        note = null;
        break;
      }
      seen.add(note.id);
      note = page.getParent(note);
    }
    return {
      sourceExternalId: page.doc.id,
      blockId: selection.from.blockId,
      selectionAnchor: JSON.stringify({
        ...selection.toJSON(),
        captureMode: "page",
        ...(note ? { noteId: note.id } : {}),
      }),
      excerpt,
    };
  })();

  const openNativeTaskCapture = async (mode: "capture" | "insert") => {
    if (!captureSource) return;
    const servers = framework.getOptional(WorkspaceServerService);
    const metadata = framework.getOptional(DocumentMetadataCacheService);
    const guard = framework.getOptional(GuardService);
    const dialogs = framework.getOptional(WorkspaceDialogService);
    const backlinks = framework.getOptional(DocLinksService)?.backlinks;
    const sourceServer = servers?.server;
    const sourceAccount = sourceServer?.account$.value;
    if (
      !servers ||
      !metadata ||
      !guard ||
      !dialogs ||
      !sourceServer ||
      !sourceAccount
    )
      return;
    const activeEl = document.activeElement;
    const returnFocusRef = {
      current:
        activeEl instanceof HTMLElement &&
        !activeEl.closest("[data-range-sync-exclude]")
          ? activeEl
          : null,
    };
    const sourceWorkspaceId = page.workspace.id;
    const openingOwnerIdentity = JSON.stringify([
      sourceServer.id,
      sourceServer.baseUrl,
      sourceAccount.id,
      sourceWorkspaceId,
    ]);
    const isCurrent = () => {
      const currentServer = servers.server;
      return Boolean(
        page.root &&
        page.doc.id === captureSource.sourceExternalId &&
        currentServer &&
        JSON.stringify([
          currentServer.id,
          currentServer.baseUrl,
          currentServer.account$.value?.id,
          page.workspace.id,
        ]) === openingOwnerIdentity,
      );
    };
    const loadedModel = metadata.getModel(captureSource.sourceExternalId);
    let sourceDocumentId =
      loadedModel?.metadata.docId ??
      metadata.getIndexRowByExternalId(captureSource.sourceExternalId)?.docId;
    try {
      if (!isCurrent()) return;
      if (loadedModel && loadedModel.metadata.workspaceId !== sourceWorkspaceId)
        throw new Error("Source metadata scope changed");
      if (!sourceDocumentId) {
        const hydrated = await metadata.hydrateMetadataWhenAvailable(
          captureSource.sourceExternalId,
          new AbortController().signal,
        );
        if (
          !isCurrent() ||
          hydrated.workspaceId !== sourceWorkspaceId ||
          !hydrated.docId
        )
          throw new Error("Source metadata unavailable");
        sourceDocumentId = hydrated.docId;
      }
    } catch {
      notify.error({ title: t["com.myoxus.database.embed.unavailable"]() });
      return;
    }
    try {
      if (!isCurrent()) return;
      const [read, copy] = await Promise.all([
        guard.can("Doc_Read", captureSource.sourceExternalId),
        guard.can("Doc_Copy", captureSource.sourceExternalId),
      ]);
      const currentMetadata = metadata.getModel(
        captureSource.sourceExternalId,
      )?.metadata;
      const currentIndexedId = metadata.getIndexRowByExternalId(
        captureSource.sourceExternalId,
      )?.docId;
      if (
        !read ||
        !copy ||
        !isCurrent() ||
        (currentIndexedId && currentIndexedId !== sourceDocumentId) ||
        (currentMetadata &&
          (currentMetadata.workspaceId !== sourceWorkspaceId ||
            currentMetadata.docId !== sourceDocumentId))
      )
        throw new Error("Source unavailable");
      const insertReference = createTaskReferenceInserter(
        framework,
        { store: page, isAttached: () => Boolean(page.root) },
        openingOwnerIdentity,
      );
      const closed = () => {
        if (mode === "insert") insertReference.releaseConfirmed();
        controller.restore();
      };
      if (mode === "insert") {
        dialogs.open(
          "task-reference-insert",
          {
            openingOwnerIdentity,
            source: {
              sourceDocumentId,
              sourceExternalId: captureSource.sourceExternalId,
              blockId: captureSource.blockId,
              selectionAnchor: captureSource.selectionAnchor,
            },
            returnFocusRef,
            onInsertReference: insertReference,
          },
          closed,
        );
        return;
      }
      let refreshed = false;
      dialogs.open(
        "task-capture",
        {
          ...captureSource,
          sourceDocumentId,
          openingOwnerIdentity,
          onInsertReference: insertReference,
          onCaptureReleased: (requestId) =>
            insertReference.releaseConfirmed(requestId),
          onConfirmed: () => {
            if (!isCurrent() || refreshed) return;
            const currentId =
              metadata.getModel(captureSource.sourceExternalId)?.metadata
                .docId ??
              metadata.getIndexRowByExternalId(captureSource.sourceExternalId)
                ?.docId;
            if (currentId !== sourceDocumentId) return;
            refreshed = true;
            backlinks?.revalidateFromCloud();
          },
          returnFocusRef,
        },
        closed,
      );
    } catch {
      notify.error({ title: t["com.myoxus.database.row_detail.forbidden"]() });
    }
  };

  const more: SelectionAction[] = [
    ...(captureSource
      ? [
          {
            id: "capture-as-task",
            label: t["com.myoxus.database.tasks.capture"](),
            icon: "CopyIcon" as const,
            disabled: false,
            run: () => {
              dismiss();
              void openNativeTaskCapture("capture");
            },
          },
          {
            id: "insert-existing-task",
            label: t["com.myoxus.database.tasks.insert-existing"](),
            icon: "CopyIcon" as const,
            disabled: false,
            run: () => {
              dismiss();
              void openNativeTaskCapture("insert");
            },
          },
        ]
      : []),
    {
      id: "a.copy",
      label: t["Copy"](),
      icon: "CopyIcon",
      disabled: false,
      run: () => {
        controller.copySelectedBlocks();
        dismiss();
      },
    },
    {
      id: "b.duplicate",
      label: t["com.myoxus.header.option.duplicate"](),
      icon: "DuplicateIcon",
      disabled: false,
      run: () => {
        controller.duplicateSelectedBlocks();
        changed();
        dismiss();
      },
    },
    {
      id: "c.delete",
      label: t.Delete(),
      icon: "DeleteIcon",
      variant: "destructive",
      disabled: false,
      run: () => {
        controller.deleteSelectedBlocks();
        changed();
        dismiss();
      },
    },
  ];

  const snapshot = {
    open: true,
    key: "page",
    placement: "top" as const,
    primary,
    more,
  };
  const controls: EditorSelectionControls = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    dismiss,
    activate: () => controller.restore(),
    setFloating: () => {},
    setAnchor: (el) => {
      if (el)
        Object.assign(el.style, {
          pointerEvents: "none",
          position: "fixed",
          top: `${rect.top}px`,
          left: `${rect.left}px`,
          width: `${rect.width}px`,
          height: `${rect.height}px`,
        });
    },
  };
  return (
    <>
      <EditorSelectionToolbar controls={controls} />
      {templateVariablePicker}
    </>
  );
}
