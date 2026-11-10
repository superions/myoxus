// SPDX-FileCopyrightText: 2022-2026 TOEVERYTHING PTE. LTD. and its affiliates.
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT
import { MyoxusErrorBoundary } from "@myoxus/core/components/myoxus/myoxus-error-boundary";
import { VirgultumEditor } from "@myoxus/core/editor/virgultum/doc-editor";
import { useI18n } from "@myoxus/i18n";
import {
  Box,
  Button,
  EditorPageViewport,
  Loading,
  Scrollable,
  SettingsNotice,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import type { Store } from "@virgultum/editor/store";
import { HistorySnapshotUnavailableError } from "./history-preview";

/** Render only the isolated snapshot. Missing historical canvas stays Page-only. */
export function HistoryPreviewContent({
  page,
  mode,
  error,
  onRetry,
}: {
  page?: Store;
  mode: DocMode;
  error?: unknown;
  onRetry: () => void;
}) {
  const t = useI18n();
  if (error instanceof HistorySnapshotUnavailableError)
    return (
      <SettingsNotice tone="error">
        {t["com.myoxus.history.snapshot-fields-unavailable"]()}
      </SettingsNotice>
    );
  if (error)
    return (
      <SettingsNotice tone="error">
        {t["com.myoxus.sidebar.document-versions.error.load-failed"]()}
        <Button onClick={onRetry}>{t["Retry"]()}</Button>
      </SettingsNotice>
    );
  if (!page) return <Loading />;
  const canvas =
    mode === "edgeless" && page.getBlocksByFlavour("myoxus:surface").length > 0;
  return (
    <MyoxusErrorBoundary key={page.id}>
      {canvas ? (
        // The canvas renderer needs a definite viewport, not ScrollArea auto height.
        <Box flex="1 1 0" mih={0}>
          <VirgultumEditor mode="edgeless" page={page} readonly snapshot />
        </Box>
      ) : (
        <Scrollable.Root
          data-myoxus-ui-role="page-history-preview-scroll-root"
          flex="1 1 auto"
          minHeight={0}
        >
          <EditorPageViewport
            fill
            data-myoxus-ui-role="page-history-preview-scroll-viewport"
          >
            <VirgultumEditor mode="page" page={page} readonly snapshot />
          </EditorPageViewport>
          <Scrollable.Scrollbar />
        </Scrollable.Root>
      )}
    </MyoxusErrorBoundary>
  );
}
