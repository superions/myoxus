import { useAsyncCallback } from "@myoxus/core/components/hooks/myoxus-async-hooks";
import {
  ArrowLeftSmallIcon,
  ArrowRightSmallIcon,
  CopyIcon,
  DeleteIcon,
  DownloadIcon,
  MinusIcon,
  PlusIcon,
  ViewBarIcon,
} from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  Button,
  Divider,
  IconButton,
  Loading,
  MediaLightboxCloseButton,
  MyoxusText,
  notify,
  Stack,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type { ImageBlockModel } from "@virgultum/editor/model";
import type { BlockModel, Workspace } from "@virgultum/editor/store";
import {
  forwardRef,
  type ImgHTMLAttributes,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import useSWR from "swr";

import {
  downloadResourceWithUrl,
  resourceUrlToBlob,
} from "../../../../utils/resource";
import { PeekViewService } from "../../services/peek-view";
import { useEditor } from "../utils";
import { useZoomControls } from "./hooks/use-zoom";

export interface ImageData {
  index?: number;
  url: string;
  caption?: string;
  onDelete?: () => void;
  previous?: () => ImageData | undefined;
  next?: () => ImageData | undefined;
}

export interface ImagePreviewData {
  image: ImageData;
  total?: number;
}

export interface ImagePreviewProps extends ImagePreviewData {
  onClose: () => void;
  blobId?: string;
}

async function copyImageToClipboard(url: string) {
  const blob = await resourceUrlToBlob(url);
  if (!blob) {
    return;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    notify({ title: "Copied to clipboard." });
  } catch (error) {
    console.error("Failed to copy image to clipboard", error);
    notify({ title: "Failed to copy image to clipboard." });
  }
}

const GenericImagePreview = forwardRef<
  HTMLImageElement,
  ImgHTMLAttributes<HTMLImageElement>
>(function GenericImagePreview(props, ref) {
  if (!props.src) {
    return <Loading size={24} />;
  }

  return <img data-testid="image-content" ref={ref} {...props} />;
});

export const GenericImagePreviewModal = ({
  image,
  total,
  onClose,
  blobId,
}: ImagePreviewProps): ReactElement => {
  const zoomRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const {
    isZoomedBigger,
    handleDrag,
    handleDragStart,
    handleDragEnd,
    resetZoom,
    zoomIn,
    zoomOut,
    resetScale,
    currentScale,
  } = useZoomControls({ zoomRef, imageRef });

  const downloadHandler = useAsyncCallback(async () => {
    if (!image.url) return;
    const filename = image.caption || "image";
    await downloadResourceWithUrl(image.url, filename);
  }, [image]);

  const copyHandler = useAsyncCallback(async () => {
    if (!image.url) return;
    await copyImageToClipboard(image.url);
  }, [image.url]);

  useEffect(() => {
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft" && image.previous) {
        image.previous();
      } else if (event.key === "ArrowRight" && image.next) {
        image.next();
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const onCopyEvent = (event: ClipboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      copyHandler();
    };

    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("copy", onCopyEvent);
    return () => {
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("copy", onCopyEvent);
    };
  }, [copyHandler, image]);

  return (
    <div data-testid="image-preview-modal" data-myoxus-ui-role="media-lightbox">
      <div
        data-myoxus-ui-role="media-lightbox-dismiss-layer"
        onClick={onClose}
      />
      <div data-myoxus-ui-role="media-lightbox-stage">
        <div
          data-myoxus-ui-role="media-lightbox-zoom-area"
          data-zoom-state={isZoomedBigger ? "larger" : "fit"}
          ref={zoomRef}
        >
          <div data-myoxus-ui-role="media-lightbox-center">
            <GenericImagePreview
              data-blob-id={blobId}
              src={image.url}
              alt={image.caption}
              data-testid="image-content"
              tabIndex={0}
              ref={imageRef}
              draggable={isZoomedBigger}
              onMouseDown={handleDragStart}
              onMouseMove={handleDrag}
              onMouseUp={handleDragEnd}
              onLoad={resetZoom}
            />
            {isZoomedBigger ? null : (
              <MyoxusText
                component="p"
                data-testid="image-caption-zoomedout"
                data-myoxus-ui-role="media-lightbox-caption"
                textAlign="center"
                typographySlot="body-small"
              >
                {image.caption}
              </MyoxusText>
            )}
          </div>
        </div>
      </div>

      <Stack align="center" data-myoxus-ui-role="media-lightbox-bottom">
        {isZoomedBigger && image.caption ? (
          <MyoxusText
            component="p"
            data-testid="image-caption-zoomedin"
            data-myoxus-ui-role="media-lightbox-floating-caption"
            textAlign="center"
            typographySlot="body-small"
          >
            {image.caption}
          </MyoxusText>
        ) : null}
        <ToolbarSurface
          compact
          justify="center"
          data-myoxus-ui-role="media-lightbox-toolbar"
        >
          <IconButton
            data-testid="previous-image-button"
            tooltip="Previous"
            icon={<ArrowLeftSmallIcon />}
            disabled={!image.previous}
            onClick={image.previous}
          />
          {image.index != null && total != null && (
            <MyoxusText
              data-myoxus-ui-role="media-lightbox-counter"
              typographySlot="body-small"
            >
              {`${image.index + 1}/${total}`}
            </MyoxusText>
          )}
          <IconButton
            data-testid="next-image-button"
            tooltip="Next"
            icon={<ArrowRightSmallIcon />}
            disabled={!image.next}
            onClick={image.next}
          />
          <Divider size="thinner" orientation="vertical" />
          <IconButton
            data-testid="fit-to-screen-button"
            tooltip="Fit to screen"
            icon={<ViewBarIcon />}
            onClick={() => resetZoom()}
          />
          <IconButton
            data-testid="zoom-out-button"
            tooltip="Zoom out"
            icon={<MinusIcon />}
            onClick={zoomOut}
          />
          <Button
            data-testid="reset-scale-button"
            tooltip="Reset scale"
            onClick={resetScale}
            variant="plain"
            data-myoxus-ui-role="media-lightbox-scale-button"
          >
            {`${(currentScale * 100).toFixed(0)}%`}
          </Button>
          <IconButton
            data-testid="zoom-in-button"
            tooltip="Zoom in"
            icon={<PlusIcon />}
            onClick={zoomIn}
          />
          <Divider size="thinner" orientation="vertical" />
          <IconButton
            data-testid="download-button"
            tooltip="Download"
            icon={<DownloadIcon />}
            onClick={downloadHandler}
          />
          <IconButton
            data-testid="copy-to-clipboard-button"
            tooltip="Copy to clipboard"
            icon={<CopyIcon />}
            onClick={copyHandler}
          />
          {image.onDelete && (
            <>
              <Divider size="thinner" orientation="vertical" />
              <IconButton
                data-testid="delete-button"
                tooltip="Delete"
                icon={<DeleteIcon />}
                onClick={image.onDelete}
                variant="danger"
              />
            </>
          )}
        </ToolbarSurface>
      </Stack>
    </div>
  );
};

// Adapter layer
export type ImagePreviewModalProps = {
  docId: string;
  blockId: string;
};

const useImageBlob = (
  docCollection: Workspace,
  docId: string,
  blockId: string,
) => {
  const { data, error, isLoading } = useSWR(
    ["workspace", "image", docId, blockId],
    {
      fetcher: async ([_, __, pageId, blockId]) => {
        const page = docCollection.getDoc(pageId)?.getStore();
        const block = page?.getBlock(blockId);
        if (!block) {
          return null;
        }
        const blockModel = block.model as ImageBlockModel;
        return await docCollection.blobSync.get(
          blockModel.props.sourceId as string,
        );
      },
      suspense: false,
    },
  );

  return { data, error, isLoading };
};

const ImagePreviewModalImpl = ({
  docId,
  blockId,
  onBlockIdChange,
  onClose,
}: ImagePreviewModalProps & {
  onBlockIdChange: (blockId: string) => void;
  onClose: () => void;
}): ReactElement | null => {
  const { doc, workspace } = useEditor(docId);
  const virgultumDoc = doc?.virgultumDoc;
  const docCollection = workspace.docCollection;
  const blockModel = useMemo(() => {
    const block = virgultumDoc?.getBlock(blockId);
    if (!block) {
      return null;
    }
    return block.model as ImageBlockModel;
  }, [blockId, virgultumDoc]);

  const {
    data: blobData,
    error,
    isLoading,
  } = useImageBlob(docCollection, docId, blockId);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    let blobUrl = null;
    if (blobData) {
      blobUrl = URL.createObjectURL(blobData);
      setBlobUrl(blobUrl);
    }
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [blobData]);

  const [blocks, setBlocks] = useState<ImageBlockModel[]>([]);
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    if (!blockModel || !virgultumDoc) {
      return;
    }

    const prevs = virgultumDoc.getPrevs(blockModel).filter(filterImageBlock);
    const nexts = virgultumDoc.getNexts(blockModel).filter(filterImageBlock);

    const blocks = [...prevs, blockModel, ...nexts];
    setBlocks(blocks);
    setCursor(blocks.length ? prevs.length : 0);
  }, [blockModel, virgultumDoc]);

  if (error || !blobUrl || isLoading || !blockModel) {
    return null;
  }

  const createImageData = (index: number): ImageData => {
    const prevBlock = blocks[index - 1];
    const nextBlock = blocks[index + 1];
    return {
      index,
      url: blobUrl,
      caption: blockModel.props.caption,
      onDelete: !blockModel.store.readonly
        ? () => {
            handleDelete();
          }
        : undefined,
      previous: prevBlock
        ? () => {
            onBlockIdChange(prevBlock.id);
            return createImageData(index - 1);
          }
        : undefined,
      next: nextBlock
        ? () => {
            onBlockIdChange(nextBlock.id);
            return createImageData(index + 1);
          }
        : undefined,
    };
  };

  const imageData: ImageData = createImageData(cursor);

  const handleDelete = () => {
    if (!virgultumDoc) {
      return;
    }

    const currentBlock = blocks[cursor];
    if (!currentBlock) return;

    const newBlocks = blocks.toSpliced(cursor, 1);
    setBlocks(newBlocks);
    virgultumDoc.deleteBlock(currentBlock);

    let nextBlock = newBlocks[cursor];

    if (!nextBlock) {
      const prevIndex = cursor - 1;
      nextBlock = newBlocks[prevIndex];

      if (!nextBlock) {
        onClose();
        return;
      }

      setCursor(prevIndex);
    }

    onBlockIdChange(nextBlock.id);
  };

  return (
    <GenericImagePreviewModal
      total={blocks.length}
      image={imageData}
      onClose={onClose}
      blobId={blockId}
    />
  );
};

