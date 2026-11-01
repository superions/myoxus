import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import { DocsService, type DocRecord } from "@myoxus/core/modules/doc";
import { DocumentLifecycleStore } from "@myoxus/core/modules/doc/stores/document-lifecycle";
import { useGuard } from "@myoxus/core/components/guard/use-guard";
import {
  ViewBody,
  ViewHeader,
  ViewIcon,
  ViewTitle,
  WorkbenchService,
} from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Badge,
  Box,
  Button,
  FilterBar,
  FilterChip,
  FilterChipTrigger,
  Group,
  MyoxusText,
  MyoxusTitle,
  Notice,
  Text,
  notify,
  PageContentRail,
  RadioCard,
  RadioCardGroup,
  RadioCardIndicator,
  SimpleGrid,
  Stack,
  SurfaceList,
  SurfaceListAction,
  SurfaceListItem,
  SurfaceListMeta,
  SurfaceListText,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  DIAGRAM_CATALOG,
  DIAGRAM_CATALOG_CATEGORIES,
  type DiagramCatalogCategory,
  type DiagramCatalogId,
  getDiagramCatalogEntries,
  getDiagramCatalogMaturity,
  recentDiagramDocs,
  resolveCatalogSelection,
} from "./catalog";
import { DiagramCatalogPreview } from "./diagram-preview";

const DEFAULT_CATALOG_ID: DiagramCatalogId = "flowchart";

const CATEGORY_LABEL_KEYS = {
  all: "com.myoxus.diagrams.catalog.category.all",
  data: "com.myoxus.diagrams.catalog.category.data",
  planning: "com.myoxus.diagrams.catalog.category.planning",
  popular: "com.myoxus.diagrams.catalog.category.popular",
  processes: "com.myoxus.diagrams.catalog.category.processes",
  software: "com.myoxus.diagrams.catalog.category.software",
} as const;

const DESCRIPTION_KEYS = {
  architecture: "com.myoxus.diagrams.catalog.type.architecture.description",
  block: "com.myoxus.diagrams.catalog.type.block.description",
  bpmn: "com.myoxus.diagrams.catalog.type.bpmn.description",
  c4: "com.myoxus.diagrams.catalog.type.c4.description",
  class: "com.myoxus.diagrams.catalog.type.class.description",
  cynefin: "com.myoxus.diagrams.catalog.type.cynefin.description",
  er: "com.myoxus.diagrams.catalog.type.er.description",
  "event-modeling":
    "com.myoxus.diagrams.catalog.type.event-modeling.description",
  flowchart: "com.myoxus.diagrams.catalog.type.flowchart.description",
  gantt: "com.myoxus.diagrams.catalog.type.gantt.description",
  "git-graph": "com.myoxus.diagrams.catalog.type.git-graph.description",
  ishikawa: "com.myoxus.diagrams.catalog.type.ishikawa.description",
  journey: "com.myoxus.diagrams.catalog.type.journey.description",
  kanban: "com.myoxus.diagrams.catalog.type.kanban.description",
  mindmap: "com.myoxus.diagrams.catalog.type.mindmap.description",
  packet: "com.myoxus.diagrams.catalog.type.packet.description",
  pie: "com.myoxus.diagrams.catalog.type.pie.description",
  quadrant: "com.myoxus.diagrams.catalog.type.quadrant.description",
  radar: "com.myoxus.diagrams.catalog.type.radar.description",
  requirement: "com.myoxus.diagrams.catalog.type.requirement.description",
  sankey: "com.myoxus.diagrams.catalog.type.sankey.description",
  sequence: "com.myoxus.diagrams.catalog.type.sequence.description",
  state: "com.myoxus.diagrams.catalog.type.state.description",
  swimlanes: "com.myoxus.diagrams.catalog.type.swimlanes.description",
  timeline: "com.myoxus.diagrams.catalog.type.timeline.description",
  "tree-view": "com.myoxus.diagrams.catalog.type.tree-view.description",
  treemap: "com.myoxus.diagrams.catalog.type.treemap.description",
  venn: "com.myoxus.diagrams.catalog.type.venn.description",
  wardley: "com.myoxus.diagrams.catalog.type.wardley.description",
  "xy-chart": "com.myoxus.diagrams.catalog.type.xy-chart.description",
} as const;

const MATURITY_LABEL_KEYS = {
  alpha: "com.myoxus.diagrams.catalog.maturity.alpha",
  beta: "com.myoxus.diagrams.catalog.maturity.beta",
} as const;

function formatRecentDate(language: string | undefined, timestamp?: number) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const today = new Date();
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const dayDelta = Math.round((startOfDate - startOfToday) / 86_400_000);

  if (dayDelta >= -1 && dayDelta <= 0) {
    return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
      dayDelta,
      "day",
    );
  }
  return new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  }).format(date);
}

