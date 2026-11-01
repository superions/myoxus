// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { allDocsNavigationTo } from "@myoxus/core/modules/all-docs/navigation";
import {
  AddPageButton,
  MenuLinkItem,
} from "@myoxus/core/modules/app-sidebar/views";
import { canUseServerBackedDatabases } from "@myoxus/core/modules/database/availability";
import { DocDisplayMetaService } from "@myoxus/core/modules/doc-display-meta";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import { JournalService } from "@myoxus/core/modules/journal";
import { MermaidDiagramsService } from "@myoxus/core/modules/mermaid-diagrams";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useDatabasePage } from "@myoxus/core/modules/workspace-pages/use-database-page";
import { DatabaseSystemRole } from "@myoxus/graphql";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import {
  AllDocsIcon,
  DatabaseIcon,
  ListChecksIcon,
  TodayIcon,
  WorkflowIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { SidebarNavSection } from "@myoxus/ui-facade";
import { useCallback, useEffect } from "react";

function AllPagesLink() {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const inventory = useService(DocumentMetadataCacheService);
  const workspace = useService(WorkspaceService).workspace;
  const prepareInventory = useCallback(() => {
    if (workspace.flavour === "local") return;
    // Workspace entry and navigation intent share the coalesced, invalidated
    // cache, so the primary inventory is ready before its first normal click.
    // A failed preload remains visible through the page's index error state.
    void inventory.hydrateIndex().catch(() => {});
  }, [inventory, workspace]);
  useEffect(prepareInventory, [prepareInventory]);
  const active = useLiveData(
    workbench.location$.selector(
      (location) => location.pathname === "/all" && !location.search,
    ),
  );

  return (
    <MenuLinkItem
      icon={<AllDocsIcon />}
      active={active}
      data-testid="all-docs-sidebar-filter-all"
      to={allDocsNavigationTo({ kind: "all" })}
      onMouseEnter={prepareInventory}
      onFocus={prepareInventory}
    >
      <span data-testid="all-pages">{t["All content"]()}</span>
    </MenuLinkItem>
  );
}

function JournalLink() {
  const t = useI18n();
  const docDisplayMetaService = useService(DocDisplayMetaService);
  const journalService = useService(JournalService);
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const maybeDocId = location.pathname.split("/")[1];
  const isJournal = !!useLiveData(journalService.journalDate$(maybeDocId));
  const JournalIcon = useLiveData(docDisplayMetaService.icon$(maybeDocId));
  const Icon = isJournal ? JournalIcon : TodayIcon;

  return (
    <MenuLinkItem
      data-testid="slider-bar-journals-button"
      active={isJournal || location.pathname.startsWith("/journals")}
      to="/journals"
      icon={<Icon />}
    >
      {t["com.myoxus.journal.app-sidebar-title"]()}
    </MenuLinkItem>
  );
}

function DatabasesLink({ active }: { active: boolean }) {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  if (!canUseServerBackedDatabases(workspace)) return null;

  return (
    <MenuLinkItem
      icon={<DatabaseIcon />}
      active={active}
      to="/databases"
      data-testid="databases-sidebar-link"
    >
      {t["com.myoxus.workspaceSubPath.databases"]()}
    </MenuLinkItem>
  );
}

function TasksLink({ active }: { active: boolean }) {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  if (!canUseServerBackedDatabases(workspace)) return null;
  return (
    <MenuLinkItem
      icon={<ListChecksIcon />}
      active={active}
      to="/tasks"
      data-testid="tasks-sidebar-link"
    >
      {t["com.myoxus.database.progress.tasks"]()}
    </MenuLinkItem>
  );
}

function DiagramsLink() {
  const t = useI18n();
  const diagrams = useService(MermaidDiagramsService);
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const maybeDocId = location.pathname.split("/")[1];
  const isDiagram = useLiveData(diagrams.isDiagramDoc$(maybeDocId));

  return (
    <MenuLinkItem
      data-testid="slider-bar-mermaid-diagrams-button"
      active={isDiagram || location.pathname.startsWith("/diagrams")}
      to="/diagrams"
      icon={<WorkflowIcon />}
    >
      {t["com.myoxus.workspaceSubPath.diagrams"]()}
    </MenuLinkItem>
  );
}

export function PrimaryNavigation() {
  return (
    <SidebarNavSection data-myoxus-ui-role="sidebar-primary-navigation">
      <AddPageButton />
      <AllPagesLink />
    </SidebarNavSection>
  );
}

/** Workspace views remain available in the scrollable navigation catalog. */
export function WorkspaceViewsNavigation() {
  const workspace = useService(WorkspaceService).workspace;
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const databaseRoute =
    location.pathname === "/databases" ||
    location.pathname.startsWith("/databases/");
  const databaseId = databaseRoute
    ? location.pathname.split("/")[2]
    : undefined;
  const { record } = useDatabasePage(
    databaseId && canUseServerBackedDatabases(workspace) ? workspace.id : null,
    databaseId ?? "",
  );
  // Navigation follows the authorized native host marker, including Row links;
  // a prior route's summary must never select the next route's navigation item.
  const workspaceTasks = Boolean(
    databaseId &&
    record?.id === databaseId &&
    record.systemRole === DatabaseSystemRole.WorkspaceTasks,
  );
  return (
    <SidebarNavSection data-myoxus-ui-role="sidebar-workspace-views-navigation">
      <JournalLink />
      <DatabasesLink active={databaseRoute && !workspaceTasks} />
      <TasksLink active={location.pathname === "/tasks" || workspaceTasks} />
      <DiagramsLink />
    </SidebarNavSection>
  );
}
