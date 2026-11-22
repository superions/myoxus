import { BlobManagementService } from "@myoxus/core/modules/blob-management/services";
import { useI18n } from "@myoxus/i18n";
import { DeleteIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import type { ListedBlobRecord } from "@myoxus/storage";
import track from "@myoxus/track";
import { getAttachmentFileIcon } from "@virgultum/editor/components/icons";
import { formatByteSize } from "@virgultum/core/primitives/utils";
import type { KeyboardEvent, MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  Button,
  Checkbox,
  ErrorMessage,
  Loading,
  MediaPreviewFrame,
  MediaPreviewIcon,
  MediaPreviewImage,
  notify,
  Pagination,
  ResponsiveGrid,
  SettingsControlEmpty,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsToolbar,
  Stack,
  SurfaceListItem,
  SurfaceListItemFrame,
  templateToString,
  useConfirmModal,
  useDisposable,
} from "../../primitives";

const Empty = () => {
  const t = useI18n();
  return (
    <SettingsControlEmpty data-testid="workspace-storage-unused-blobs-empty">
      {t["com.myoxus.settings.workspace.storage.unused-blobs.empty"]()}
    </SettingsControlEmpty>
  );
};

const useBlob = (blobRecord: ListedBlobRecord) => {
  const unusedBlobsEntity = useService(BlobManagementService).unusedBlobs;
  return useDisposable(
    (abortSignal?: AbortSignal) =>
      unusedBlobsEntity.hydrateBlob(blobRecord, abortSignal),
    [blobRecord],
  );
};

const BlobPreview = ({
  blobRecord,
  selected,
}: {
  blobRecord: ListedBlobRecord;
  selected: boolean;
}) => {
  const { data, loading, error } = useBlob(blobRecord);

  const element = useMemo(() => {
    if (loading) return <Loading />;
    if (!data?.url || !data.type) return null;

    const { url, type, mime } = data;

    const icon = templateToString(getAttachmentFileIcon(type));

    if (error) {
      return (
        <MediaPreviewIcon
          dangerouslySetInnerHTML={{ __html: icon }}
          aria-label={blobRecord.key}
        />
      );
    }

    if (mime?.startsWith("image/")) {
      return <MediaPreviewImage src={url} alt={blobRecord.key} />;
    } else {
      return (
        <MediaPreviewIcon
          dangerouslySetInnerHTML={{ __html: icon }}
          aria-label={blobRecord.key}
        />
      );
    }
  }, [loading, data, error, blobRecord.key]);

  return (
    <Stack data-myoxus-ui-role="workspace-blob-preview">
      <MediaPreviewFrame selected={selected}>{element}</MediaPreviewFrame>
      <Stack data-myoxus-ui-role="workspace-blob-preview-meta">
        <SettingsListItemTitle truncate title={blobRecord.key}>
          {blobRecord.key}
        </SettingsListItemTitle>
        <SettingsListItemMeta>
          {data?.type ? `${data.type} · ` : ""}
          {formatByteSize(blobRecord.size)}
        </SettingsListItemMeta>
      </Stack>
    </Stack>
  );
};

const BlobCard = ({
  blobRecord,
  onClick,
  selected,
  onCheckedChange,
  onToggle,
}: {
  blobRecord: ListedBlobRecord;
  onClick: (e: MouseEvent<HTMLElement>) => void;
  onCheckedChange: (checked: boolean) => void;
  onToggle: () => void;
  selected: boolean;
}) => {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    onToggle();
  };

  return (
    <SurfaceListItem
      data-testid="blob-preview-card"
      appearance="card"
      density="compact"
      interactive
      layout="column"
      role="button"
      selected={selected}
      tabIndex={0}
      aria-pressed={selected}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      data-myoxus-ui-role="workspace-blob-card"
    >
      <SettingsToolbar
        justify="flex-end"
        data-myoxus-ui-role="workspace-blob-card-toolbar"
      >
        <Checkbox
          checked={selected}
          aria-label={blobRecord.key}
          onClick={(event) => event.stopPropagation()}
          onChange={(_, checked) => onCheckedChange(checked)}
        />
      </SettingsToolbar>
      <BlobPreview blobRecord={blobRecord} selected={selected} />
    </SurfaceListItem>
  );
};

const PAGE_SIZE = 9;
const UNUSED_BLOBS_UI_TIMEOUT_MS = 10_000;

