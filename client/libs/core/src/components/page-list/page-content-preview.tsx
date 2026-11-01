import { DocsService } from "@myoxus/core/modules/doc";
import { DocSummaryService } from "@myoxus/core/modules/doc-summary";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { Box, observeIntersection } from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import type { Store as VirgultumStore } from "@virgultum/editor/store";
import { useAtomValue } from "jotai";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { useVirgultumPagePreview } from "./use-virgultum-page-preview";
import { ServerPagePreview } from "./server-page-preview";

interface PagePreviewProps {
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

function useDocPrimaryMode(pageId: string): DocMode | undefined {
  const docsService = useService(DocsService);
  const docRecord = useLiveData(
    useMemo(() => docsService.list.doc$(pageId), [docsService, pageId]),
  );

  return useLiveData(docRecord?.primaryMode$ ?? null) ?? undefined;
}

function useOpenedVirgultumPreviewStore(
  pageId: string,
  enabled: boolean,
): VirgultumStore | null {
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
}

const PagePreviewInner = ({
  edgelessFallback,
  enableLocalTextFallback = false,
  pageId,
  emptyFallback,
  fallback,
  visibleListSnippet = false,
}: PagePreviewProps) => {
  const docSummary = useService(DocSummaryService);
  const primaryMode = useDocPrimaryMode(pageId);
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
  const localTextFallbackStore = useOpenedVirgultumPreviewStore(
    pageId,
    enableLocalTextFallback && summary === "" && primaryMode === "page",
  );
  const localTextFallback = useAtomValue(
    useVirgultumPagePreview(localTextFallbackStore),
  );

  // A visible-list subscription starts with undefined before its first result;
  // keep the same fallback as the not-yet-subscribed state.
  if (summary === null || summary === undefined) {
    return fallback;
  }

  // Edgeless needs a visual preview contract; do not derive card previews from
  // page text snippets while that mode has no server-provided summary.
  if (primaryMode === "edgeless") {
    return edgelessFallback ?? emptyFallback;
  }

  if (summary === "") {
    return localTextFallback || emptyFallback;
  }

  return summary;
};

const VisibleListPagePreview = (props: PagePreviewProps) => {
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!element.current) return;
    return observeIntersection(element.current, (entry) =>
      setVisible(entry.isIntersecting),
    );
  }, []);

  return (
    <Box component="span" ref={element}>
      {visible ? <PagePreviewInner {...props} /> : props.fallback}
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
    return <VisibleListPagePreview {...props} />;
  }
  return <PagePreviewInner {...props} />;
};
