import { useGuard } from "@myoxus/core/components/guard";
import { useEnableAI } from "@myoxus/core/components/hooks/myoxus/use-enable-ai";
import {
  MyoxusPageReference,
  MyoxusSharedPageReference,
} from "@myoxus/core/components/myoxus/reference-link";
import { LitTextRenderer } from "@myoxus/core/editor/ai/components/text-renderer";
import { getViewManager } from "@myoxus/core/editor/manager/view";
import {
  patchReferenceRenderer,
  type ReferenceReactRenderer,
} from "@myoxus/core/editor/view-extensions/editor-view/reference-renderer";
import { type Backlink, DocLinksService } from "@myoxus/core/modules/doc-link";
import { toDocSearchParams } from "@myoxus/core/modules/navigation/utils";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  type DatabaseDocumentReferenceFieldsFragment,
  DatabaseDocumentReferenceKind,
  DocumentGraphTargetState,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useFramework, useLiveData, useServices } from "@myoxus/infra";
import { useLitPortalFactory } from "@myoxus/lit-react";
import track from "@myoxus/track";
import {
  Badge,
  EmptyState,
  Group,
  MyoxusText,
  Stack,
  SurfaceListItem,
  SurfaceListItemFrame,
} from "@myoxus/ui-facade";
import type {
  ExtensionType,
  TransformerMiddleware,
} from "@virgultum/editor/store";
import { Fragment, useEffect, useMemo } from "react";

type BacklinkGroup = {
  docId: string;
  links: Backlink[];
};

type TextRendererOptions = {
  customHeading: boolean;
  extensions: ExtensionType[];
  additionalMiddlewares: TransformerMiddleware[];
};

export function useDocumentLinkCounts(enabled = true) {
  const { docLinksService } = useServices({
    DocLinksService,
  });
  const backlinks = useLiveData(docLinksService.backlinks.backlinks$);
  const databaseReferences = useLiveData(
    docLinksService.backlinks.databaseReferences$,
  );
  const links = useLiveData(docLinksService.links.links$);
  const backlinksLoaded = useLiveData(docLinksService.backlinks.isLoaded$);
  const linksLoaded = useLiveData(docLinksService.links.isLoaded$);

  useEffect(() => {
    if (!enabled) return;
    const releaseBacklinks = docLinksService.backlinks.acquireLoadDemand();
    const releaseLinks = docLinksService.links.acquireLoadDemand();
    return () => {
      releaseBacklinks();
      releaseLinks();
    };
  }, [docLinksService, enabled]);

  const backlinkCount =
    enabled && backlinksLoaded
      ? backlinks.length + databaseReferences.length
      : undefined;
  const outgoingCount = enabled && linksLoaded ? links.length : undefined;

  return {
    backlinkCount,
    outgoingCount,
    totalCount:
      backlinkCount === undefined || outgoingCount === undefined
        ? undefined
        : backlinkCount + outgoingCount,
  };
}

export function DatabaseBacklinkReferences({
  references,
}: {
  references: DatabaseDocumentReferenceFieldsFragment[];
}) {
  const t = useI18n();

  if (references.length === 0) return null;

  return (
    <Stack data-testid="document-links-database-references">
      <MyoxusText typographySlot="section-title">
        {t["com.myoxus.database.index.title"]()}
      </MyoxusText>
      {references.map((reference) => {
        const search = new URLSearchParams({ rowId: reference.rowId });
        const referenceLabel =
          reference.referenceKind ===
          DatabaseDocumentReferenceKind.RowContentDocument
            ? t["com.myoxus.database.row_content.title"]()
            : reference.referenceKind ===
                DatabaseDocumentReferenceKind.TaskSource
              ? t["com.myoxus.database.tasks.capture-source"]()
              : t[
                  "com.myoxus.documentGraph.linkKind.database-cell-reference"
                ]();

        return (
          <SurfaceListItemFrame
            key={`${reference.databaseId}:${reference.rowId}:${reference.referenceKind}:${reference.fieldId ?? "content"}`}
            component={WorkbenchLink}
            to={{
              pathname: `/databases/${reference.databaseId}`,
              search: `?${search}`,
              hash: "",
            }}
            aria-label={reference.rowTitle}
            data-testid={`document-links-database-reference-${reference.rowId}`}
          >
            <SurfaceListItem
              component="article"
              appearance="row"
              density="compact"
              interactive
            >
              <Group justify="space-between" wrap="wrap">
                <Stack gap="xs">
                  <MyoxusText typographySlot="body-strong">
                    {reference.rowTitle}
                  </MyoxusText>
                  <MyoxusText tone="secondary" typographySlot="body-small">
                    {reference.databaseTitle}
                  </MyoxusText>
                </Stack>
                <Group gap="xs" wrap="wrap">
                  <Badge>{referenceLabel}</Badge>
                  {reference.fieldName ? (
                    <MyoxusText tone="secondary" typographySlot="body-small">
                      {reference.fieldName}
                    </MyoxusText>
                  ) : null}
                </Group>
              </Group>
            </SurfaceListItem>
          </SurfaceListItemFrame>
        );
      })}
    </Stack>
  );
}