export const BlobManagementPanel = () => {
  const t = useI18n();

  const unusedBlobsEntity = useService(BlobManagementService).unusedBlobs;
  const unusedBlobsPage = useLiveData(unusedBlobsEntity.unusedBlobs$);
  const total = useLiveData(unusedBlobsEntity.total$);
  const isLoading = useLiveData(unusedBlobsEntity.isLoading$);
  const loadError = useLiveData(unusedBlobsEntity.loadError$);
  const [scanTimedOut, setScanTimedOut] = useState(false);
  const [pageNum, setPageNum] = useState(0);
  const [selectionAnchor, setSelectionAnchor] =
    useState<ListedBlobRecord | null>(null);

  useEffect(() => {
    unusedBlobsEntity.revalidate({
      offset: pageNum * PAGE_SIZE,
      first: PAGE_SIZE,
    });
  }, [unusedBlobsEntity, pageNum]);
  useEffect(() => {
    setPageNum((p) =>
      Math.min(p, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)),
    );
  }, [total]);

  useEffect(() => {
    if (!isLoading) {
      setScanTimedOut(false);
      return;
    }

    // A blocked sync must not leave the settings panel spinning indefinitely.
    const timeout = setTimeout(
      () => setScanTimedOut(true),
      UNUSED_BLOBS_UI_TIMEOUT_MS,
    );
    return () => clearTimeout(timeout);
  }, [isLoading]);

  const [selectedBlobs, setSelectedBlobs] = useState<ListedBlobRecord[]>([]);
  const [deleting, setDeleting] = useState(false);

  const handleSelectBlob = useCallback((blob: ListedBlobRecord) => {
    setSelectedBlobs((prev) => {
      if (prev.some((b) => b.key === blob.key)) {
        return prev;
      }
      return [...prev, blob];
    });
  }, []);

  const handleUnselectBlob = useCallback((blob: ListedBlobRecord) => {
    setSelectedBlobs((prev) => prev.filter((b) => b.key !== blob.key));
  }, []);

  const handleBlobClick = useCallback(
    (blob: ListedBlobRecord, event: MouseEvent<HTMLElement>) => {
      const isMetaKey = event.metaKey || event.ctrlKey;

      if (event.shiftKey && selectionAnchor) {
        // Shift+click: Select range from anchor to current
        const anchorIndex = unusedBlobsPage.findIndex(
          (b) => b.key === selectionAnchor.key,
        );
        const currentIndex = unusedBlobsPage.findIndex(
          (b) => b.key === blob.key,
        );

        if (anchorIndex !== -1 && currentIndex !== -1) {
          const start = Math.min(anchorIndex, currentIndex);
          const end = Math.max(anchorIndex, currentIndex);
          const blobsToSelect = unusedBlobsPage.slice(start, end + 1);

          setSelectedBlobs((prev) => {
            // If meta/ctrl is also pressed, add to existing selection
            const baseSelection = isMetaKey ? prev : [];
            return [
              ...new Map(
                [...baseSelection, ...blobsToSelect].map((b) => [b.key, b]),
              ).values(),
            ];
          });
        }
      } else {
        if (selectedBlobs.some((b) => b.key === blob.key)) {
          handleUnselectBlob(blob);
        } else {
          handleSelectBlob(blob);
        }
        if (selectedBlobs.length === 0) {
          setSelectionAnchor(
            selectedBlobs.some((b) => b.key === blob.key) ? null : blob,
          );
        }
      }
    },
    [
      selectionAnchor,
      unusedBlobsPage,
      selectedBlobs,
      handleSelectBlob,
      handleUnselectBlob,
    ],
  );

  const handleSelectAll = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      unusedBlobsPage.forEach((blob) => handleSelectBlob(blob));
    },
    [unusedBlobsPage, handleSelectBlob],
  );

  const showSelectAll = !unusedBlobsPage.every((blob) =>
    selectedBlobs.some((b) => b.key === blob.key),
  );

  const { openConfirmModal } = useConfirmModal();

  const handleDeleteSelectedBlobs = useCallback(
    (e: MouseEvent<HTMLElement>) => {
      e.stopPropagation();
      const currentSelectedBlobs = selectedBlobs;
      openConfirmModal({
        title:
          t[
            "com.myoxus.settings.workspace.storage.unused-blobs.delete.title"
          ](),
        children:
          t[
            "com.myoxus.settings.workspace.storage.unused-blobs.delete.warning"
          ](),
        onConfirm: async () => {
          setDeleting(true);
          track.$.settingsPanel.workspace.deleteUnusedBlob();
          try {
            for (const blob of currentSelectedBlobs) {
              await unusedBlobsEntity.deleteBlob(blob.key, true);
              handleUnselectBlob(blob);
            }
          } catch {
            notify.error({
              title: t["com.myoxus.settings.common.load-error"](),
            });
          } finally {
            setDeleting(false);
            unusedBlobsEntity.revalidate({
              offset: pageNum * PAGE_SIZE,
              first: PAGE_SIZE,
            });
          }
        },
        confirmText: t["Delete"](),
        cancelText: t["Cancel"](),
        confirmButtonOptions: {
          variant: "error",
        },
      });
    },
    [
      selectedBlobs,
      openConfirmModal,
      t,
      unusedBlobsEntity,
      handleUnselectBlob,
      pageNum,
    ],
  );

  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (panelRef.current) {
      const unselectBlobs = (e: globalThis.MouseEvent) => {
        const target = e.target as HTMLElement;
        if (
          panelRef.current &&
          !e.composedPath().includes(panelRef.current) &&
          !target.closest('[role="dialog"]')
        ) {
          setSelectedBlobs([]);
        }
      };
      document.addEventListener("click", unselectBlobs);
      return () => {
        document.removeEventListener("click", unselectBlobs);
      };
    }
    return;
  }, []);

  const isEmpty = total === 0 && !isLoading;
  const showLoadError = !!loadError || scanTimedOut;

  return (
    <Stack ref={panelRef} data-myoxus-ui-role="workspace-blob-management">
      {selectedBlobs.length > 0 && !isLoading && !showLoadError ? (
        <SettingsToolbar
          layout="split"
          data-myoxus-ui-role="workspace-blob-management-selection-toolbar"
        >
          <SettingsListItemTitle>
            {`${selectedBlobs.length} ${t["com.myoxus.settings.workspace.storage.unused-blobs.selected"]()}`}
          </SettingsListItemTitle>
          <SettingsToolbar data-myoxus-ui-role="workspace-blob-management-selection-actions">
            {showSelectAll && (
              <Button onClick={handleSelectAll} variant="primary">
                {t["com.myoxus.keyboardShortcuts.selectAll"]()}
              </Button>
            )}
            <Button
              loading={deleting}
              onClick={handleDeleteSelectedBlobs}
              prefix={<DeleteIcon />}
              disabled={deleting}
              variant="error"
            >
              {t["Delete"]()}
            </Button>
          </SettingsToolbar>
        </SettingsToolbar>
      ) : null}
      {showLoadError ? (
        <ErrorMessage
          data-testid="workspace-storage-unused-blobs-error"
          role="alert"
        >
          {t["com.myoxus.settings.common.load-error"]()}
        </ErrorMessage>
      ) : isEmpty ? (
        <Empty />
      ) : (
        <Stack data-myoxus-ui-role="workspace-blob-management-surface">
          {isLoading ? (
            <Stack
              data-testid="workspace-storage-unused-blobs-loading"
              data-myoxus-ui-role="workspace-blob-loading"
            >
              <Loading />
            </Stack>
          ) : (
            <>
              <SurfaceListItemFrame
                data-testid="workspace-storage-unused-blobs-grid"
                data-myoxus-ui-role="workspace-blob-grid-frame"
              >
                <ResponsiveGrid data-myoxus-ui-role="workspace-blob-grid">
                  {unusedBlobsPage.map((blob) => {
                    const selected = selectedBlobs.some(
                      (b) => b.key === blob.key,
                    );
                    const toggleBlob = () => {
                      if (selected) {
                        handleUnselectBlob(blob);
                      } else {
                        handleSelectBlob(blob);
                        setSelectionAnchor(blob);
                      }
                    };
                    return (
                      <BlobCard
                        key={blob.key}
                        blobRecord={blob}
                        onClick={(e) => handleBlobClick(blob, e)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            handleSelectBlob(blob);
                            setSelectionAnchor(blob);
                          } else {
                            handleUnselectBlob(blob);
                            if (selectionAnchor?.key === blob.key) {
                              setSelectionAnchor(null);
                            }
                          }
                        }}
                        onToggle={toggleBlob}
                        selected={selected}
                      />
                    );
                  })}
                </ResponsiveGrid>
              </SurfaceListItemFrame>
              {total > PAGE_SIZE && (
                <Pagination
                  pageNum={pageNum}
                  totalCount={total}
                  countPerPage={PAGE_SIZE}
                  onPageChange={(_, pageNum) => {
                    setPageNum(pageNum);
                  }}
                />
              )}
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
};
