// SPDX-License-Identifier: AGPL-3.0-or-later
import { usePageCaption } from "./page-caption";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useService } from "@myoxus/infra";
import { useMemo, useEffect, useRef, useState } from "react";
import type {
  BookmarkBlockModel,
  LinkPreviewData,
} from "@virgultum/core/models";
import { copyTextToClipboard } from "@virgultum/core/primitives/utils";
import {
  LinkPreviewCache,
  type EditorSelectionState,
  type SelectionAction,
} from "@virgultum/core/services";
import { buildImageProxyURL } from "@virgultum/core/adapters";
import { normalizeUrl, isValidUrl } from "@virgultum/core/utils";
import { ServerService } from "../../../modules/server";
import { workspaceLinkPreview } from "../../view-extensions/link-preview-service/link-preview-service";
import { EditorBookmarkCard } from "../../view-extensions/editor-view/editor-chrome/bookmark-card";
import { EditorEmbedCardEdit } from "../../view-extensions/editor-view/editor-chrome/embed-card-edit";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import {
  convertCardBlockToInlineLink,
  copyOrCutPageBlock,
  deletePageBlock,
  duplicatePageBlock,
  leaveAtomicPageBlock,
  notifyCopied,
  pasteAfterPageBlock,
} from "./page-block-actions";
import { usePageFloatingAnchor } from "./page-floating-anchor";
import { PageCitationBadge } from "./page-block-chrome";