/** Presentation only: lifecycle and access remain owned by their shared stores.
 * Missing format never authorizes a Mermaid label or loads a document to guess
 * its content. An available historical target can still open its normal route. */
function RecentDiagram({
  diagram,
  onOpen,
}: {
  diagram: DocRecord;
  onOpen: (id: string) => void;
}) {
  const t = useI18n();
  const metadata = useLiveData(diagram.meta$);
  const lifecycle = useService(DocumentLifecycleStore);
  const state$ = useMemo(
    () => lifecycle.state$(diagram.id),
    [diagram.id, lifecycle],
  );
  const state = useLiveData(state$);
  const canRead = useGuard("Doc_Read", diagram.id, {
    revalidate: "if-missing",
  });
  const status = metadata.trash
    ? t.Deleted()
    : state === "not-found"
      ? t["com.myoxus.reference.target-unavailable"]()
      : canRead === false
        ? t["com.myoxus.no-permission"]()
        : canRead === undefined || !metadata.id
          ? t.Loading()
          : null;
  // Remote membership can await first leaf loading until the normal route is
  // opened. Metadata is already available here: do not conflate lazy source
  // loading with catalog loading or deadlock an authorized target behind it.
  const disabled =
    Boolean(metadata.trash) ||
    state === "not-found" ||
    canRead !== true ||
    !metadata.id;
  const format =
    metadata.diagramFormat === "bpmn" || metadata.diagramFormat === "mermaid"
      ? metadata.diagramFormat
      : null;
  const type = DIAGRAM_CATALOG.find(
    (entry) => entry.id === metadata.diagramType && entry.format === format,
  );
  const formatLabel =
    type?.label ??
    (format === "bpmn"
      ? "BPMN"
      : format === "mermaid"
        ? "Mermaid"
        : t["com.myoxus.diagrams.catalog.format-unavailable"]());
  // A cached root title is not permission to expose a denied document's name.
  const title =
    canRead === true ? metadata.title || t.Untitled() : t.Untitled();
  return (
    <SurfaceListItem density="compact" data-myoxus-ui-role="recent-diagram-row">
      <SurfaceListAction
        disabled={disabled}
        onClick={() => {
          if (!disabled) onOpen(diagram.id);
        }}
        data-testid="recent-diagram-item"
      >
        <SurfaceListText kind="title" component="span">
          {title}
        </SurfaceListText>
        <SurfaceListMeta layout="inline">
          {status ? (
            <Text>{status}</Text>
          ) : (
            <>
              <Badge
                surface="floating"
                tone={
                  format === "bpmn"
                    ? "success"
                    : format === "mermaid"
                      ? "info"
                      : "neutral"
                }
              >
                {formatLabel}
              </Badge>
              <MyoxusText
                component="span"
                typographySlot="caption"
                tone="secondary"
              >
                {formatRecentDate(
                  t.language,
                  metadata.updatedDate ?? metadata.createDate,
                )}
              </MyoxusText>
            </>
          )}
        </SurfaceListMeta>
      </SurfaceListAction>
    </SurfaceListItem>
  );
}

