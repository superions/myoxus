// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/core/store";
import {
  DocumentEditorRoot,
  DocumentEditorPageViewport,
  DocumentTitleRow,
  DocumentEditorBlankGap,
  PageContentRail,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import {
  useRef,
  useLayoutEffect,
  useEffect,
  useState,
  useReducer,
} from "react";
import { EditorSettingService } from "../../../modules/editor-setting";
import { EditorService } from "../../../modules/editor";
import { useWorkbenchSurfaceScrollViewport } from "../../../modules/workbench/view/workbench-surface-scroll";
import { DocsService } from "../../../modules/doc";
import {
  DocumentMetadataProvider,
  DocumentMetadataSummary,
} from "../../../modules/document-metadata";
import { WorkspaceDialogService } from "../../../modules/dialogs";
import { ServerService, UserFeatureService } from "../../../modules/server";
import { useGuard } from "../../../components/guard";
import { DocIconPicker } from "./doc-icon-picker";
import type { PageLine } from "./plain-page-model";
import { PageInteraction } from "./page-interaction";
import {
  type PageBookmark,
  type PageIntent,
  readPageRange,
  resolveBookmark,
  restorePageRange,
} from "./plain-page-input";
import { bindDocumentTitleSync } from "./document-title-sync";
import { StarterBar } from "./starter-bar";
import { PageFormatting } from "./plain-page-formatting";
import "./plain-page.css";

function TextField({
  line,
  title,
  readonly,
  composing,
}: {
  line: PageLine;
  title?: string;
  readonly: boolean;
  composing: () => boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<string>(undefined);
  useLayoutEffect(() => {
    const field = ref.current!;
    const paint = () => {
      if (composing()) return;
      const runs = line.text.toDelta() as {
        insert: string;
        attributes?: Record<string, unknown>;
      }[];
      const key = JSON.stringify(runs);
      if (previous.current === key) return;
      previous.current = key;
      const fragment = document.createDocumentFragment();
      for (const { insert, attributes: a = {} } of runs) {
        let node: Node = document.createTextNode(insert);
        for (const [mark, tag] of Object.entries({
          bold: "strong",
          italic: "em",
          underline: "u",
          strike: "s",
          code: "code",
        })) {
          if (a[mark]) {
            const el = document.createElement(tag);
            el.append(node);
            node = el;
          }
        }
        if (a.color || a.background) {
          const el = document.createElement("span");
          el.style.color = String(a.color ?? "");
          el.style.backgroundColor = String(a.background ?? "");
          el.append(node);
          node = el;
        }
        fragment.append(node);
      }
      if (!runs.length && !title) fragment.append(document.createElement("br"));
      field.replaceChildren(fragment);
    };
    const force = () => {
      previous.current = undefined;
      paint();
    };
    paint();
    field.addEventListener("page-refresh-text", force);
    return () => field.removeEventListener("page-refresh-text", force);
  });
  return (
    <span
      ref={ref}
      data-page-text={line.model.id}
      data-block-id={line.model.id}
      data-page-title={title ? true : undefined}
      data-placeholder={title}
      aria-label={title}
      contentEditable={title ? !readonly : undefined}
      suppressContentEditableWarning
    />
  );
}

export function PlainPageView({
  page,
  lines,
  readonly,
  refresh,
  controller,
  handoff,
  className,
  fullWidth,
}: {
  page: Store;
  lines: PageLine[];
  readonly: boolean;
  refresh: () => void;
  controller: { current: PageInteraction | null };
  handoff: (range: PageBookmark | null, intent?: PageIntent) => void;
  className?: string;
  fullWidth?: string;
}) {
  const t = useI18n(),
    docs = useService(DocsService);
  const settings = useLiveData(
    useService(EditorSettingService).editorSetting.settings$,
  );
  const dialogs = useService(WorkspaceDialogService),
    server = useService(ServerService).server;
  const admin = useLiveData(
      useService(UserFeatureService).userFeature.isAdmin$,
    ),
    configure = useGuard("Workspace_Settings_Update");
  const root = useRef<HTMLDivElement>(null);
  const editor = useService(EditorService).editor,
    viewport = useWorkbenchSurfaceScrollViewport();
  const selector = useLiveData(editor.selector$);
  useLayoutEffect(
    () =>
      editor.bindPageOrigin(
        root.current!,
        viewport.current,
        () => controller.current?.relinquish(),
        () => controller.current?.selectedBlocks() ?? [],
      ),
    [editor, controller, viewport],
  );
  const props = useRef({ lines, readonly });
  useLayoutEffect(() => {
    props.current = { lines, readonly };
  });
  const [selection, setSelection] = useState<DOMRect | null>(null);
  const [epoch, repaint] = useReducer((n) => n + 1, 0);
  useLayoutEffect(() => {
    const el = root.current!;
    const owner = new PageInteraction(
      page,
      el,
      () => props.current.lines,
      () => !props.current.readonly,
      refresh,
      handoff,
    );
    controller.current = owner;
    if (editor.pageSelection) {
      const saved = resolveBookmark(page, editor.pageSelection);
      if (saved) restorePageRange(el, saved);
      editor.pageSelection = null;
    } else if (
      !props.current.readonly &&
      !editor.selector$.value?.blockIds?.length &&
      editor.scrollPosition.page === null
    ) {
      const title = props.current.lines[0];
      const end = { id: title.model.id, offset: title.text.length };
      restorePageRange(el, { anchor: end, focus: end });
    }
    const onSelection = () => {
      const range = readPageRange(el),
        sel = document.getSelection();
      if (
        range &&
        sel?.rangeCount &&
        !sel.isCollapsed &&
        !props.current.readonly
      ) {
        setSelection(sel.getRangeAt(0).getBoundingClientRect());
      } else if (
        !document.activeElement?.closest('[role="toolbar"],[role="menu"]')
      )
        setSelection(null);
    };
    document.addEventListener("selectionchange", onSelection);
    return () => {
      editor.pageSelection = owner.selection ?? null;
      controller.current = null;
      owner.dispose();
      document.removeEventListener("selectionchange", onSelection);
    };
  }, [page, editor, controller, handoff, refresh]);
  useLayoutEffect(
    () => controller.current?.afterRender(),
    [controller, lines, epoch],
  );
  const [title, ...body] = lines;
  useEffect(() => {
    if (selector?.commentId || selector?.elementIds?.length) {
      controller.current?.relinquish();
      return;
    }
    const id = selector?.blockIds?.[0];
    if (id) {
      root.current
        ?.querySelector(`[data-page-text="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: "center" });
    }
  }, [selector, controller]);
  useEffect(
    () =>
      readonly
        ? undefined
        : bindDocumentTitleSync(page.id, title.text, docs, (e) =>
            console.error("Title update failed", e),
          ),
    [page, readonly, title.text, docs],
  );
  const composing = () => !!controller.current?.isComposing;
  return (
    <DocumentEditorRoot
      ref={root}
      mode="page"
      readingSize={settings.fontSize}
      className={className}
      data-full-width-layout={fullWidth}
      data-testid={`editor-${page.id}`}
      data-page-renderer="native"
    >
      <DocumentEditorPageViewport>
        <DocumentTitleRow data-testid="doc-title-row">
          <DocIconPicker docId={page.id} readonly={readonly} />
          <TextField
            line={title}
            title={t.Title()}
            readonly={readonly}
            composing={composing}
          />
        </DocumentTitleRow>
        <DocumentMetadataProvider
          docId={page.id}
          readonly={readonly}
          canOpenGlobalPolicy={Boolean(admin)}
          canConfigureWorkspaceDefaults={configure}
          onConfigureWorkspaceDefaults={() =>
            dialogs.open("workspace-settings", {
              activeTab: "workspace:documents",
            })
          }
          onOpenGlobalPolicy={() =>
            window.open(
              new URL("/adminfrontend/documents?tab=metadata", server.baseUrl),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          <DocumentMetadataSummary />
        </DocumentMetadataProvider>
        <PageContentRail width="editor">
          <div
            data-page-body=""
            contentEditable={!readonly}
            suppressContentEditableWarning
          >
            {body.map((line) => (
              <div
                className="plain-page-line"
                key={line.model.id}
                style={{
                  paddingInlineStart: `calc(${line.depth} * var(--mantine-spacing-xl))`,
                }}
              >
                {line.kind !== "text" && (
                  <span contentEditable={false}>
                    {line.kind === "numbered" ? (
                      `${line.ordinal}.`
                    ) : line.kind === "todo" ? (
                      <input
                        type="checkbox"
                        checked={line.checked}
                        disabled={readonly}
                        onChange={() => {
                          if (!readonly && !page.readonly)
                            page.updateBlock(line.model, {
                              checked: !line.checked,
                            });
                        }}
                      />
                    ) : (
                      "•"
                    )}{" "}
                  </span>
                )}
                <TextField
                  line={line}
                  readonly={readonly}
                  composing={composing}
                />
              </div>
            ))}
          </div>
        </PageContentRail>
        <DocumentEditorBlankGap
          data-testid="page-editor-blank"
          onClick={() => {
            if (!readonly) {
              const last = body.at(-1)!;
              const point = { id: last.model.id, offset: last.text.length };
              restorePageRange(root.current!, { anchor: point, focus: point });
            }
          }}
        />
        {!readonly && <StarterBar doc={page} />}
        {!readonly && selection && controller.current && (
          <PageFormatting
            controller={controller.current}
            rect={selection}
            dismiss={() => setSelection(null)}
            changed={repaint}
          />
        )}
      </DocumentEditorPageViewport>
    </DocumentEditorRoot>
  );
}
