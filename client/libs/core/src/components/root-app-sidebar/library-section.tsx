// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type AllDocsSavedFilter,
  AllDocsSavedFiltersService,
} from "@myoxus/core/modules/all-docs";
import {
  allDocsNavigationMatches,
  allDocsNavigationTo,
  parseAllDocsNavigationSearch,
} from "@myoxus/core/modules/all-docs/navigation";
import { MenuLinkItem } from "@myoxus/core/modules/app-sidebar/views";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import { CollectionsIcon, TagsIcon, TemplateIcon } from "@myoxus/icons/react";
import { LiveData, useFramework, useLiveData, useService } from "@myoxus/infra";
import { SidebarNavSection, SidebarNavSectionLabel } from "@myoxus/ui-facade";
import { useMemo } from "react";

const EMPTY_SAVED_FILTERS = new LiveData<AllDocsSavedFilter[]>([]);

function useOptionalSavedFilters() {
  const framework = useFramework();

  return useMemo(() => {
    try {
      return framework.get(AllDocsSavedFiltersService);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Missing dependency [WorkspaceLocalState]")
      ) {
        return null;
      }
      throw error;
    }
  }, [framework]);
}

function SavedFilterLink({
  active,
  savedFilterId,
  name,
}: {
  active: boolean;
  savedFilterId: string;
  name: string;
}) {
  const t = useI18n();

  return (
    <MenuLinkItem
      active={active}
      data-testid={`all-docs-sidebar-filter-saved-filter-${savedFilterId}`}
      to={allDocsNavigationTo({ kind: "savedFilter", savedFilterId })}
    >
      {name || t["Untitled"]()}
    </MenuLinkItem>
  );
}

function CollectionsLink({ active }: { active: boolean }) {
  const t = useI18n();

  return (
    <MenuLinkItem
      data-testid="collections-sidebar-section"
      icon={<CollectionsIcon />}
      active={active}
      to="/collection"
    >
      {t["com.myoxus.rootAppSidebar.collections"]()}
    </MenuLinkItem>
  );
}

function TagsLink({ active }: { active: boolean }) {
  const t = useI18n();
  return (
    <MenuLinkItem
      active={active}
      data-testid="tags-sidebar-section"
      icon={<TagsIcon />}
      to="/tags"
    >
      {t["com.myoxus.rootAppSidebar.tags"]()}
    </MenuLinkItem>
  );
}

function TemplatesLink({ active }: { active: boolean }) {
  const t = useI18n();
  return (
    <MenuLinkItem
      active={active}
      data-testid="templates-sidebar-section"
      icon={<TemplateIcon />}
      to="/templates"
    >
      {t["com.myoxus.templates.library.title"]()}
    </MenuLinkItem>
  );
}

export function LibrarySection() {
  const workbench = useService(WorkbenchService).workbench;
  const location = useLiveData(workbench.location$);
  const savedFiltersService = useOptionalSavedFilters();
  const activeTarget = useMemo(
    () =>
      location.pathname === "/all"
        ? parseAllDocsNavigationSearch(location.search)
        : { kind: "all" as const },
    [location.pathname, location.search],
  );
  const savedFilters = useLiveData(
    savedFiltersService?.savedFilters$ ?? EMPTY_SAVED_FILTERS,
  );
  const t = useI18n();

  return (
    <SidebarNavSection data-myoxus-ui-role="sidebar-library-section">
      <SidebarNavSectionLabel>
        {t["com.myoxus.rootAppSidebar.library"]()}
      </SidebarNavSectionLabel>
      <CollectionsLink
        active={
          location.pathname === "/collection" ||
          activeTarget.kind === "collection"
        }
      />
      <TagsLink active={location.pathname === "/tags"} />
      <TemplatesLink active={location.pathname === "/templates"} />
      {savedFilters.map((savedFilter) => (
        <SavedFilterLink
          key={savedFilter.id}
          active={
            location.pathname === "/all" &&
            allDocsNavigationMatches(activeTarget, {
              kind: "savedFilter",
              savedFilterId: savedFilter.id,
            })
          }
          savedFilterId={savedFilter.id}
          name={savedFilter.name}
        />
      ))}
    </SidebarNavSection>
  );
}
