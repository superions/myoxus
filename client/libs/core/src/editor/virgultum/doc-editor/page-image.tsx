// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useState, useRef } from "react";
import { useFramework, useService } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import type { ImageBlockModel } from "@virgultum/core/models";
import { formatSize } from "@virgultum/core/utils";
import { PeekViewService } from "../../../modules/peek-view";
import { ViewService } from "../../../modules/workbench";
import { EditorImageFallback } from "../../view-extensions/editor-view/editor-chrome/image-fallback";
import { EditorAttachmentCard } from "../../view-extensions/editor-view/editor-chrome/attachment-card";
import { usePageResource } from "./page-attachment";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import type {
  EditorSelectionState,
  SelectionAction,
} from "@virgultum/core/services";
import { usePageCaption } from "./page-caption";
import {
  copyOrCutPageBlock,
  deletePageBlock,
  downloadBlobUrl,
  duplicatePageBlock,
  leaveAtomicPageBlock,
  notifyCopied,
  pasteAfterPageBlock,
} from "./page-block-actions";
import { usePageFloatingAnchor } from "./page-floating-anchor";

export default function PageImage({
  model,
  readonly,
}: {
  model: ImageBlockModel;
  readonly: boolean;
}) {
  const { resource, state } = usePageResource(model),
    t = useI18n(),
    framework = useFramework(),
    peek = useService(PeekViewService).peekView;
  const captionEditor = usePageCaption(model, readonly);
  const { width, height, caption, sourceId, textAlign, size } = model.props;
  const root = useRef<HTMLDivElement>(null),
    img = useRef<HTMLImageElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const [selected, select] = useState(false),
    [natural, setNatural] = useState(0),
    [draft, setDraft] = useState<number>();
  const drag = useRef<{
    pointer: number;
    center: number;
    sign: number;
    width: number | undefined;
    height: number | undefined;
    id: string | undefined;
  }>(null);
  const writable = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  useLayoutEffect(() => {
    drag.current = null;
    setDraft(undefined);
    setNatural(0);
  }, [sourceId]);
  usePageFloatingAnchor({
    active: selected,
    reference: img.current ?? root.current,
    anchor,
    floating,
    onDismiss: () => select(false),
    deps: [state.url],
  });
  const action = (
    id: string,
    label: string,
    icon: SelectionAction["icon"],
    run: () => void,
    extra?: Partial<SelectionAction>,
  ): SelectionAction => ({ id, label, icon, disabled: false, run, ...extra });
  const stateBar: EditorSelectionState = {
    key: model.id,
    open: selected && !readonly,
    placement: "top",
    more: [
      action("copy", t["Copy"](), "CopyIcon", () => {
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "copy", framework, abort.signal)
          .then(() => notifyCopied(t["Copied to clipboard"]()))
          .catch(console.error);
        select(false);
      }),
      action(
        "duplicate",
        t["com.myoxus.editor.keyboard.duplicate"](),
        "DuplicateIcon",
        () => {
          duplicatePageBlock(model);
          select(false);
        },
      ),
      action(
        "delete",
        t["Delete"](),
        "DeleteIcon",
        () => {
          deletePageBlock(model);
          select(false);
        },
        { variant: "destructive" },
      ),
    ],
    primary: [
      action(
        "a.download",
        t["com.myoxus.attachment.download"](),
        "DownloadIcon",
        () => {
          const url = resource.blobUrl$.peek();
          if (!url || model.props.sourceId !== sourceId) return;
          downloadBlobUrl(url, caption || `image-${model.id}.png`);
        },
        { disabled: !state.url },
      ),
      action(
        "b.caption",
        t["com.myoxus.editor.toolbar.caption"](),
        "CaptionIcon",
        captionEditor.show,
      ),
      ...(["left", "center", "right"] as const).map((side, i) =>
        action(
          `c.${i + 1}.align-${side}`,
          t[`com.myoxus.editor.toolbar.align-${side}`](),
          (
            [
              "TextAlignLeftIcon",
              "TextAlignCenterIcon",
              "TextAlignRightIcon",
            ] as const
          )[i],
          () => {
            if (writable()) {
              model.store.captureSync();
              model.store.updateBlock(model, { textAlign: side });
              model.store.captureSync();
            }
          },
        ),
      ),
      action(
        "d.comment",
        t["com.myoxus.editor.toolbar.comment"](),
        "CommentIcon",
        () => {
          framework.getOptional(ViewService)?.view.showTool("comment");
          select(false);
        },
      ),
    ],
  };
  const open = () => {
    const element = model.store.getBlock(model.id);
    if (element) void peek.open({ element }).catch(console.error);
  };
  const live = () => {
    const d = drag.current;
    return (
      !!d &&
      writable() &&
      model.props.sourceId === d.id &&
      model.props.width === d.width &&
      model.props.height === d.height
    );
  };
  const end = () => {
    drag.current = null;
    setDraft(undefined);
  };
  return (
    <div
      ref={root}
      tabIndex={-1}
      contentEditable={false}
      data-page-image={model.id}
      data-block-id={model.id}
      data-align={textAlign ?? "center"}
      onClick={(e) => {
        if (e.shiftKey) {
          open();
          return;
        }
        select(true);
        root.current?.focus({ preventScroll: true });
      }}
      onDoubleClick={open}
      onKeyDown={(e) => {
        if (e.key === "Escape") select(false);
        else if (selected && writable() && e.target === root.current) {
          if (
            (e.ctrlKey || e.metaKey) &&
            ["z", "y"].includes(e.key.toLowerCase())
          ) {
            e.preventDefault();
            e.key.toLowerCase() === "y" || e.shiftKey
              ? model.store.redo()
              : model.store.undo();
          } else if (
            ["Delete", "Backspace", "Enter", "ArrowDown", "ArrowUp"].includes(
              e.key,
            )
          ) {
            e.preventDefault();
            leaveAtomicPageBlock(
              root.current?.closest<HTMLElement>("[data-page-renderer]") ??
                null,
              model,
              e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
              e.key === "Delete" || e.key === "Backspace",
              e.key === "Enter",
            );
          }
        }
      }}
      onCopy={(e) => {
        if (document.activeElement !== root.current) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "copy", framework, abort.signal).catch(
          console.error,
        );
      }}
      onCut={(e) => {
        if (document.activeElement !== root.current || !writable()) return;
        e.preventDefault();
        const abort = new AbortController();
        void copyOrCutPageBlock(model, "cut", framework, abort.signal).catch(
          console.error,
        );
      }}
      onPaste={(e) => {
        if (document.activeElement !== root.current || !writable()) return;
        e.preventDefault();
        void pasteAfterPageBlock(model, e.clipboardData).catch(console.error);
      }}
    >
      {state.url ? (
        <div
          data-image-pixels=""
          data-selected={selected || undefined}
          style={{
            width: draft ?? (width && height ? width : natural || undefined),
          }}
        >
          <img
            key={sourceId}
            ref={img}
            loading="lazy"
            draggable={false}
            src={state.url}
            alt={caption || t.Image()}
            onLoad={(e) => setNatural(e.currentTarget.naturalWidth)}
            onError={() =>
              resource.updateState({
                errorMessage: t["com.myoxus.editor.resource.download-failed"](),
              })
            }
          />
          {selected &&
            !readonly &&
            ["top-left", "top-right", "bottom-left", "bottom-right"].map(
              (c) => (
                <span
                  key={c}
                  data-image-corner={c}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    if (!writable() || e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const b = img.current!.getBoundingClientRect();
                    drag.current = {
                      pointer: e.pointerId,
                      center: b.left + b.width / 2,
                      sign: c.endsWith("right") ? 1 : -1,
                      width,
                      height,
                      id: sourceId,
                    };
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    const d = drag.current;
                    if (!d || d.pointer !== e.pointerId) return;
                    if (!live()) {
                      end();
                      return;
                    }
                    setDraft(
                      Math.min(
                        root.current!.clientWidth,
                        Math.max(50, 2 * (e.clientX - d.center) * d.sign),
                      ),
                    );
                  }}
                  onPointerUp={(e) => {
                    const d = drag.current;
                    if (!d || d.pointer !== e.pointerId) return;
                    if (
                      live() &&
                      draft !== undefined &&
                      img.current?.naturalWidth
                    ) {
                      const w = Math.min(
                        root.current!.clientWidth,
                        Math.max(50, 2 * (e.clientX - d.center) * d.sign),
                      );
                      model.store.captureSync();
                      model.store.updateBlock(model, {
                        width: w,
                        height:
                          (w * img.current.naturalHeight) /
                          img.current.naturalWidth,
                      });
                      model.store.captureSync();
                    }
                    end();
                  }}
                  onLostPointerCapture={end}
                  onPointerCancel={end}
                />
              ),
            )}
        </div>
      ) : (
        <EditorImageFallback
          controls={{
            inSurface: false,
            loading: state.loading,
            error: state.error,
            description:
              resource.state$.peek().errorMessage ||
              formatSize(size ?? 0) ||
              "",
          }}
        />
      )}
      {state.url && state.error && (
        <EditorAttachmentCard
          controls={{
            inSurface: false,
            selected: false,
            title:
              t[
                state.needUpload
                  ? "com.myoxus.editor.resource.upload-failed"
                  : "com.myoxus.editor.resource.download-failed"
              ](),
            description: resource.state$.peek().errorMessage ?? "",
            fileType: "image",
            loading: false,
            error: true,
            vertical: false,
            statusPopover: true,
            action: {
              kind: state.needUpload ? "retry" : "reload",
              run: () => {
                if (state.needUpload) {
                  if (writable()) void resource.upload();
                } else void resource.refreshUrlWith();
              },
            },
          }}
        />
      )}
      {captionEditor.field}
      {selected && !readonly && (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: () => stateBar,
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            dismiss: () => select(false),
            activate: () => root.current?.focus({ preventScroll: true }),
          }}
        />
      )}
    </div>
  );
}
