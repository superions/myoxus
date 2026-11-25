// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  LiveData,
  useFramework,
  useLiveData,
  useServiceOptional,
} from "@myoxus/infra";
import { PeekViewService } from "../../../modules/peek-view/services/peek-view";
import {
  defaultAttachmentProps,
  type AttachmentBlockModel,
  type ImageBlockModel,
} from "@virgultum/core/models";
import { Bound } from "@virgultum/core/primitives/gfx";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import { ResourceController } from "@virgultum/core/resource";
import type { EditorSelectionState } from "@virgultum/core/services";
import { formatSize, openSingleFileWith } from "@virgultum/core/utils";
import {
  useLayoutEffect,
  useMemo,
  lazy,
  Suspense,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import {
  TextAttachmentPreview,
  textAttachmentFormat,
} from "../../attachment-viewer/text/text-preview";
import { EditorAttachmentCard } from "../../view-extensions/editor-view/editor-chrome/attachment-card";
import { EditorAttachmentRename } from "../../view-extensions/editor-view/editor-chrome/attachment-rename";
import { EditorSelectionToolbar } from "../../view-extensions/editor-view/editor-chrome/selection-toolbar";
import { attachmentFileLimit } from "../../view-extensions/editor-view/file-size-limit";
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
import { PageCitationBadge } from "./page-block-chrome";
const MediaPreview = lazy(async () => ({
  default: (await import("../../attachment-viewer/attachment-embed-preview"))
    .AttachmentEmbedPreview,
}));

export function usePageResource(
  model: AttachmentBlockModel | ImageBlockModel,
  type?: string,
) {
  const resource = useMemo(
    () =>
      new ResourceController(
        model.props.sourceId$,
        model.flavour === "myoxus:image" ? "Image" : "File",
      ).setEngine(model.store.blobSync),
    [model],
  );
  const state = useLiveData(
    useMemo(() => LiveData.fromSignal(resource.resolvedState$), [resource]),
  );
  const source = model.props.sourceId;
  useLayoutEffect(() => {
    const stop = resource.subscribe();
    void resource.refreshUrlWith(type);
    return () => {
      stop();
      resource.dispose();
    };
  }, [resource, source, type]);
  return { resource, state };
}
export default function PageAttachment({
  model,
  readonly,
}: {
  model: AttachmentBlockModel;
  readonly: boolean;
}) {
  const t = useI18n();
  const framework = useFramework();
  const captionEditor = usePageCaption(model, readonly);
  const peekView = useServiceOptional(PeekViewService)?.peekView;
  const block = useRef<HTMLDivElement>(null);
  const [selected, select] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLElement | null>(null);
  const { sourceId, type, embed, name, size, style, footnoteIdentifier } =
    model.props;
  const media =
    type === "application/pdf"
      ? "pdf"
      : type.startsWith("video/")
        ? "video"
        : type.startsWith("audio/")
          ? "audio"
          : type.startsWith("image/")
            ? "image"
            : textAttachmentFormat(name, type)
              ? "text"
              : undefined;
  const { state, resource } = usePageResource(model, type);
  usePageFloatingAnchor({
    active: selected || renaming,
    reference: block.current,
    anchor,
    floating,
    onDismiss: () => {
      select(false);
      setRenaming(false);
    },
  });
  const focus = () => block.current?.focus({ preventScroll: true });
  const current = () =>
    !readonly &&
    !model.store.readonly &&
    model.store.getModelById(model.id) === model;
  const peek = () => {
    if (!current() || !type.endsWith("pdf") || !peekView) return;
    const element = model.store.getBlock(model.id);
    if (element) void peekView.open({ element }).catch(console.error);
  };
  const replaceFile = () => {
    void (async () => {
      const file = await openSingleFileWith();
      if (!file || !current()) return;
      if (file.size > attachmentFileLimit.maxFileSize) {
        attachmentFileLimit.onOverFileSize();
        return;
      }
      const nextSourceId = await model.store.blobSync.set(file);
      if (!current()) return;
      model.store.captureSync();
      model.store.updateBlock(model, {
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
        sourceId: nextSourceId,
        embed: false,
      });
      model.store.captureSync();
    })().catch(console.error);
  };
  const dotIndex = name.lastIndexOf(".");
  const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : "";
  const snapshot: EditorSelectionState = {
    open: selected && !renaming && !readonly,
    key: model.id,
    placement: "top",
    more: [
      {
        id: "copy",
        label: t["Copy"](),
        icon: "CopyIcon",
        disabled: false,
        run: () => {
          const abort = new AbortController();
          void copyOrCutPageBlock(model, "copy", framework, abort.signal)
            .then(() => notifyCopied(t["Copied to clipboard"]()))
            .catch(console.error);
          select(false);
        },
      },
      {
        id: "duplicate",
        label: t["com.myoxus.editor.keyboard.duplicate"](),
        icon: "DuplicateIcon",
        disabled: false,
        run: () => {
          duplicatePageBlock(model);
          select(false);
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
          select(false);
        },
      },
    ],
    primary: [
      {
        id: "a.rename",
        label: t.Rename(),
        icon: "EditIcon",
        disabled: false,
        run: () => setRenaming(true),
      },
      {
        id: "b.conversions",
        label: t["com.myoxus.keyboardShortcuts.switch"](),
        disabled: false,
        control: {
          type: "choice",
          value: embed ? "embed" : "card",
          options: [
            {
              value: "card",
              label: t["com.myoxus.editor.toolbar.card-view"](),
              disabled: !embed,
            },
            {
              value: "embed",
              label: t["com.myoxus.editor.toolbar.embed-view"](),
              disabled:
                !!embed ||
                !media ||
                !state.url ||
                state.state !== "none" ||
                size > attachmentFileLimit.maxFileSize,
            },
          ],
          change(value) {
            if (!current() || (value !== "card" && value !== "embed")) return;
            if (
              value === "embed" &&
              (!media ||
                !resource.blobUrl$.peek() ||
                model.props.size > attachmentFileLimit.maxFileSize)
            )
              return;
            model.store.captureSync();
            if (value === "embed" && (media === "pdf" || media === "video")) {
              const bounds = Bound.deserialize(model.xywh);
              bounds.w = EMBED_CARD_WIDTH[media];
              bounds.h = EMBED_CARD_HEIGHT[media];
              model.store.updateBlock(model, {
                embed: true,
                style: media,
                xywh: bounds.serialize(),
              });
            } else if (value === "embed")
              model.store.updateBlock(model, { embed: true });
            else {
              const style = defaultAttachmentProps.style!;
              const bounds = Bound.deserialize(model.xywh);
              bounds.w = EMBED_CARD_WIDTH[style];
              bounds.h = EMBED_CARD_HEIGHT[style];
              model.store.updateBlock(model, {
                style,
                embed: false,
                xywh: bounds.serialize(),
              });
            }
            model.store.captureSync();
            queueMicrotask(focus);
          },
        },
      },
      {
        id: "c.replace",
        label: t["com.myoxus.editor.toolbar.replace-attachment"](),
        icon: "ReplaceIcon",
        disabled: false,
        run: replaceFile,
      },
      {
        id: "d.download",
        label: t["com.myoxus.attachment.download"](),
        icon: "DownloadIcon",
        disabled: !state.url,
        run: () => {
          const url = resource.blobUrl$.peek();
          if (!url || model.props.sourceId !== sourceId) return;
          downloadBlobUrl(url, model.props.name);
        },
      },
      {
        id: "e.caption",
        label: t["com.myoxus.editor.toolbar.caption"](),
        icon: "CaptionIcon",
        disabled: false,
        run: captionEditor.show,
      },
    ],
  };
  const clipboard = (e: ClipboardEvent, action: "copy" | "cut" | "paste") => {
    if (
      document.activeElement !== block.current ||
      !document.getSelection()?.isCollapsed
    )
      return;
    e.preventDefault();
    if (action === "paste") {
      if (current())
        void pasteAfterPageBlock(model, e.clipboardData).catch(console.error);
      return;
    }
    if (action === "copy" || current()) {
      const abort = new AbortController();
      void copyOrCutPageBlock(model, action, framework, abort.signal).catch(
        console.error,
      );
    }
  };
  return (
    <div
      data-page-attachment={model.id}
      data-block-id={model.id}
      contentEditable={false}
      ref={block}
      tabIndex={-1}
      onClick={(e) => {
        select(true);
        if (!(
          e.target instanceof Element &&
          e.target.closest("button,input,select,a,video,audio")
        )) {
          if (e.shiftKey) peek();
          else focus();
        }
      }}
      onDoubleClick={(e) => {
        if (!(
          e.target instanceof Element &&
          e.target.closest("button,input,select,a,video,audio")
        ))
          peek();
      }}
      onKeyDown={(e) => {
        if (e.target !== block.current || !current()) return;
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
            block.current?.closest<HTMLElement>("[data-page-renderer]") ?? null,
            model,
            e.key === "ArrowUp" || e.key === "Backspace" ? -1 : 1,
            e.key === "Delete" || e.key === "Backspace",
            e.key === "Enter",
          );
        }
      }}
      onCopy={(e) => clipboard(e, "copy")}
      onCut={(e) => clipboard(e, "cut")}
      onPaste={(e) => clipboard(e, "paste")}
    >
      <PageCitationBadge identifier={footnoteIdentifier} />
      {embed &&
      media &&
      state.url &&
      size <= attachmentFileLimit.maxFileSize &&
      !state.error ? (
        media === "text" ? (
          <TextAttachmentPreview model={model} blobUrl={state.url} />
        ) : media === "video" ? (
          <video key={sourceId} src={state.url} controls aria-label={name} />
        ) : media === "image" ? (
          <img key={sourceId} src={state.url} alt={name} />
        ) : (
          <Suspense fallback={null}>
            <MediaPreview key={sourceId} model={model} />
          </Suspense>
        )
      ) : (
        <EditorAttachmentCard
          controls={{
            inSurface: false,
            selected,
            title: name,
            description:
              (state.error && resource.state$.peek().errorMessage) ||
              formatSize(size) ||
              "",
            fileType: name.split(".").pop() ?? "",
            loading: state.loading,
            error: state.error,
            vertical: style === "cubeThick",
            action:
              state.state === "error:oversize"
                ? readonly
                  ? undefined
                  : { kind: "limit", run: attachmentFileLimit.onOverFileSize }
                : state.error
                  ? {
                      kind: state.needUpload ? "retry" : "reload",
                      run: () => {
                        if (state.needUpload) {
                          if (current())
                            void resource.upload().catch(console.error);
                        } else void resource.refreshUrlWith(type);
                      },
                    }
                  : undefined,
          }}
        />
      )}
      {captionEditor.field}
      {selected && !renaming && !readonly && (
        <EditorSelectionToolbar
          controls={{
            getSnapshot: () => snapshot,
            subscribe: () => () => {},
            setAnchor,
            setFloating,
            dismiss: () => select(false),
            activate: focus,
          }}
        />
      )}
      {renaming && !readonly && (
        <EditorAttachmentRename
          controls={{
            name: baseName,
            extension,
            setAnchor,
            confirm: (next) => {
              const trimmed = next.trim();
              if (trimmed && current()) {
                model.store.captureSync();
                model.store.updateBlock(model, {
                  name: `${trimmed}${extension}`,
                });
                model.store.captureSync();
              }
              setRenaming(false);
              focus();
            },
            close: () => {
              setRenaming(false);
              focus();
            },
          }}
        />
      )}
    </div>
  );
}
