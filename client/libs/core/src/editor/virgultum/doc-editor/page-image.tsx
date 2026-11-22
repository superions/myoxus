// SPDX-License-Identifier: AGPL-3.0-or-later
import { useLayoutEffect, useState, useRef } from "react";
import { useService } from "@myoxus/infra";
import { useI18n } from "@myoxus/i18n";
import type { ImageBlockModel } from "@virgultum/core/models";
import { formatSize } from "@virgultum/core/utils";
import { PeekViewService } from "../../../modules/peek-view";
import { EditorImageFallback } from "../../view-extensions/editor-view/editor-chrome/image-fallback";
import { EditorAttachmentCard } from "../../view-extensions/editor-view/editor-chrome/attachment-card";
import { usePageResource } from "./page-attachment";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import type {
  EditorSelectionState,
  SelectionAction,
} from "@virgultum/core/services";
import { autoUpdate } from "@floating-ui/dom";
import type { PageIntent } from "./plain-page-input";

export default function PageImage({
  model,
  readonly,
  handoff,
}: {
  model: ImageBlockModel;
  readonly: boolean;
  handoff: (i: PageIntent) => void;
}) {
  const { resource, state } = usePageResource(model),
    t = useI18n(),
    peek = useService(PeekViewService).peekView;
  const { width, height, caption, sourceId, textAlign, size } = model.props;
  const root = useRef<HTMLDivElement>(null),
    img = useRef<HTMLImageElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = img.current ?? root.current;
    if (!el || !anchor) return;
    return autoUpdate(el, anchor, () => {
      const r = el.getBoundingClientRect();
      Object.assign(anchor.style, {
        position: "fixed",
        pointerEvents: "none",
        top: `${r.top}px`,
        left: `${r.left}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      });
    });
  }, [anchor, state.url]);
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
  useLayoutEffect(() => {
    if (!selected) return;
    const leave = (e: PointerEvent) => {
      if (
        !root.current?.contains(e.target as Node) &&
        !(
          e.target instanceof Element &&
          e.target.closest('[data-testid="selection-toolbar"]')
        )
      )
        select(false);
    };
    document.addEventListener("pointerdown", leave, true);
    return () => document.removeEventListener("pointerdown", leave, true);
  }, [selected]);
  const command = (control: string) => {
    if (writable())
      handoff({
        kind: "block-command",
        flavour: model.flavour,
        id: model.id,
        control,
      });
  };
  const action = (
    id: string,
    label: string,
    icon: SelectionAction["icon"],
    run = () => command(id),
  ): SelectionAction => ({ id, label, icon, disabled: false, run });
  const stateBar: EditorSelectionState = {
    key: model.id,
    open: selected && !readonly,
    placement: "top",
    more: [],
    primary: [
      action(
        "a.download",
        t["com.myoxus.attachment.download"](),
        "DownloadIcon",
      ),
      action(
        "b.caption",
        t["com.myoxus.editor.toolbar.caption"](),
        "CaptionIcon",
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
            handoff({
              kind: "block-command",
              flavour: model.flavour,
              id: model.id,
              control: `image-key:${e.key}`,
            });
          }
        }
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
      {caption && <figcaption>{caption}</figcaption>}
      {selected && !readonly && (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: () => stateBar,
            subscribe: () => () => {},
            setAnchor,
            setFloating: () => {},
            dismiss: () => select(false),
            activate: () => root.current?.focus({ preventScroll: true }),
          }}
          openMore={() => command("selection-more")}
        />
      )}
    </div>
  );
}
