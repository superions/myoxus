import { useCatchEventCallback } from "@myoxus/core/components/hooks/use-catch-event-hook";
import { PagePreview } from "@myoxus/core/components/page-list/page-content-preview";
import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  WorkbenchLink,
  type WorkbenchLinkProps,
} from "@myoxus/core/modules/workbench";
import { useLiveData, useService } from "@myoxus/infra";
import {
  IconButton,
  Skeleton,
  SurfaceListCardHeader,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemMain,
  SurfaceListText,
} from "@myoxus/ui-facade";
import type { DocMeta } from "@virgultum/editor/store";
import { forwardRef, type ReactNode, useMemo } from "react";

import { DocCardTags } from "./tag";

export const calcRowsById = (id: string, min = 2, max = 8) => {
  const code = id.charCodeAt(0);
  return Math.floor((code % (max - min)) + min);
};

export interface DocCardProps extends Omit<WorkbenchLinkProps, "to"> {
  meta: {
    id: DocMeta["id"];
    title?: ReactNode;
  } & { [key: string]: any };
  showTags?: boolean;

  /**
   * When enabled, preview's height will be calculated based on `meta.id`
   */
  autoHeightById?: boolean;
}

export const DocCard = forwardRef<HTMLAnchorElement, DocCardProps>(
  function DocCard(
    { showTags = true, meta, className, autoHeightById, ...attrs },
    outerRef,
  ) {
    const t = useI18n();
    const cloudPreview =
      useService(WorkspaceService).workspace.flavour !== "local";
    const favAdapter = useService(CompatibleFavoriteItemsAdapter);
    const docDisplayService = useService(DocDisplayMetaService);
    const title = useLiveData(docDisplayService.title$(meta.id));
    const favorited = useLiveData(favAdapter.isFavorite$(meta.id, "doc"));

    const toggleFavorite = useCatchEventCallback(
      (e: React.MouseEvent) => {
        e.preventDefault();
        favAdapter.toggle(meta.id, "doc");
      },
      [favAdapter, meta.id],
    );

    const previewBlockSize = useMemo(() => {
      if (!autoHeightById) return undefined;
      const rows = calcRowsById(meta.id);
      return `calc(${rows} * var(--mantine-spacing-sm))`;
    }, [autoHeightById, meta.id]);

    return (
      <SurfaceListItemFrame
        component={WorkbenchLink}
        ref={(ref) => {
          const anchor = ref as HTMLAnchorElement | null;
          if (typeof outerRef === "function") {
            outerRef(anchor);
          } else if (outerRef) {
            outerRef.current = anchor;
          }
        }}
        className={className}
        data-testid="doc-card"
        data-doc-id={meta.id}
        data-myoxus-ui-role="mobile-doc-card-link"
        to={`/${meta.id}`}
        {...attrs}
      >
        <SurfaceListItem
          appearance="card"
          component="article"
          density="card"
          fullHeight
          fullWidth
          interactive
          layout="column"
          role="presentation"
          data-myoxus-ui-role="mobile-doc-card"
        >
          <SurfaceListCardHeader data-testid="doc-card-header">
            <SurfaceListText
              component="h3"
              kind="card-title"
              data-myoxus-ui-role="mobile-doc-card-title"
            >
              {title}
            </SurfaceListText>
            <IconButton
              aria-label="favorite"
              aria-pressed={favorited}
              icon={<IsFavoriteIcon favorite={favorited} />}
              onClick={toggleFavorite}
            />
          </SurfaceListCardHeader>
          <SurfaceListItemMain
            blockSize={cloudPreview ? undefined : previewBlockSize}
            compact
            data-myoxus-ui-role="mobile-doc-card-preview"
            grow={!autoHeightById}
          >
            <PagePreview
              variant="image"
              fallback={
                <>
                  <Skeleton />
                  <Skeleton width={"60%"} />
                </>
              }
              pageId={meta.id}
              emptyFallback={
                <SurfaceListText kind="description">
                  {t["com.myoxus.selectPage.empty"]()}
                </SurfaceListText>
              }
            />
          </SurfaceListItemMain>
          {showTags ? <DocCardTags docId={meta.id} rows={2} /> : null}
        </SurfaceListItem>
      </SurfaceListItemFrame>
    );
  },
);