const usePreviewExtensions = () => {
  const [reactToLit, portals] = useLitPortalFactory();
  const framework = useFramework();
  const enableAI = useEnableAI();

  const { workspaceService } = useServices({
    WorkspaceService,
  });

  const referenceRenderer: ReferenceReactRenderer = useMemo(() => {
    return function customReference(reference) {
      const data = reference.delta.attributes?.reference;
      if (!data) return <span />;

      const pageId = data.pageId;
      if (!pageId) return <span />;

      const params = toDocSearchParams(data.params);

      if (workspaceService.workspace.openOptions.isSharedMode) {
        return (
          <MyoxusSharedPageReference
            docCollection={workspaceService.workspace.docCollection}
            pageId={pageId}
            params={params}
          />
        );
      }

      return <MyoxusPageReference pageId={pageId} params={params} />;
    };
  }, [workspaceService]);

  const extensions = useMemo(() => {
    const manager = getViewManager()
      .config.init()
      .foundation(framework)
      .ai(enableAI, framework)
      .theme(framework)
      .database(framework)
      .linkedDoc(framework)
      .paragraph(enableAI)
      .linkPreview(framework)
      .codeBlockPreview(framework).value;
    const specs = manager.get("preview-page");
    return [...specs, patchReferenceRenderer(reactToLit, referenceRenderer)];
  }, [reactToLit, referenceRenderer, framework, enableAI]);

  return [extensions, portals] as const;
};

function groupBacklinks(backlinks: Backlink[]): BacklinkGroup[] {
  const groupedLinks = backlinks.reduce(
    (acc, link) => {
      acc[link.docId] = [...(acc[link.docId] || []), link];
      return acc;
    },
    {} as Record<string, Backlink[]>,
  );

  return Object.entries(groupedLinks).map(([docId, links]) => ({
    docId,
    links,
  }));
}

function BacklinkPreview({
  linkGroup,
  textRendererOptions,
}: {
  linkGroup: BacklinkGroup;
  textRendererOptions: TextRendererOptions;
}) {
  const canAccess = useGuard("Doc_Read", linkGroup.docId);
  const t = useI18n();

  if (!canAccess) {
    return (
      <MyoxusText component="span" tone="secondary" typographySlot="body-small">
        {t["com.myoxus.share-menu.option.permission.no-access"]()}
      </MyoxusText>
    );
  }

  return (
    <Stack data-myoxus-ui-role="document-links-backlink-preview-list">
      {linkGroup.links.map((link) => {
        if (!link.markdownPreview) {
          return null;
        }
        const searchParams = new URLSearchParams();
        const displayMode = link.displayMode || "page";
        searchParams.set("mode", displayMode);

        let blockId = link.blockId;
        if (link.parentFlavour === "myoxus:database" && link.parentBlockId) {
          blockId = link.parentBlockId;
        } else if (displayMode === "edgeless" && link.noteBlockId) {
          blockId = link.noteBlockId;
        }

        searchParams.set("blockIds", blockId);

        const to = {
          pathname: "/" + linkGroup.docId,
          search: "?" + searchParams.toString(),
          hash: "",
        };

        const edgelessLink = displayMode === "edgeless" && !link.noteBlockId;

        return (
          <SurfaceListItemFrame
            key={link.blockId}
            component={WorkbenchLink}
            to={to}
            data-myoxus-ui-role="document-links-backlink-preview-link"
            onClick={() => {
              track.doc.biDirectionalLinksPanel.backlinkPreview.navigate();
            }}
          >
            <SurfaceListItem
              component="article"
              appearance="card"
              density="compact"
              interactive
              data-myoxus-ui-role="document-links-backlink-preview"
            >
              {edgelessLink ? (
                <MyoxusText
                  component="span"
                  tone="primary"
                  typographySlot="body-small"
                >
                  {t["com.myoxus.document-links.edgeless-reference"]()}{" "}
                  <MyoxusPageReference
                    key={link.blockId}
                    pageId={linkGroup.docId}
                    params={searchParams}
                  />
                </MyoxusText>
              ) : (
                <LitTextRenderer
                  answer={link.markdownPreview}
                  options={textRendererOptions}
                />
              )}
            </SurfaceListItem>
          </SurfaceListItemFrame>
        );
      })}
    </Stack>
  );
}