const filterImageBlock = (block: BlockModel): block is ImageBlockModel => {
  return block.flavour === "myoxus:image";
};

export const ImagePreviewPeekView = (
  props: ImagePreviewModalProps,
): ReactElement | null => {
  const [blockId, setBlockId] = useState<string | null>(props.blockId);
  const peekView = useService(PeekViewService).peekView;
  const onClose = useCallback(() => peekView.close(), [peekView]);

  useEffect(() => {
    setBlockId(props.blockId);
  }, [props.blockId]);

  return (
    <>
      {blockId ? (
        <ImagePreviewModalImpl
          {...props}
          onClose={onClose}
          blockId={blockId}
          onBlockIdChange={setBlockId}
        />
      ) : null}
      <MediaLightboxCloseButton
        data-testid="image-preview-close-button"
        onClick={onClose}
      />
    </>
  );
};

export const GenericImagePreviewModalWithClose = (
  props: Omit<ImagePreviewProps, "onClose">,
) => {
  const peekViewService = useService(PeekViewService);
  const handleClose = useCallback(() => {
    peekViewService.peekView.close();
  }, [peekViewService]);

  const [image, setImage] = useState<ImageData>(props.image);

  const prevImage = useCallback(() => {
    const prev = image.previous?.();
    if (!prev) return;
    setImage(prev);
    return prev;
  }, [image]);

  const nextImage = useCallback(() => {
    const next = image.next?.();
    if (!next) return;
    setImage(next);
    return next;
  }, [image]);
  return (
    <>
      <GenericImagePreviewModal
        total={props.total}
        image={{
          index: image.index,
          url: image.url,
          caption: image.caption,
          onDelete: image.onDelete,
          previous: prevImage,
          next: nextImage,
        }}
        onClose={handleClose}
      />
      <MediaLightboxCloseButton
        data-testid="image-preview-close-button"
        onClick={handleClose}
      />
    </>
  );
};