export const DiagramsPage = () => {
  const t = useI18n();
  const diagramsLabel = t["com.myoxus.workspaceSubPath.diagrams"]();
  const mermaidDiagramsService = useService(MermaidDiagramsService);
  const workbench = useService(WorkbenchService).workbench;
  const diagrams = useLiveData(mermaidDiagramsService.diagramDocs$);
  const listReady = useLiveData(useService(DocsService).list.isReady$);
  const [category, setCategory] = useState<DiagramCatalogCategory>("popular");
  const [selectedId, setSelectedId] =
    useState<DiagramCatalogId>(DEFAULT_CATALOG_ID);
  const creation = useLiveData(mermaidDiagramsService.creation$);
  const location = useLiveData(workbench.location$);
  const recoveryId = new URLSearchParams(location.search).get("recoverDiagram");
  const creating = Boolean(creation?.busy);
  const creationBlocked =
    creating || Boolean(creation?.failed) || Boolean(recoveryId);
  useEffect(() => {
    if (recoveryId) mermaidDiagramsService.restoreCreation(recoveryId);
  }, [mermaidDiagramsService, recoveryId]);
  const retainTarget = useCallback(
    (docId: string) => {
      const next = new URLSearchParams(location.search);
      next.set("recoverDiagram", docId);
      workbench.open(`/diagrams?${next}`, {
        at: "active",
        replaceHistory: true,
      });
    },
    [location.search, workbench],
  );
  useEffect(() => {
    if (!creation || creation.origin === "import") return;
    if ((creation.busy || creation.failed) && !recoveryId)
      retainTarget(creation.docId);
    // Completion belongs to the currently mounted catalog, not an async event
    // callback from a page the user has already left. A remount observes it too.
    if (!creation.busy && !creation.failed && recoveryId === creation.docId) {
      const completed = mermaidDiagramsService.diagramDoc$(
        creation.docId,
      ).value;
      workbench.open(
        `/${creation.docId}${completed?.meta$.value.diagramFormat === "bpmn" ? "?editBpmn=1" : ""}`,
        { at: "active", replaceHistory: true },
      );
    }
  }, [creation, mermaidDiagramsService, recoveryId, retainTarget, workbench]);
  const visibleCatalog = useMemo(
    () => getDiagramCatalogEntries(category),
    [category],
  );
  const selectedEntry =
    DIAGRAM_CATALOG.find((entry) => entry.id === selectedId) ??
    DIAGRAM_CATALOG[0];
  const recentDiagrams = useMemo(() => recentDiagramDocs(diagrams), [diagrams]);

  const changeCategory = useCallback((nextCategory: DiagramCatalogCategory) => {
    setCategory(nextCategory);
    setSelectedId((current) => resolveCatalogSelection(nextCategory, current));
  }, []);

  const createDiagram = useCallback(async () => {
    if (creationBlocked || mermaidDiagramsService.creation$.value?.busy) return;
    try {
      const pending =
        selectedEntry.format === "bpmn"
          ? mermaidDiagramsService.createDiagram({
              format: "bpmn",
              title: selectedEntry.label,
              type: "bpmn",
            })
          : mermaidDiagramsService.createDiagram({
              format: "mermaid",
              source: selectedEntry.source,
              edgelessPlacement: selectedEntry.edgelessPlacement,
              title: selectedEntry.label,
              type: selectedEntry.id,
            });
      const target = mermaidDiagramsService.creation$.value?.docId;
      if (target) retainTarget(target);
      await pending;
    } catch {
      notify.error({
        title: t["com.myoxus.diagrams.catalog.create-error"](),
      });
    }
  }, [
    creationBlocked,
    mermaidDiagramsService,
    retainTarget,
    selectedEntry,
    t,
    workbench,
  ]);

  const retryCreation = async () => {
    const docId = recoveryId ?? creation?.docId;
    if (!docId || mermaidDiagramsService.creation$.value?.busy) return;
    retainTarget(docId);
    await mermaidDiagramsService.retryCreation(docId);
  };
  const discardCreation = () => {
    const docId = recoveryId ?? creation?.docId;
    if (!docId || creating) return;
    try {
      mermaidDiagramsService.discardCreation(docId);
      const next = new URLSearchParams(location.search);
      next.delete("recoverDiagram");
      workbench.open(`/diagrams${next.size ? `?${next}` : ""}`, {
        at: "active",
        replaceHistory: true,
      });
    } catch {
      notify.error(t["com.myoxus.common.operation-failed"]());
    }
  };

  const openDiagram = useCallback(
    (docId: string) => {
      workbench.openDoc(docId, { at: "active" });
    },
    [workbench],
  );

  return (
    <>
      <ViewTitle title={diagramsLabel} />
      <ViewIcon icon="edgeless" />
      <ViewHeader>
        <WorkbenchHeaderFrame
          data-myoxus-ui-role="diagrams-header-frame"
          title={
            <WorkbenchHeaderContextPath
              current={diagramsLabel}
              data-myoxus-ui-role="diagrams-header-title"
            />
          }
        />
      </ViewHeader>
      <ViewBody>
        <PageContentRail
          fill
          scroll
          spacious
          width="data"
          data-myoxus-ui-role="diagrams-content-rail"
        >
          <Stack gap="lg" w="100%" data-myoxus-ui-role="diagram-catalog">
            <Group align="flex-end" justify="space-between" wrap="wrap">
              <Stack gap="xs">
                <MyoxusTitle order={2} typographySlot="section-title">
                  {t["com.myoxus.diagrams.catalog.new-title"]()}
                </MyoxusTitle>
                <MyoxusText tone="secondary">
                  {t["com.myoxus.diagrams.catalog.new-description"]()}
                </MyoxusText>
              </Stack>
              <Button
                variant="primary"
                prefix={<PlusIcon />}
                onClick={createDiagram}
                disabled={creationBlocked}
                aria-busy={creating}
                data-testid="create-selected-diagram-button"
              >
                {t["com.myoxus.diagrams.catalog.create"]({
                  type: selectedEntry.label,
                })}
              </Button>
            </Group>

            {creation && (creation.busy || creation.failed) && (
              <Notice
                title={
                  creating
                    ? t.Loading()
                    : t["com.myoxus.diagrams.catalog.create-error"]()
                }
                tone={creating ? "info" : "error"}
                data-testid="diagram-creation-recovery"
              >
                <Stack>
                  <Text>{creation.title || t.Untitled()}</Text>
                  <Group>
                    <Button
                      variant="primary"
                      loading={creating}
                      disabled={creating}
                      onClick={retryCreation}
                    >
                      {t.Retry()}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={creating}
                      onClick={discardCreation}
                    >
                      {t["com.myoxus.moveToTrash.title"]()}
                    </Button>
                  </Group>
                </Stack>
              </Notice>
            )}

            <FilterBar
              aria-label={t["com.myoxus.diagrams.catalog.categories"]()}
            >
              {DIAGRAM_CATALOG_CATEGORIES.map((categoryId) => {
                const active = categoryId === category;
                return (
                  <FilterChip key={categoryId} active={active}>
                    <FilterChipTrigger
                      tone={active ? "primary" : "secondary"}
                      onClick={() => changeCategory(categoryId)}
                      aria-pressed={active}
                      data-testid={`diagram-category-${categoryId}`}
                    >
                      {t[CATEGORY_LABEL_KEYS[categoryId]]()}
                    </FilterChipTrigger>
                  </FilterChip>
                );
              })}
            </FilterBar>

            <RadioCardGroup
              value={selectedId}
              onChange={(value) => setSelectedId(value as DiagramCatalogId)}
              aria-label={t["com.myoxus.diagrams.catalog.selection-label"]()}
            >
              <SimpleGrid cols={{ base: 2, sm: 3, lg: 4, xl: 5 }}>
                {visibleCatalog.map((entry) => {
                  const maturity = getDiagramCatalogMaturity(entry.id);
                  return (
                    <RadioCard
                      key={entry.id}
                      value={entry.id}
                      square
                      density="compact"
                      data-testid={`diagram-type-${entry.id}`}
                      data-myoxus-ui-role="diagram-catalog-card"
                    >
                      <Stack gap="xs" h="100%">
                        <Box flex="1 1 auto" mih={0} aria-hidden="true">
                          <DiagramCatalogPreview kind={entry.preview} />
                        </Box>
                        <Group
                          align="flex-start"
                          justify="space-between"
                          wrap="nowrap"
                        >
                          <Group gap="xs" wrap="wrap">
                            <MyoxusText typographySlot="h5" lineClamp={2}>
                              {entry.label}
                            </MyoxusText>
                            <Badge
                              tone={maturity === "beta" ? "info" : "neutral"}
                              data-testid={`diagram-maturity-${entry.id}`}
                              data-maturity={maturity}
                            >
                              {t[MATURITY_LABEL_KEYS[maturity]]()}
                            </Badge>
                          </Group>
                          <RadioCardIndicator />
                        </Group>
                        <MyoxusText
                          typographySlot="caption"
                          tone="secondary"
                          lineClamp={2}
                        >
                          {t[DESCRIPTION_KEYS[entry.id]]()}
                        </MyoxusText>
                        {entry.sourceOnly ? (
                          <Stack gap="xs">
                            <Badge
                              tone="info"
                              data-testid={`diagram-support-${entry.id}`}
                            >
                              {t[
                                "com.myoxus.editor.mermaid.source-first-title"
                              ]()}
                            </Badge>
                            <MyoxusText
                              typographySlot="caption"
                              tone="secondary"
                              lineClamp={2}
                            >
                              {t[
                                "com.myoxus.editor.mermaid.source-first-copy"
                              ]()}
                            </MyoxusText>
                          </Stack>
                        ) : null}
                      </Stack>
                    </RadioCard>
                  );
                })}
              </SimpleGrid>
            </RadioCardGroup>
          </Stack>

          <Stack gap="sm" w="100%" data-myoxus-ui-role="recent-diagrams">
            <MyoxusTitle order={3} typographySlot="section-title">
              {t["com.myoxus.diagrams.catalog.recent"]()}
            </MyoxusTitle>
            {recentDiagrams.length ? (
              <SurfaceList
                label={t["com.myoxus.diagrams.catalog.recent"]()}
                data-testid="recent-diagrams-list"
              >
                {recentDiagrams.map((diagram) => (
                  <RecentDiagram
                    key={diagram.id}
                    diagram={diagram}
                    onOpen={openDiagram}
                  />
                ))}
              </SurfaceList>
            ) : (
              <MyoxusText tone="secondary">
                {listReady
                  ? t["com.myoxus.diagrams.catalog.recent-empty"]()
                  : t.Loading()}
              </MyoxusText>
            )}
          </Stack>
        </PageContentRail>
      </ViewBody>
    </>
  );
};

export const Component = () => <DiagramsPage />;