export default function PageBookmarkCard({
  model,
  readonly,
}: {
  model: BookmarkBlockModel;
  readonly: boolean;
}) {
  const t = useI18n();
  const framework = useFramework();
  const caption = usePageCaption(model, readonly);
  const base = useService(ServerService).server.baseUrl;
  const service = useMemo(
    () => workspaceLinkPreview(base, LinkPreviewCache.getInstance()),
    [base],
  );
  const proxy = useMemo(
    () => new URL(BUILD_CONFIG.imageProxyUrl, base).href,
    [base],
  );
  const { url, style } = model.props;
  const previous = useRef<string | undefined>(undefined);
  const blockRef = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [result, setResult] = useState<{
    url: string;
    loading: boolean;
    error: boolean;
    data?: Partial<LinkPreviewData>;
  }>();

  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;

  usePageFloatingAnchor({
    active: selected || editing,
    reference: blockRef.current,
    anchor,
    floating,
    onDismiss: () => {
      setSelected(false);
      setEditing(false);
    },
  });

  useEffect(() => {
    const changed = previous.current !== undefined && previous.current !== url;
    previous.current = url;
    if (
      !changed &&
      !refreshTick &&
      (model.props.title || model.props.description) &&
      (style !== "vertical" || model.props.image)
    )
      return;
    const abort = new AbortController();
    const live = () =>
      !abort.signal.aborted &&
      model.store.getModelById(model.id) === model &&
      model.props.url === url;
    setResult({ url, loading: true, error: false });
    void service
      .query(url, abort.signal)
      .then((data) => {
        if (!live()) return;
        const error =
          !data.title && !data.icon && !data.image && !data.description;
        setResult({ url, loading: false, error, data });
        if (!error && !readonly && !model.store.readonly)
          model.store.updateBlock(model, {
            title: data.title ?? null,
            description: data.description ?? null,
            image: data.image ?? null,
            icon: data.icon ?? null,
          });
      })
      .catch(() => {
        if (live()) setResult({ url, loading: false, error: true });
      });
    return () => abort.abort();
  }, [service, model, url, style, readonly, refreshTick]);

  const current = result?.url === url ? result : undefined;
  const image = model.props.image ?? current?.data?.image;
  const icon = model.props.icon ?? current?.data?.icon;
  const normalizedUrl = normalizeUrl(url);

  const toolbarState: EditorSelectionState = {
    open: selected && !editing && !readonly,
    key: model.id,
    placement: "top",
    primary: [
      {
        id: "open-url",
        label: normalizedUrl,
        icon: "LinkIcon",
        showLabel: true,
        disabled: !isValidUrl(normalizedUrl),
        run: () => {
          if (isValidUrl(normalizedUrl))
            window.open(normalizedUrl, "_blank", "noopener,noreferrer");
        },
      },
      {
        id: "copy-link",
        label: t["com.myoxus.editor.toolbar.copy-link"](),
        icon: "CopyIcon",
        disabled: false,
        run: () => {
          void copyTextToClipboard(normalizedUrl);
          notifyCopied(t["Copied to clipboard"]());
          setSelected(false);
        },
      },
      {
        id: "edit",
        label: t["com.myoxus.editor.toolbar.edit-description"](),
        icon: "EditIcon",
        disabled: false,
        run: () => setEditing(true),
      },
      {
        id: "switch-view",
        label: t["com.myoxus.keyboardShortcuts.switch"](),
        icon: "LinkIcon",
        disabled: false,
        control: {
          type: "choice",
          value: style === "vertical" ? "embed" : "card",
          options: [
            {
              value: "inline",
              label: t["com.myoxus.editor.toolbar.inline-view"](),
            },
            {
              value: "card",
              label: t["com.myoxus.editor.toolbar.card-view"](),
            },
            {
              value: "embed",
              label: t["com.myoxus.editor.toolbar.embed-view"](),
            },
          ],
          change: (value) => {
            if (!writable()) return;
            if (value === "inline") {
              convertCardBlockToInlineLink(model, url, model.props.title);
              setSelected(false);
              return;
            }
            model.store.captureSync();
            model.store.updateBlock(model, {
              style: value === "embed" ? "vertical" : "horizontal",
            });
            model.store.captureSync();
          },
        },
      },
      {
        id: "caption",
        label: t["com.myoxus.editor.toolbar.caption"](),
        icon: "CaptionIcon",
        disabled: false,
        run: caption.show,
      },
    ],
    more: [
      {
        id: "reload",
        label: t["com.myoxus.editor.toolbar.reload"](),
        icon: "ResetIcon",
        disabled: false,
        run: () => setRefreshTick((n) => n + 1),
      },
      {
        id: "duplicate",
        label: t["com.myoxus.editor.keyboard.duplicate"](),
        icon: "DuplicateIcon",
        disabled: false,
        run: () => {
          duplicatePageBlock(model);
          setSelected(false);
        },
      },
      {
        id: "delete",
        label: t["Delete"](),
        icon: "DeleteIcon",
        variant: "destructive",
        disabled: false,
        run: () => {
          deletePageBlock(model);
          setSelected(false);
        },
      },
    ] satisfies SelectionAction[],
  };

  return (
    <div
      ref={blockRef}
      data-block-id={model.id}
      data-page-bookmark={model.id}
      tabIndex={-1}
      contentEditable={false}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setSelected(false);
          setEditing(false);
          return;
        }
        if (e.target !== blockRef.current || !writable()) return;
        if (
          ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
            e.key,
          )
        ) {
          e.preventDefault();
          leaveAtomicPageBlock(
            blockRef.current.closest<HTMLElement>("[data-page-renderer]"),
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
      onCopy={(e) => {
        if (document.activeElement !== blockRef.current) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "copy", framework, abort.signal).catch(
          console.error,
        );
      }}
      onCut={(e) => {
        if (document.activeElement !== blockRef.current || !writable()) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "cut", framework, abort.signal).catch(
          console.error,
        );
      }}
      onPaste={(e) => {
        if (document.activeElement !== blockRef.current || !writable()) return;
        e.preventDefault();
        void pasteAfterPageBlock(model, e.clipboardData).catch(console.error);
      }}
    >
      <PageCitationBadge identifier={model.props.footnoteIdentifier} />
      <EditorBookmarkCard
        controls={{
          title: model.props.title ?? current?.data?.title ?? null,
          description:
            model.props.description ?? current?.data?.description ?? null,
          image: image ? buildImageProxyURL(image, proxy) : null,
          icon: icon ? buildImageProxyURL(icon, proxy) : null,
          url,
          style:
            style === "vertical" || style === "cube" || style === "list"
              ? style
              : "horizontal",
          loading: !!current?.loading,
          error: !!current?.error,
          selected,
          inSurface: false,
          commentHighlighted: false,
          open: () => {
            if (normalizedUrl && isValidUrl(normalizedUrl))
              window.open(normalizedUrl, "_blank", "noopener,noreferrer");
          },
          select: () => {
            if (!readonly && !model.store.readonly) {
              setSelected(true);
              blockRef.current?.focus({ preventScroll: true });
            }
          },
        }}
      />
      {caption.field}
      {selected && !editing && !readonly ? (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: () => toolbarState,
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            activate: () => blockRef.current?.focus({ preventScroll: true }),
            dismiss: () => setSelected(false),
          }}
        />
      ) : null}
      {editing && !readonly ? (
        <EditorEmbedCardEdit
          controls={{
            mode: "external",
            internal: false,
            title: model.props.title ?? "",
            description: model.props.description ?? "",
            canReset: false,
            reset: () => {},
            setAnchor,
            confirm: (nextTitle, nextDescription) => {
              if (writable()) {
                model.store.captureSync();
                model.store.updateBlock(model, {
                  title: nextTitle.trim() || null,
                  description: nextDescription.trim() || null,
                });
                model.store.captureSync();
              }
              setEditing(false);
            },
            close: () => setEditing(false),
          }}
        />
      ) : null}
    </div>
  );
}
