// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocumentViewport } from "@myoxus/core/editor/editors";
import {
  type MountReactPortal,
  usePortalFactory,
} from "@myoxus/core/editor/portal";
import { patchEditorChromeHost } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome";
import { SnapshotHelper } from "@myoxus/core/modules/comment/services/snapshot-helper";
import type { CommentAttachment } from "@myoxus/core/modules/comment/types";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { downloadResourceWithUrl } from "@myoxus/core/utils/resource";
import { DebugLogger } from "@myoxus/debug";
import {
  ArrowUpBigIcon,
  AttachmentIcon,
  CloseIcon,
  ResetIcon,
} from "@myoxus/icons/react";
import { useFramework, useService } from "@myoxus/infra";
import {
  commentEditorViewportClassName,
  DialogFooterActions,
  Group,
  IconButton,
  MediaPreviewFrame,
  MediaPreviewIcon,
  MediaPreviewImage,
  MyoxusText,
  notify,
  Stack,
  SurfaceListAction,
  SurfaceListItem,
} from "@myoxus/ui-facade";
import { formatByteSize } from "@virgultum/core/primitives/utils";
import type { EditorHost, TextSelection } from "@virgultum/core/runtime";
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import { type RichText, selectTextModel } from "@virgultum/editor/rich-text";
import { ViewportElementExtension } from "@virgultum/editor/shared/services";
import { openFilesWith } from "@virgultum/editor/shared/utils";
import { type DocSnapshot, nanoid, Store } from "@virgultum/editor/store";
import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { useAsyncCallback } from "../../hooks/myoxus-async-hooks";
import { getCommentEditorViewManager } from "./specs";

const MAX_ATTACHMENT_COUNT = 10;
const logger = new DebugLogger("CommentEditor");

export interface CommentEditorAttachment extends CommentAttachment {
  status?: "uploading" | "success" | "error";
  file?: File;
  localUrl?: string;
}

export interface CommentEditorProps {
  readonly?: boolean;
  doc?: Store;
  defaultSnapshot?: DocSnapshot;
  onChange?: (snapshot: DocSnapshot) => void;
  onCommit?: () => void;
  onCancel?: () => void;
  uploadCommentAttachment?: (id: string, file: File) => Promise<string>;
  autoFocus?: boolean;
  attachments?: CommentEditorAttachment[];
  onAttachmentsChange?: (attachments: CommentEditorAttachment[]) => void;
}

export interface CommentEditorRef {
  getSnapshot: () => DocSnapshot | null | undefined;
  focus: () => void;
}

const isImageAttachment = (attachment: CommentEditorAttachment): boolean => {
  const mime = attachment.mimeType || attachment.file?.type || "";
  if (mime) {
    return mime.startsWith("image/");
  }
  return Boolean(
    attachment.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(attachment.url),
  );
};

const useCommentEditorSpecs = (
  readonly: boolean,
  mountPortal: MountReactPortal,
) => {
  const framework = useFramework();
  return useMemo(() => {
    const manager = getCommentEditorViewManager(framework);
    return manager
      .get(readonly ? "preview-page" : "page")
      .concat([
        ViewportElementExtension(`.${commentEditorViewportClassName}`),
        ...(!readonly ? [patchEditorChromeHost(mountPortal)] : []),
      ]);
  }, [framework, mountPortal, readonly]);
};

const useResolvedCommentStore = (
  source: DocSnapshot | Store,
  readonly?: boolean,
) => {
  const snapshotHelper = useService(SnapshotHelper);
  const [store, setStore] = useState<Store | undefined>(
    source instanceof Store ? source : undefined,
  );

  useEffect(() => {
    if (source instanceof Store) {
      setStore(source);
      return;
    }

    let cancelled = false;
    snapshotHelper
      .createStore(source)
      .then((created) => {
        if (cancelled || !created) return;
        created.readonly = readonly ?? false;
        setStore(created);
      })
      .catch((error) => {
        logger.error("Failed to create comment snapshot store", { error });
      });

    return () => {
      cancelled = true;
    };
  }, [readonly, snapshotHelper, source]);

  return store;
};

