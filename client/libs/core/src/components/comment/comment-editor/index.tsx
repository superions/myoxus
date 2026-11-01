import { patchEditorChromeHost } from "@myoxus/core/editor/view-extensions/editor-view/editor-chrome";
import { useLitPortalFactory } from "@myoxus/lit-react";
import type { ReactToLit } from "@myoxus/lit-react";
import { LitDocEditor, type PageEditor } from "@myoxus/core/editor/editors";
import { SnapshotHelper } from "@myoxus/core/modules/comment/services/snapshot-helper";
import type { CommentAttachment } from "@myoxus/core/modules/comment/types";
import { PeekViewService } from "@myoxus/core/modules/peek-view";
import { downloadResourceWithUrl } from "@myoxus/core/utils/resource";
import { DebugLogger } from "@myoxus/debug";
import { ArrowUpBigIcon, AttachmentIcon, CloseIcon } from "@myoxus/icons/react";
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
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import { type RichText, selectTextModel } from "@virgultum/editor/rich-text";
import { ViewportElementExtension } from "@virgultum/editor/shared/services";
import { openFilesWith } from "@virgultum/editor/shared/utils";
import { type DocSnapshot, nanoid, Store } from "@virgultum/editor/store";
import type { TextSelection } from "@virgultum/std";
import { formatByteSize } from "@virgultum/global/utils";
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

const usePatchSpecs = (readonly: boolean, reactToLit: ReactToLit) => {
  const framework = useFramework();
  // const confirmModal = useConfirmModal();

  const patchedSpecs = useMemo(() => {
    const manager = getCommentEditorViewManager(framework);
    return manager
      .get(readonly ? "preview-page" : "page")
      .concat([
        ViewportElementExtension(`.${commentEditorViewportClassName}`),
        ...(!readonly ? [patchEditorChromeHost(reactToLit)] : []),
      ]);
  }, [framework, readonly, reactToLit]);

  return patchedSpecs;
};

interface EditorAttachment extends CommentAttachment {
  status?: "uploading" | "success" | "error";
  file?: File;
  localUrl?: string; // for previewing
}

interface CommentEditorProps {
  readonly?: boolean;
  doc?: Store;
  defaultSnapshot?: DocSnapshot;
  // for performance, we only update the snapshot when the editor blurs
  onChange?: (snapshot: DocSnapshot) => void;
  onCommit?: () => void;
  onCancel?: () => void;

  /**
   * upload comment attachment to the server
   * @param file
   * @returns remote url of the attachment
   */
  uploadCommentAttachment?: (id: string, file: File) => Promise<string>;
  autoFocus?: boolean;
  attachments?: EditorAttachment[];
  onAttachmentsChange?: (atts: EditorAttachment[]) => void;
}

export interface CommentEditorRef {
  getSnapshot: () => DocSnapshot | null | undefined;
  focus: () => void;
}

// todo: get rid of circular data changes
const useSnapshotDoc = (
  defaultSnapshotOrDoc: DocSnapshot | Store,
  readonly?: boolean,
) => {
  const snapshotHelper = useService(SnapshotHelper);
  const [doc, setDoc] = useState<Store | undefined>(
    defaultSnapshotOrDoc instanceof Store ? defaultSnapshotOrDoc : undefined,
  );

  useEffect(() => {
    if (defaultSnapshotOrDoc instanceof Store) {
      return;
    }

    snapshotHelper
      .createStore(defaultSnapshotOrDoc)
      .then((d) => {
        if (d) {
          setDoc(d);
          d.readonly = readonly ?? false;
        }
      })
      .catch((e) => {
        console.error(e);
      });
  }, [defaultSnapshotOrDoc, readonly, snapshotHelper]);

  return doc;
};

const isImageAttachment = (att: EditorAttachment) => {
  const type = att.mimeType || att.file?.type || "";
  if (type) return type.startsWith("image/");
  return !!att.url && /\.(png|jpe?g|gif|webp|svg)$/i.test(att.url);
};

