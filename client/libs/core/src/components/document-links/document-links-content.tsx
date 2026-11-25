import { useGuard } from "@myoxus/core/components/guard";
import {
  MyoxusPageReference,
  MyoxusSharedPageReference,
} from "@myoxus/core/components/myoxus/reference-link";
import { StoredAnswerText } from "@myoxus/core/editor/ai/components/ai-message-content/stored-answer-text";
import { type Backlink, DocLinksService } from "@myoxus/core/modules/doc-link";
import {
  resolveLinkToDoc,
  toDocSearchParams,
} from "@myoxus/core/modules/navigation/utils";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import {
  type DatabaseDocumentReferenceFieldsFragment,
  DatabaseDocumentReferenceKind,
  DocumentGraphTargetState,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useServices } from "@myoxus/infra";
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
import { useCallback, useEffect, useMemo } from "react";

type BacklinkGroup = {
  docId: string;
  links: Backlink[];
};

export { useDocumentLinkCounts } from "./use-document-link-counts";

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
  renderDocLink,
}: {
  linkGroup: BacklinkGroup;
  renderDocLink: (url: string) => React.ReactNode;
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
                <StoredAnswerText
                  text={link.markdownPreview}
                  documentLink={renderDocLink}
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

  const renderDocLink = useCallback(
    (url: string) => {
      const workspaceId = workspaceService.workspace.id;
      const normalized =
        url.startsWith("/") && !url.startsWith("/workspace/")
          ? `/workspace/${workspaceId}${url}`
          : url;
      const resolved = resolveLinkToDoc(normalized);
      if (!resolved?.docId) return null;
      const params = toDocSearchParams({
        mode: resolved.mode,
        blockIds: resolved.blockIds,
        blockSelection: resolved.blockSelection,
        elementIds: resolved.elementIds,
        databaseId: resolved.databaseId,
        databaseRowId: resolved.databaseRowId,
        refreshKey: resolved.refreshKey,
        commentId: resolved.commentId,
      });
      if (workspaceService.workspace.openOptions.isSharedMode) {
        return (
          <MyoxusSharedPageReference
            docCollection={workspaceService.workspace.docCollection}
            pageId={resolved.docId}
            params={params}
          />
        );
      }
      return (
        <MyoxusPageReference
          pageId={resolved.docId}
          workspaceId={
            resolved.workspaceId !== workspaceId
              ? resolved.workspaceId
              : undefined
          }
          params={params}
        />
      );
    },
    [workspaceService],
  );

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
            renderDocLink={renderDocLink}
            linkGroup={linkGroup}
          />
        </Stack>
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
