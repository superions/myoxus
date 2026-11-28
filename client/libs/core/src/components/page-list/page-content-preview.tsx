// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { DocsService } from "@myoxus/core/modules/doc";
import { DocSummaryService } from "@myoxus/core/modules/doc-summary";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { Box, observeIntersection } from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import type { Store as VirgultumStore } from "@virgultum/editor/store";
import { useAtomValue } from "jotai";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { ServerPagePreview } from "./server-page-preview";
import { useVirgultumPagePreview } from "./use-virgultum-page-preview";

export interface PagePreviewProps {
  fill?: boolean;
  inventoryPreview?: "grid" | "masonry";
  variant?: "text" | "image";
  edgelessFallback?: ReactNode;
  enableLocalTextFallback?: boolean;
  pageId: string;
  emptyFallback?: ReactNode;
  fallback?: ReactNode;
  visibleListSnippet?: boolean;
}

const usePagePrimaryMode = (pageId: string): DocMode | undefined => {
  const docsService = useService(DocsService);
  const record = useLiveData(
    useMemo(() => docsService.list.doc$(pageId), [docsService, pageId]),
  );
  return useLiveData(record?.primaryMode$ ?? null) ?? undefined;
};

const useLocalPreviewStore = (
  pageId: string,
  enabled: boolean,
): VirgultumStore | null => {
  const docsService = useService(DocsService);
  const [store, setStore] = useState<VirgultumStore | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStore(null);
      return;
    }

    const opened = docsService.open(pageId);
    if (!opened) {
      setStore(null);
      return;
    }

    setStore(opened.doc.virgultumDoc);
    return () => {
      opened.release();
    };
  }, [docsService, enabled, pageId]);

  return store;
};

const TextPagePreview = ({
  edgelessFallback,
  enableLocalTextFallback = false,
  pageId,
  emptyFallback,
  fallback,
  visibleListSnippet = false,
}: PagePreviewProps) => {
  const docSummary = useService(DocSummaryService);
  const primaryMode = usePagePrimaryMode(pageId);

  const summary = useLiveData(
    useMemo(
      () =>
        LiveData.from(
          visibleListSnippet
            ? docSummary.watchVisibleListSnippet(pageId)
            : docSummary.watchDocSummary(pageId),
          null,
        ),
      [docSummary, pageId, visibleListSnippet],
    ),
  );

  const fallbackStore = useLocalPreviewStore(
    pageId,
    enableLocalTextFallback && summary === "" && primaryMode === "page",
  );
  const localSnippet = useAtomValue(useVirgultumPagePreview(fallbackStore));

  if (summary === null || summary === undefined) {
    return fallback;
  }

  // Edgeless surfaces require a visual preview contract rather than text fallbacks.
  if (primaryMode === "edgeless") {
    return edgelessFallback ?? emptyFallback;
  }

  if (summary === "") {
    return localSnippet || emptyFallback;
  }

  return summary;
};

const LazyVisiblePreview = (props: PagePreviewProps) => {
  const hostRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!hostRef.current) return;
    return observeIntersection(hostRef.current, (entry) => {
      setVisible(entry.isIntersecting);
    });
  }, []);

  return (
    <Box component="span" ref={hostRef}>
      {visible ? <TextPagePreview {...props} /> : props.fallback}
    </Box>
  );
};

export const PagePreview = (props: PagePreviewProps) => {
  const workspace = useService(WorkspaceService).workspace;
  if (props.variant === "image" && workspace.flavour !== "local") {
    return (
      <ServerPagePreview
        pageId={props.pageId}
        fill={props.fill}
        inventoryPreview={props.inventoryPreview}
      />
    );
  }
  if (props.visibleListSnippet) {
    return <LazyVisiblePreview {...props} />;
  }
  return <TextPagePreview {...props} />;
};