export function DocumentBacklinksList() {
  const [extensions, portals] = usePreviewExtensions();
  const { workspaceService, docLinksService } = useServices({
    WorkspaceService,
    DocLinksService,
  });
  const t = useI18n();

  const backlinks = useLiveData(docLinksService.backlinks.backlinks$);
  const databaseReferences = useLiveData(
    docLinksService.backlinks.databaseReferences$,
  );

  useEffect(() => {
    return docLinksService.backlinks.acquireLoadDemand();
  }, [docLinksService]);

  const backlinkGroups = useMemo(() => groupBacklinks(backlinks), [backlinks]);

  const textRendererOptions = useMemo(() => {
    const docLinkBaseURLMiddleware: TransformerMiddleware = ({
      adapterConfigs,
    }) => {
      adapterConfigs.set(
        "docLinkBaseUrl",
        `/workspace/${workspaceService.workspace.id}`,
      );
    };

    return {
      customHeading: true,
      extensions,
      additionalMiddlewares: [docLinkBaseURLMiddleware],
    };
  }, [extensions, workspaceService.workspace.id]);

  if (backlinkGroups.length === 0 && databaseReferences.length === 0) {
    return (
      <EmptyState
        title={t["com.myoxus.document-links.backlinks.empty.title"]()}
        description={t[
          "com.myoxus.document-links.backlinks.empty.description"
        ]()}
      />
    );
  }

  return (
    <Stack data-myoxus-ui-role="document-links-backlinks-list">
      <DatabaseBacklinkReferences references={databaseReferences} />
      {backlinkGroups.map((linkGroup) => (
        <Stack
          key={linkGroup.docId}
          data-myoxus-ui-role="document-links-backlink-group"
        >
          <Group data-myoxus-ui-role="document-links-backlink-group-title">
            <MyoxusPageReference
              pageId={linkGroup.docId}
              onClick={() => {
                track.doc.biDirectionalLinksPanel.backlinkTitle.navigate();
              }}
            />
          </Group>
          <BacklinkPreview
            textRendererOptions={textRendererOptions}
            linkGroup={linkGroup}
          />
        </Stack>
      ))}
      {portals.map((p) => (
        <Fragment key={p.id}>{p.portal}</Fragment>
      ))}
    </Stack>
  );
}

export function DocumentOutgoingLinksList() {
  const { docLinksService } = useServices({
    DocLinksService,
  });
  const t = useI18n();
  const links = useLiveData(docLinksService.links.links$);

  useEffect(() => {
    return docLinksService.links.acquireLoadDemand();
  }, [docLinksService]);

  if (links.length === 0) {
    return (
      <EmptyState
        title={t["com.myoxus.document-links.outgoing.empty.title"]()}
        description={t[
          "com.myoxus.document-links.outgoing.empty.description"
        ]()}
      />
    );
  }

  return (
    <Stack data-myoxus-ui-role="document-links-outgoing-list">
      {links.map((link, i) => (
        <Group
          key={`${link.workspaceId}-${link.rawDocId}-${link.params?.toString()}-${i}`}
          data-myoxus-ui-role="document-links-outgoing-row"
        >
          {link.docId &&
          link.targetState === DocumentGraphTargetState.Available ? (
            <MyoxusPageReference
              pageId={link.docId}
              workspaceId={link.workspaceId}
              params={link.params}
            />
          ) : (
            <>
              <MyoxusText typographySlot="body-small">
                {link.title || link.rawDocId}
              </MyoxusText>
              <Badge tone="warning">
                {documentGraphTargetStateLabel(t, link.targetState)}
              </Badge>
            </>
          )}
        </Group>
      ))}
    </Stack>
  );
}

function documentGraphTargetStateLabel(
  t: ReturnType<typeof useI18n>,
  state: DocumentGraphTargetState,
) {
  switch (state) {
    case DocumentGraphTargetState.Available:
      return t["com.myoxus.documentGraph.state.available"]();
    case DocumentGraphTargetState.Redacted:
      return t["com.myoxus.documentGraph.state.redacted"]();
    case DocumentGraphTargetState.Deleted:
      return t["com.myoxus.documentGraph.state.deleted"]();
    case DocumentGraphTargetState.Missing:
      return t["com.myoxus.documentGraph.state.missing"]();
    case DocumentGraphTargetState.Unresolved:
      return t["com.myoxus.documentGraph.state.unresolved"]();
  }
}
