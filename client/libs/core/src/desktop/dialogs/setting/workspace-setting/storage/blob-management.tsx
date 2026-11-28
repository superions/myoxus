// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { BlobManagementService } from "@myoxus/core/modules/blob-management/services";
import { useI18n } from "@myoxus/i18n";
import { DeleteIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import type { ListedBlobRecord } from "@myoxus/storage";
import track from "@myoxus/track";
import { formatByteSize } from "@virgultum/core/primitives/utils";
import { getAttachmentFileIconRC } from "@virgultum/editor/components/icons";
import {
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  useConfirmModal,
  useDisposable,
} from "../../primitives";

const PAGE_SIZE = 9;
const SCAN_TIMEOUT_MS = 10_000;

function BlobPreview({
  blobRecord,
  selected,
}: {
  blobRecord: ListedBlobRecord;
  selected: boolean;
}) {
  const unusedBlobs = useService(BlobManagementService).unusedBlobs;
  const { data, loading, error } = useDisposable(
    (abortSignal?: AbortSignal) =>
      unusedBlobs.hydrateBlob(blobRecord, abortSignal),
    [blobRecord],
  );

  const previewNode = useMemo(() => {
    if (loading) return <Loading />;
    if (!data?.url || !data.type) return null;

    const Icon = getAttachmentFileIconRC(data.type);
    if (!error && data.mime?.startsWith("image/")) {
      return <MediaPreviewImage src={data.url} alt={blobRecord.key} />;
    }
    return (
      <MediaPreviewIcon aria-label={blobRecord.key}>
        <Icon />
      </MediaPreviewIcon>
    );
  }, [blobRecord.key, data, error, loading]);

  return (
    <Stack data-myoxus-ui-role="workspace-blob-preview">
      <MediaPreviewFrame selected={selected}>{previewNode}</MediaPreviewFrame>
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
}

function BlobCard({
  blobRecord,
  selected,
  onClick,
  onCheckedChange,
  onToggle,
}: {
  blobRecord: ListedBlobRecord;
  selected: boolean;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  onCheckedChange: (checked: boolean) => void;
  onToggle: () => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
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
}

export const BlobManagementPanel = () => {
  const t = useI18n();
  const unusedBlobs = useService(BlobManagementService).unusedBlobs;
  const { openConfirmModal } = useConfirmModal();

  const pageBlobs = useLiveData(unusedBlobs.unusedBlobs$);
  const total = useLiveData(unusedBlobs.total$);
  const isLoading = useLiveData(unusedBlobs.isLoading$);
  const loadError = useLiveData(unusedBlobs.loadError$);

  const [scanTimedOut, setScanTimedOut] = useState(false);
  const [pageNum, setPageNum] = useState(0);
  const [selectedBlobs, setSelectedBlobs] = useState<ListedBlobRecord[]>([]);
  const [anchorBlob, setAnchorBlob] = useState<ListedBlobRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    unusedBlobs.revalidate({
      offset: pageNum * PAGE_SIZE,
      first: PAGE_SIZE,
    });
  }, [pageNum, unusedBlobs]);

  useEffect(() => {
    setPageNum((current) =>
      Math.min(current, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)),
    );
  }, [total]);

  useEffect(() => {
    if (!isLoading) {
      setScanTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setScanTimedOut(true), SCAN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isLoading]);

  useEffect(() => {
    const handleOutsideClick = (event: globalThis.MouseEvent) => {
      const target = event.target as HTMLElement;
      if (
        panelRef.current &&
        !event.composedPath().includes(panelRef.current) &&
        !target.closest('[role="dialog"]')
      ) {
        setSelectedBlobs([]);
      }
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, []);

  const selectBlob = useCallback((blob: ListedBlobRecord) => {
    setSelectedBlobs((prev) =>
      prev.some((entry) => entry.key === blob.key) ? prev : [...prev, blob],
    );
  }, []);

  const unselectBlob = useCallback((blob: ListedBlobRecord) => {
    setSelectedBlobs((prev) => prev.filter((entry) => entry.key !== blob.key));
  }, []);

  const handleCardClick = useCallback(
    (blob: ListedBlobRecord, event: MouseEvent<HTMLElement>) => {
      if (event.shiftKey && anchorBlob) {
        const anchorIndex = pageBlobs.findIndex(
          (entry) => entry.key === anchorBlob.key,
        );
        const targetIndex = pageBlobs.findIndex(
          (entry) => entry.key === blob.key,
        );
        if (anchorIndex !== -1 && targetIndex !== -1) {
          const slice = pageBlobs.slice(
            Math.min(anchorIndex, targetIndex),
            Math.max(anchorIndex, targetIndex) + 1,
          );
          const mergeExisting = event.metaKey || event.ctrlKey;
          setSelectedBlobs((prev) => {
            const merged = mergeExisting ? [...prev, ...slice] : slice;
            return Array.from(
              new Map(merged.map((entry) => [entry.key, entry])).values(),
            );
          });
          return;
        }
      }

      const alreadySelected = selectedBlobs.some(
        (entry) => entry.key === blob.key,
      );
      if (alreadySelected) {
        unselectBlob(blob);
      } else {
        selectBlob(blob);
      }
      if (selectedBlobs.length === 0) {
        setAnchorBlob(alreadySelected ? null : blob);
      }
    },
    [anchorBlob, pageBlobs, selectBlob, selectedBlobs, unselectBlob],
  );

  const handleSelectAll = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      pageBlobs.forEach((blob) => selectBlob(blob));
    },
    [pageBlobs, selectBlob],
  );

  const handleDeleteSelected = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      const targets = selectedBlobs;
      openConfirmModal({
        title:
          t[
            "com.myoxus.settings.workspace.storage.unused-blobs.delete.title"
          ](),
        children:
          t[
            "com.myoxus.settings.workspace.storage.unused-blobs.delete.warning"
          ](),
        confirmText: t["Delete"](),
        cancelText: t["Cancel"](),
        confirmButtonOptions: { variant: "error" },
        onConfirm: async () => {
          setDeleting(true);
          track.$.settingsPanel.workspace.deleteUnusedBlob();
          try {
            for (const blob of targets) {
              await unusedBlobs.deleteBlob(blob.key, true);
              unselectBlob(blob);
            }
          } catch {
            notify.error({
              title: t["com.myoxus.settings.common.load-error"](),
            });
          } finally {
            setDeleting(false);
            unusedBlobs.revalidate({
              offset: pageNum * PAGE_SIZE,
              first: PAGE_SIZE,
            });
          }
        },
      });
    },
    [openConfirmModal, pageNum, selectedBlobs, t, unselectBlob, unusedBlobs],
  );

  const showLoadError = Boolean(loadError) || scanTimedOut;
  const isEmpty = total === 0 && !isLoading;
  const showSelectAll = !pageBlobs.every((blob) =>
    selectedBlobs.some((entry) => entry.key === blob.key),
  );

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
            {showSelectAll ? (
              <Button onClick={handleSelectAll} variant="primary">
                {t["com.myoxus.keyboardShortcuts.selectAll"]()}
              </Button>
            ) : null}
            <Button
              loading={deleting}
              onClick={handleDeleteSelected}
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
        <SettingsControlEmpty data-testid="workspace-storage-unused-blobs-empty">
          {t["com.myoxus.settings.workspace.storage.unused-blobs.empty"]()}
        </SettingsControlEmpty>
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
                  {pageBlobs.map((blob) => {
                    const selected = selectedBlobs.some(
                      (entry) => entry.key === blob.key,
                    );
                    return (
                      <BlobCard
                        key={blob.key}
                        blobRecord={blob}
                        selected={selected}
                        onClick={(event) => handleCardClick(blob, event)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            selectBlob(blob);
                            setAnchorBlob(blob);
                          } else {
                            unselectBlob(blob);
                            if (anchorBlob?.key === blob.key) {
                              setAnchorBlob(null);
                            }
                          }
                        }}
                        onToggle={() => {
                          if (selected) {
                            unselectBlob(blob);
                          } else {
                            selectBlob(blob);
                            setAnchorBlob(blob);
                          }
                        }}
                      />
                    );
                  })}
                </ResponsiveGrid>
              </SurfaceListItemFrame>
              {total > PAGE_SIZE ? (
                <Pagination
                  pageNum={pageNum}
                  totalCount={total}
                  countPerPage={PAGE_SIZE}
                  onPageChange={(_, nextPage) => setPageNum(nextPage)}
                />
              ) : null}
            </>
          )}
        </Stack>
      )}
    </Stack>
  );
};
