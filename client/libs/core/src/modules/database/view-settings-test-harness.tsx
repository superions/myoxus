// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { SWRConfigProvider } from "@myoxus/core/components/providers/swr-config-provider";
import { GraphQLService } from "@myoxus/core/modules/server/services/graphql";
import { TagService } from "@myoxus/core/modules/tag/service/tag";
import {
  DatabaseFilterConjunction,
  resetDatabaseViewUserStateMutation,
  saveDatabaseViewUserStateMutation,
  updateDatabaseViewMutation,
  upsertDatabaseViewUserStateMutation,
} from "@myoxus/graphql";
import { type FrameworkProvider, FrameworkRoot, LiveData } from "@myoxus/infra";
import { ConfirmModalProvider } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { render } from "@testing-library/react";
import { vi } from "vitest";

import { DatabaseConflictProvider } from "./presence/conflict-controller";
import { record as defaultRecord } from "./test-fixtures";
import type { DatabaseRecord, DatabaseView } from "./types";
import type {
  DatabaseEffectiveViewState,
  DatabaseViewControlSection,
  DatabaseViewEditScope,
} from "./view-controls/filter-tree";
import { ViewSettingsModal } from "./view-controls/view-settings-modal";

/**
 * Render the settings owner without mounting the Database page, every view,
 * row detail, presence and Workbench integration. Host tests separately prove
 * that toolbar actions select and open the correct settings section.
 */
export function renderDatabaseViewSettings(options: {
  editScope?: DatabaseViewEditScope;
  effectiveState?: Partial<DatabaseEffectiveViewState>;
  gql?: (request: { mutation?: unknown; query?: unknown }) => unknown;
  record?: DatabaseRecord;
  section: DatabaseViewControlSection;
  tagService?: unknown;
  view?: DatabaseView;
}) {
  const record = options.record ?? defaultRecord;
  const view = options.view ?? record.views[0]!;
  const config =
    view.config.table ??
    view.config.kanban ??
    view.config.list ??
    view.config.gallery ??
    view.config.calendar ??
    view.config.timeline ??
    view.config.progress!;
  const savedFilterTree =
    config.filterTree ??
    (config.filter.length
      ? {
          conjunction: DatabaseFilterConjunction.And,
          groups: [],
          rules: config.filter,
        }
      : null);
  const effectiveState: DatabaseEffectiveViewState = {
    canEditShared: true,
    canEditRows: true,
    effectiveFieldWidths: view.config.table?.fieldWidths ?? [],
    effectiveFilterTree: savedFilterTree,
    effectiveSort: config.sort,
    personalState: null,
    savedFilterTree,
    savedSort: config.sort,
    searchText: "",
    viewId: view.id,
    ...options.effectiveState,
  };
  const customGql = options.gql;
  const gql = vi.fn((request: { mutation?: unknown; query?: unknown }) => {
    const operation = request.query ?? request.mutation;
    if (customGql) return customGql(request);
    if (operation === updateDatabaseViewMutation) {
      return { updateDatabaseView: view };
    }
    if (operation === upsertDatabaseViewUserStateMutation) {
      return { upsertDatabaseViewUserState: { editRevision: 2 } };
    }
    if (operation === resetDatabaseViewUserStateMutation) {
      return { resetDatabaseViewUserState: true };
    }
    if (operation === saveDatabaseViewUserStateMutation) {
      return { saveDatabaseViewUserState: view };
    }
    return {};
  });
  const tagService =
    options.tagService ??
    ({
      tagColors: [],
      tagList: { tagMetas$: new LiveData([]) },
    } as const);
  const framework = {
    get(token: unknown) {
      if (token === GraphQLService) return { gql };
      if (token === TagService) return tagService;
      throw new Error(`Unexpected settings test token: ${String(token)}`);
    },
    getOptional() {
      return undefined;
    },
  } as unknown as FrameworkProvider;
  const onChanged = vi.fn(async () => {});
  const onClose = vi.fn();
  const onEditScopeChange = vi.fn();
  const onEffectiveStateChanged = vi.fn(async () => {});

  render(
    <FrameworkRoot framework={framework}>
      <SWRConfigProvider>
        <MyoxusUIProvider env="test">
          <ConfirmModalProvider>
            <DatabaseConflictProvider>
              <ViewSettingsModal
                databaseId={record.database.id}
                effectiveState={effectiveState}
                editScope={options.editScope ?? "shared"}
                onChanged={onChanged}
                onClose={onClose}
                onEditScopeChange={onEditScopeChange}
                onEffectiveStateChanged={onEffectiveStateChanged}
                open
                record={record}
                section={options.section}
                view={view}
              />
            </DatabaseConflictProvider>
          </ConfirmModalProvider>
        </MyoxusUIProvider>
      </SWRConfigProvider>
    </FrameworkRoot>,
  );

  return {
    gql,
    onChanged,
    onClose,
    onEditScopeChange,
    onEffectiveStateChanged,
  };
}