const AttachmentPreviewTile = ({
  attachment,
  index,
  readonly,
  onOpen,
  onRemove,
  onRetry,
}: {
  attachment: CommentEditorAttachment;
  index: number;
  readonly?: boolean;
  onOpen: (event: React.MouseEvent, index: number) => void;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) => {
  const isImage = isImageAttachment(attachment);
  const label = attachment.filename || attachment.file?.name || "Attachment";
  const previewUrl = attachment.localUrl ?? attachment.url ?? "";
  const canRetry =
    !readonly && attachment.status === "error" && Boolean(attachment.file);
  const FileIcon = !isImage
    ? getAttachmentFileIconRC(
        attachment.mimeType ||
          attachment.file?.type ||
          attachment.filename?.split(".").pop() ||
          "none",
      )
    : undefined;

  const overlayAction = !readonly ? (
    <Group gap="xs" wrap="nowrap">
      {canRetry ? (
        <IconButton
          size="xs"
          aria-label={`Retry upload ${label}`}
          onClick={(event) => {
            event.stopPropagation();
            onRetry(attachment.id);
          }}
          icon={<ResetIcon />}
        />
      ) : null}
      <IconButton
        size="xs"
        loading={attachment.status === "uploading"}
        variant="danger"
        aria-label={`Remove ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onRemove(attachment.id);
        }}
        icon={<CloseIcon />}
      />
    </Group>
  ) : undefined;

  return (
    <SurfaceListAction
      aria-label={label}
      component="div"
      mediaPreview={isImage ? "image" : "file"}
      overlayAction={overlayAction}
      role="button"
      surface
      tabIndex={0}
      onClick={(event) => onOpen(event, index)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
    >
      {isImage ? (
        <MediaPreviewFrame fit="cover">
          {previewUrl ? (
            <MediaPreviewImage alt={label} fit="cover" src={previewUrl} />
          ) : (
            <MediaPreviewIcon aria-label="Image attachment preview unavailable">
              <AttachmentIcon />
            </MediaPreviewIcon>
          )}
        </MediaPreviewFrame>
      ) : (
        <Group align="center" miw={0} w="100%">
          {FileIcon ? (
            <MediaPreviewIcon previewSize="file">
              <FileIcon />
            </MediaPreviewIcon>
          ) : null}
          <Stack miw={0}>
            <MyoxusText truncate typographySlot="body-small">
              {attachment.filename || attachment.file?.name || "File"}
            </MyoxusText>
            <MyoxusText
              tone={attachment.status === "error" ? "danger" : "secondary"}
              truncate
              typographySlot="caption"
            >
              {attachment.status === "error"
                ? "Upload failed"
                : attachment.size
                  ? formatByteSize(attachment.size)
                  : ""}
            </MyoxusText>
          </Stack>
        </Group>
      )}
    </SurfaceListAction>
  );
};

export const CommentEditor = forwardRef<CommentEditorRef, CommentEditorProps>(
  function CommentEditor(
    {
      readonly,
      defaultSnapshot,
      doc: userDoc,
      onChange,
      onCommit,
      uploadCommentAttachment,
      autoFocus,
      attachments,
      onAttachmentsChange,
    },
    ref,
  ) {
    const source = defaultSnapshot ?? userDoc;
    if (!source) {
      throw new Error("Either defaultSnapshot or doc must be provided");
    }

    const [portals, mountPortal] = usePortalFactory();
    const specs = useCommentEditorSpecs(Boolean(readonly), mountPortal);
    const doc = useResolvedCommentStore(source, readonly);
    const snapshotHelper = useService(SnapshotHelper);
    const peekViewService = useService(PeekViewService);

    const editorHostRef = useRef<EditorHost>(null);
    const [empty, setEmpty] = useState(true);
    const attachmentsRef = useRef(attachments);
    attachmentsRef.current = attachments;

    const updateAttachments = useCallback(
      (
        updater: (prev: CommentEditorAttachment[]) => CommentEditorAttachment[],
      ) => {
        // Apply async upload completions against the latest draft state.
        const next = updater(attachmentsRef.current ?? []);
        attachmentsRef.current = next;
        onAttachmentsChange?.(next);
      },
      [onAttachmentsChange],
    );

    const uploadSingleAttachment = useCallback(
      async (pending: CommentEditorAttachment) => {
        if (!uploadCommentAttachment || !pending.file) return;
        try {
          const remoteUrl = await uploadCommentAttachment(
            pending.id,
            pending.file,
          );
          logger.info("uploadCommentAttachment success", { remoteUrl });
          if (pending.localUrl) {
            URL.revokeObjectURL(pending.localUrl);
          }
          updateAttachments((prev) =>
            prev.map((item) =>
              item.id === pending.id
                ? {
                    ...item,
                    status: "success",
                    url: remoteUrl,
                    localUrl: undefined,
                  }
                : item,
            ),
          );
        } catch (error: unknown) {
          logger.error("uploadCommentAttachment failed", { error });
          notify.error({
            title: "Failed to upload attachment",
            message: error instanceof Error ? error.message : String(error),
          });
          if (pending.localUrl) {
            URL.revokeObjectURL(pending.localUrl);
          }
          updateAttachments((prev) =>
            prev.map((item) =>
              item.id === pending.id
                ? { ...item, status: "error", localUrl: undefined }
                : item,
            ),
          );
        }
      },
      [updateAttachments, uploadCommentAttachment],
    );

    const attachmentCount = attachments?.length ?? 0;
    const uploadLimitReached = attachmentCount >= MAX_ATTACHMENT_COUNT;
    const hasUploadingAttachment = Boolean(
      attachments?.some((item) => item.status === "uploading"),
    );
    const hasFailedAttachment = Boolean(
      attachments?.some((item) => item.status === "error"),
    );
    const submitDisabled =
      (empty && attachmentCount === 0) ||
      hasUploadingAttachment ||
      hasFailedAttachment;

    const addAttachments = useAsyncCallback(
      async (files: File[]) => {
        if (!uploadCommentAttachment) return;
        const remainingSlots =
          MAX_ATTACHMENT_COUNT - (attachmentsRef.current?.length ?? 0);
        const acceptedFiles = files.slice(0, Math.max(0, remainingSlots));
        if (acceptedFiles.length === 0) return;

        logger.info("addAttachments", { files: acceptedFiles });
        const pendingEntries: CommentEditorAttachment[] = acceptedFiles.map(
          (file) => ({
            id: nanoid(),
            file,
            localUrl: URL.createObjectURL(file),
            status: "uploading",
            filename: file.name,
            mimeType: file.type,
            size: file.size,
          }),
        );

        updateAttachments((prev) => [...prev, ...pendingEntries]);
        for (const pending of pendingEntries) {
          await uploadSingleAttachment(pending);
        }
      },
      [updateAttachments, uploadCommentAttachment, uploadSingleAttachment],
    );

    const handleRetryAttachment = useAsyncCallback(
      async (id: string) => {
        const target = attachmentsRef.current?.find((item) => item.id === id);
        if (!target?.file || !uploadCommentAttachment) return;

        const retryEntry: CommentEditorAttachment = {
          ...target,
          status: "uploading",
          localUrl: URL.createObjectURL(target.file),
        };
        updateAttachments((prev) =>
          prev.map((item) => (item.id === id ? retryEntry : item)),
        );
        await uploadSingleAttachment(retryEntry);
      },
      [updateAttachments, uploadCommentAttachment, uploadSingleAttachment],
    );

    const handleRemoveAttachment = useCallback(
      (id: string) => {
        updateAttachments((prev) => {
          const target = prev.find((item) => item.id === id);
          if (target?.localUrl) {
            URL.revokeObjectURL(target.localUrl);
          }
          return prev.filter((item) => item.id !== id);
        });
      },
      [updateAttachments],
    );

    const handlePaste = useCallback(
      (event: React.ClipboardEvent) => {
        const clipboardItems = event.clipboardData?.items;
        if (!clipboardItems) return;
        const files: File[] = [];
        for (const item of Array.from(clipboardItems)) {
          if (item.kind === "file") {
            const file = item.getAsFile();
            if (file) files.push(file);
          }
        }
        if (files.length > 0) {
          event.preventDefault();
          addAttachments(files);
        }
      },
      [addAttachments],
    );

    const handleDragOver = useCallback(
      (event: React.DragEvent) => {
        if (readonly) return;
        event.preventDefault();
      },
      [readonly],
    );

    const handleDrop = useCallback(
      (event: React.DragEvent) => {
        if (readonly) return;
        event.preventDefault();
        event.stopPropagation();
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length > 0) {
          addAttachments(files);
        }
      },
      [addAttachments, readonly],
    );

    const handleOpenFilePicker = useAsyncCallback(async () => {
      if (uploadLimitReached) return;
      const files = await openFilesWith("Any");
      if (files) {
        addAttachments(files);
      }
    }, [addAttachments, uploadLimitReached]);

    const openImagePreview = useCallback(
      (imageIndex: number) => {
        if (!attachments) return;
        const images = attachments.filter(isImageAttachment);
        if (imageIndex < 0 || imageIndex >= images.length) return;

        const buildSlide = (idx: number) => {
          const item = images[idx];
          if (!item) return undefined;
          return {
            index: idx,
            url: item.url || item.localUrl || "",
            caption: item.file?.name || `Image ${idx + 1}`,
            previous: idx > 0 ? () => buildSlide(idx - 1) : undefined,
            next:
              idx < images.length - 1 ? () => buildSlide(idx + 1) : undefined,
          };
        };

        const slide = buildSlide(imageIndex);
        if (!slide) return;

        peekViewService.peekView
          .open({
            type: "image-list",
            data: { image: slide, total: images.length },
          })
          .catch((error) => {
            logger.error("Failed to open image preview", { error });
          });
      },
      [attachments, peekViewService],
    );

    const handleAttachmentOpen = useCallback(
      (event: React.MouseEvent, index: number) => {
        event.stopPropagation();
        const attachment = attachments?.[index];
        if (!attachment) return;

        if (isImageAttachment(attachment)) {
          const images = (attachments ?? []).filter(isImageAttachment);
          const imageIndex = images.findIndex(
            (item) => item.id === attachment.id,
          );
          if (imageIndex >= 0) {
            openImagePreview(imageIndex);
          }
          return;
        }

        if (attachment.url) {
          downloadResourceWithUrl(
            attachment.url,
            attachment.filename ?? attachment.file?.name ?? "attachment",
          ).catch((error) => {
            logger.error("Failed to download attachment", { error });
            notify.error({
              title: "Failed to download attachment",
              message: error instanceof Error ? error.message : String(error),
            });
          });
          notify({
            title: "The attachment is being downloaded to your computer.",
          });
        }
      },
      [attachments, openImagePreview],
    );

    const handleCommit = useAsyncCallback(async () => {
      if (readonly || submitDisabled) return;
      onCommit?.();
      updateAttachments((prev) => {
        prev.forEach((item) => {
          if (item.localUrl) URL.revokeObjectURL(item.localUrl);
        });
        return [];
      });
    }, [onCommit, readonly, submitDisabled, updateAttachments]);

    const focusEditor = useAsyncCallback(async () => {
      const host = editorHostRef.current;
      if (!host) return;
      const selection = host.std.selection.value.at(-1) as
        TextSelection | undefined;
      host.std.event.active = true;
      await host.updateComplete;
      if (selection) {
        selectTextModel(
          host.std,
          selection.blockId,
          selection.from.index,
          selection.from.length,
        );
      } else {
        const richTexts = Array.from(
          host.querySelectorAll("rich-text"),
        ) as unknown as RichText[];
        richTexts.at(-1)?.inlineEditor?.focusEnd();
      }
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        getSnapshot: () => (doc ? snapshotHelper.getSnapshot(doc) : null),
        focus: focusEditor,
      }),
      [doc, focusEditor, snapshotHelper],
    );

    useEffect(() => {
      if (!autoFocus || !editorHostRef.current || !doc) return;
      let cancelled = false;
      editorHostRef.current.updateComplete
        .then(() => {
          if (cancelled) return;
          const richText = editorHostRef.current?.querySelector(
            "rich-text",
          ) as unknown as RichText | null;
          if (!richText) return;
          richText.scrollIntoView({ behavior: "smooth", block: "center" });
          richText.focus();
          focusEditor();
        })
        .catch((error) => {
          logger.error("Failed to focus comment editor", { error });
        });
      return () => {
        cancelled = true;
      };
    }, [autoFocus, doc, focusEditor]);

    useEffect(() => {
      if (!doc) return;
      const subscription = doc.slots.blockUpdated.subscribe(() => {
        if (onChange) {
          const snapshot = snapshotHelper.getSnapshot(doc);
          if (snapshot) onChange(snapshot);
        }
        setEmpty(snapshotHelper.isDocEmpty(doc));
      });
      return () => {
        subscription?.unsubscribe();
      };
    }, [doc, onChange, snapshotHelper]);

    useEffect(() => {
      return () => {
        attachmentsRef.current?.forEach((item) => {
          if (item.localUrl) URL.revokeObjectURL(item.localUrl);
        });
      };
    }, []);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent) => {
        if (readonly) return;
        if (!editorHostRef.current?.contains(document.activeElement)) return;
        if (event.key === "Enter" && !(event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          event.stopPropagation();
          handleCommit();
        }
      },
      [handleCommit, readonly],
    );

    const handleSurfaceClick = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        focusEditor();
      },
      [focusEditor],
    );

    const innerContent = (
      <>
        {portals.map(({ id, portal }) => (
          <Fragment key={id}>{portal}</Fragment>
        ))}

        {attachments && attachments.length > 0 ? (
          <Group data-testid="comment-attachment-preview" w="100%">
            {attachments.map((attachment, index) => (
              <AttachmentPreviewTile
                key={attachment.id}
                attachment={attachment}
                index={index}
                readonly={readonly}
                onOpen={handleAttachmentOpen}
                onRemove={handleRemoveAttachment}
                onRetry={handleRetryAttachment}
              />
            ))}
          </Group>
        ) : null}

        {doc ? (
          <DocumentViewport
            key={doc.id}
            ref={editorHostRef}
            specs={specs}
            doc={doc}
          />
        ) : null}

        {!readonly ? (
          <DialogFooterActions>
            <IconButton
              icon={<AttachmentIcon />}
              aria-label="Add attachment"
              onClick={handleOpenFilePicker}
              disabled={uploadLimitReached}
            />
            <IconButton
              icon={<ArrowUpBigIcon />}
              variant="primary"
              onClick={handleCommit}
              aria-label="Submit comment"
              disabled={submitDisabled}
            />
          </DialogFooterActions>
        ) : null}
      </>
    );

    const sharedContainerProps = {
      onClick: readonly ? undefined : handleSurfaceClick,
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      "data-readonly": Boolean(readonly),
      className: commentEditorViewportClassName,
    };

    if (readonly) {
      return (
        <Stack
          {...sharedContainerProps}
          data-myoxus-ui-role="comment-editor-readonly"
          h="100%"
          style={{ overflow: "hidden" }}
          w="100%"
        >
          {innerContent}
        </Stack>
      );
    }

    return (
      <SurfaceListItem
        {...sharedContainerProps}
        component="div"
        density="compact"
        fullWidth
        gap="var(--mantine-spacing-sm)"
        layout="column"
        role="group"
        data-myoxus-ui-role="comment-editor-composer"
      >
        {innerContent}
      </SurfaceListItem>
    );
  },
);