const AttachmentPreviewItem: React.FC<{
  attachment: EditorAttachment;
  index: number;
  readonly?: boolean;
  handleAttachmentClick: (e: React.MouseEvent, index: number) => void;
  handleAttachmentRemove: (id: string) => void;
}> = ({
  attachment,
  index,
  readonly,
  handleAttachmentClick,
  handleAttachmentRemove,
}) => {
  const isImg = isImageAttachment(attachment);
  const Icon = !isImg
    ? getAttachmentFileIconRC(
        attachment.mimeType ||
          attachment.file?.type ||
          attachment.filename?.split(".").pop() ||
          "none",
      )
    : undefined;
  const previewUrl = attachment.localUrl ?? attachment.url ?? "";

  return (
    <SurfaceListAction
      key={attachment.id}
      aria-label={attachment.filename || attachment.file?.name || "Attachment"}
      component="div"
      mediaPreview={isImg ? "image" : "file"}
      overlayAction={
        !readonly ? (
          <IconButton
            size="xs"
            loading={attachment.status === "uploading"}
            variant="danger"
            onClick={(e) => {
              e.stopPropagation();
              handleAttachmentRemove(attachment.id);
            }}
            icon={<CloseIcon />}
          />
        ) : undefined
      }
      role="button"
      surface
      tabIndex={0}
      onClick={(e) => handleAttachmentClick(e, index)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.currentTarget.click();
      }}
    >
      {isImg ? (
        <MediaPreviewFrame fit="cover">
          {previewUrl ? (
            <MediaPreviewImage
              alt={attachment.filename || attachment.file?.name || "Attachment"}
              fit="cover"
              src={previewUrl}
            />
          ) : (
            <MediaPreviewIcon aria-label="Image attachment preview unavailable">
              <AttachmentIcon />
            </MediaPreviewIcon>
          )}
        </MediaPreviewFrame>
      ) : (
        <Group align="center" miw={0} w="100%">
          {Icon ? (
            <MediaPreviewIcon previewSize="file">
              <Icon />
            </MediaPreviewIcon>
          ) : null}
          <Stack miw={0}>
            <MyoxusText truncate typographySlot="body-small">
              {attachment.filename || attachment.file?.name || "File"}
            </MyoxusText>
            <MyoxusText tone="secondary" truncate typographySlot="caption">
              {attachment.size ? formatByteSize(attachment.size) : ""}
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
    const defaultSnapshotOrDoc = defaultSnapshot ?? userDoc;
    if (!defaultSnapshotOrDoc) {
      throw new Error("Either defaultSnapshot or doc must be provided");
    }
    const [reactToLit, portals] = useLitPortalFactory();
    const specs = usePatchSpecs(!!readonly, reactToLit);
    const doc = useSnapshotDoc(defaultSnapshotOrDoc, readonly);
    const snapshotHelper = useService(SnapshotHelper);
    const peekViewService = useService(PeekViewService);
    const editorRef = useRef<PageEditor>(null);
    const [empty, setEmpty] = useState(true);
    const attachmentsRef = useRef(attachments);
    attachmentsRef.current = attachments;

    const setAttachments = useCallback(
      (updater: (prev: EditorAttachment[]) => EditorAttachment[]) => {
        // Upload completions must update the current draft, not their initial render.
        const next = updater(attachmentsRef.current ?? []);
        attachmentsRef.current = next;
        onAttachmentsChange?.(next);
      },
      [onAttachmentsChange],
    );

    const isUploadDisabled = (attachments?.length ?? 0) >= MAX_ATTACHMENT_COUNT;
    const uploadingAttachments = attachments?.some(
      (att) => att.status === "uploading",
    );
    const commitDisabled =
      (empty && (attachments?.length ?? 0) === 0) || uploadingAttachments;

    const addAttachments = useAsyncCallback(
      async (files: File[]) => {
        if (!uploadCommentAttachment) return;
        const remaining = MAX_ATTACHMENT_COUNT - (attachments?.length ?? 0);
        const valid = files.slice(0, remaining);
        if (!valid.length) return;
        logger.info("addAttachments", { files: valid });

        const pendingAttachments: EditorAttachment[] = valid.map((f) => ({
          id: nanoid(),
          file: f,
          localUrl: URL.createObjectURL(f),
          status: "uploading",
          filename: f.name,
          mimeType: f.type,
        }));

        setAttachments((prev) => [...prev, ...pendingAttachments]);

        for (const pending of pendingAttachments) {
          if (!pending.file) continue; // should not happen
          try {
            const remoteUrl = await uploadCommentAttachment(
              pending.id,
              pending.file,
            );
            logger.info("uploadCommentAttachment success", {
              remoteUrl,
            });
            pending.localUrl && URL.revokeObjectURL(pending.localUrl);
            setAttachments((prev) => {
              const index = prev.findIndex((att) => att.id === pending.id);
              if (index === -1) return prev;
              // create a shallow copy to trigger re-render
              const next = [...prev];
              next[index] = {
                ...next[index],
                status: "success",
                url: remoteUrl,
                localUrl: undefined,
              };
              return next;
            });
          } catch (e: unknown) {
            logger.error("uploadCommentAttachment failed", { error: e });
            notify.error({
              title: "Failed to upload attachment",
              message: e instanceof Error ? e.message : String(e),
            });
            pending.localUrl && URL.revokeObjectURL(pending.localUrl);
            setAttachments((prev) => {
              const index = prev.findIndex((att) => att.id === pending.id);
              if (index === -1) return prev;
              const next = [...prev];
              next[index] = {
                ...next[index],
                status: "error",
                localUrl: undefined,
              };
              return next;
            });
          }
        }
      },
      [attachments?.length, setAttachments, uploadCommentAttachment],
    );

    const handlePaste = useCallback(
      (event: React.ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        const files: File[] = [];
        for (const index in items) {
          const item = items[index as any];
          if (item.kind === "file") {
            const blob = item.getAsFile();
            if (blob) files.push(blob);
          }
        }
        if (files.length) {
          event.preventDefault();
          addAttachments(files);
        }
      },
      [addAttachments],
    );

    const handleDragOver = useCallback(
      (e: React.DragEvent) => {
        if (readonly) return;
        // Prevent default to allow drop
        e.preventDefault();
      },
      [readonly],
    );

    const handleDrop = useCallback(
      (e: React.DragEvent) => {
        if (readonly) return;
        e.preventDefault();
        e.stopPropagation();
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length) {
          addAttachments(files);
        }
      },
      [addAttachments, readonly],
    );

    const openFilePicker = useAsyncCallback(async () => {
      if (isUploadDisabled) return;
      const files = await openFilesWith("Any");
      if (files) {
        addAttachments(files);
      }
    }, [isUploadDisabled, addAttachments]);

    const handleAttachmentRemove = useCallback(
      (id: string) => {
        setAttachments((prev) => {
          const att = prev.find((att) => att.id === id);
          if (att?.localUrl) URL.revokeObjectURL(att.localUrl);
          return prev.filter((att) => att.id !== id);
        });
      },
      [setAttachments],
    );

    const handleImagePreview = useCallback(
      (index: number) => {
        if (!attachments) return;
        const imageAttachments = attachments.filter(isImageAttachment);

        if (index >= imageAttachments.length) return;

        const getImageData = (currentIndex: number) => {
          const attachment = imageAttachments[currentIndex];
          if (!attachment) return undefined;

          return {
            index: currentIndex,
            url: attachment.url || attachment.localUrl || "",
            caption: attachment.file?.name || `Image ${currentIndex + 1}`,
            previous:
              currentIndex > 0
                ? () => getImageData(currentIndex - 1)
                : undefined,
            next:
              currentIndex < imageAttachments.length - 1
                ? () => getImageData(currentIndex + 1)
                : undefined,
          };
        };

        const imageData = getImageData(index);
        if (!imageData) return;

        peekViewService.peekView
          .open({
            type: "image-list",
            data: {
              image: imageData,
              total: imageAttachments.length,
            },
          })
          .catch((error) => {
            console.error("Failed to open image preview", error);
          });
      },
      [attachments, peekViewService],
    );

    const handleAttachmentClick = useCallback(
      (e: React.MouseEvent, index: number) => {
        e.stopPropagation();
        if (!attachments) return;
        const att = attachments[index];
        if (!att) return;
        if (isImageAttachment(att)) {
          // translate attachment index to image index
          const imageAttachments = attachments.filter(isImageAttachment);
          const imageIndex = imageAttachments.findIndex((i) => i.id === att.id);
          if (imageIndex >= 0) {
            handleImagePreview(imageIndex);
          }
        } else if (att.url) {
          // todo: open attachment preview. for now, just download it
          downloadResourceWithUrl(
            att.url,
            att.filename ?? att.file?.name ?? "attachment",
          ).catch((e) => {
            console.error("Failed to download attachment", e);
            notify.error({
              title: "Failed to download attachment",
              message: e.message,
            });
          });
          notify({
            title: "The attachment is being downloaded to your computer.",
          });
        }
      },
      [attachments, handleImagePreview],
    );

    // upload attachments and call original onCommit
    const handleCommit = useAsyncCallback(async () => {
      if (readonly || commitDisabled) return;
      onCommit?.();
      setAttachments((prev) => {
        prev.forEach(
          (att) => att.localUrl && URL.revokeObjectURL(att.localUrl),
        );
        return [];
      });
    }, [readonly, commitDisabled, onCommit, setAttachments]);

    const focusEditor = useAsyncCallback(async () => {
      if (editorRef.current) {
        const selectionService = editorRef.current.std.selection;
        const selection = selectionService.value.at(-1) as TextSelection;
        editorRef.current.std.event.active = true;
        await editorRef.current.host?.updateComplete;
        if (selection) {
          selectTextModel(
            editorRef.current.std,
            selection.blockId,
            selection.from.index,
            selection.from.length,
          );
        } else {
          const richTexts = Array.from(
            editorRef.current?.querySelectorAll("rich-text") ?? [],
          ) as unknown as RichText[];

          const lastRichText = richTexts.at(-1);
          if (lastRichText) {
            lastRichText.inlineEditor?.focusEnd();
          }
        }
      }
    }, [editorRef]);

    useImperativeHandle(
      ref,
      () => ({
        getSnapshot: () => {
          if (!doc) {
            return null;
          }
          return snapshotHelper.getSnapshot(doc);
        },
        focus: focusEditor,
      }),
      [doc, focusEditor, snapshotHelper],
    );

    useEffect(() => {
      let cancel = false;
      if (autoFocus && editorRef.current && doc) {
        // Wait for editor to be fully loaded before focusing
        editorRef.current.updateComplete
          .then(async () => {
            if (cancel) return;
            const richText = editorRef.current?.querySelector(
              "rich-text",
            ) as unknown as RichText;
            if (!richText) return;
            richText.scrollIntoView({
              behavior: "smooth",
              block: "center",
            });
            // Finally focus the inline editor
            richText.focus();
            focusEditor();
          })
          .catch(console.error);
      }
      return () => {
        cancel = true;
      };
    }, [autoFocus, doc, focusEditor]);

    useEffect(() => {
      if (doc) {
        const subscription = doc.slots.blockUpdated.subscribe(() => {
          if (onChange) {
            const snapshot = snapshotHelper.getSnapshot(doc);
            if (snapshot) {
              onChange?.(snapshot);
            }
          }
          setEmpty(snapshotHelper.isDocEmpty(doc));
        });
        return () => {
          subscription?.unsubscribe();
        };
      }
      return;
    }, [doc, onChange, snapshotHelper]);

    // Add keydown handler to commit on Enter key
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent) => {
        if (readonly) return;

        // Only handle Enter if focus is within the editor
        const activeElement = document.activeElement;
        if (!editorRef.current?.contains(activeElement)) return;

        // If Enter is pressed without CMD/CTRL key, commit the comment
        if (e.key === "Enter" && !(e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          e.stopPropagation();
          handleCommit();
        }
      },
      [handleCommit, readonly],
    );

    const handleClickEditor = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        focusEditor();
      },
      [focusEditor],
    );

    useEffect(() => {
      return () => {
        // Cleanup any remaining local URLs on unmount
        attachmentsRef.current?.forEach((att) => {
          if (att.localUrl) URL.revokeObjectURL(att.localUrl);
        });
      };
    }, []);

    const editorContent = (
      <>
        {portals.map(({ id, portal }) => (
          <Fragment key={id}>{portal}</Fragment>
        ))}
        {attachments?.length && attachments.length > 0 ? (
          <Group data-testid="comment-attachment-preview" w="100%">
            {attachments.map((att, index) => (
              <AttachmentPreviewItem
                key={att.id}
                attachment={att}
                index={index}
                readonly={readonly}
                handleAttachmentClick={handleAttachmentClick}
                handleAttachmentRemove={handleAttachmentRemove}
              />
            ))}
          </Group>
        ) : null}

        {doc && (
          <LitDocEditor key={doc.id} ref={editorRef} specs={specs} doc={doc} />
        )}
        {!readonly && (
          <DialogFooterActions>
            <IconButton
              icon={<AttachmentIcon />}
              aria-label="Add attachment"
              onClick={openFilePicker}
              disabled={isUploadDisabled}
            />
            <IconButton
              icon={<ArrowUpBigIcon />}
              variant="primary"
              onClick={handleCommit}
              aria-label="Submit comment"
              disabled={commitDisabled}
            />
          </DialogFooterActions>
        )}
      </>
    );

    const editorProps = {
      onClick: readonly ? undefined : handleClickEditor,
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      onDragOver: handleDragOver,
      onDrop: handleDrop,
      "data-readonly": !!readonly,
      className: commentEditorViewportClassName,
    };

    if (readonly) {
      return (
        <Stack
          {...editorProps}
          data-myoxus-ui-role="comment-editor-readonly"
          h="100%"
          style={{ overflow: "hidden" }}
          w="100%"
        >
          {editorContent}
        </Stack>
      );
    }

    return (
      <SurfaceListItem
        {...editorProps}
        component="div"
        density="compact"
        fullWidth
        gap="var(--mantine-spacing-sm)"
        layout="column"
        role="group"
        data-myoxus-ui-role="comment-editor-composer"
      >
        {editorContent}
      </SurfaceListItem>
    );
  },
);
