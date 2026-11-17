// SPDX-License-Identifier: AGPL-3.0-or-later

import { generateUrl } from "@myoxus/core/components/hooks/myoxus/use-share-url";

import {
  metadataIndexDisplayValue,
  REGISTER_FIELD_LABEL_KEYS,
} from "../../document-metadata/utils";
import {
  registerMetadataLookups,
  documentIndexPresentation,
  overviewRegisterProperties,
} from "@myoxus/core/desktop/pages/workspace/overview/presentation";
import type { CanonicalMetadataKey } from "../../document-metadata/types";
import {
  formatRegionalDateTime,
  normalizeDateFormatPreference,
  normalizeTimeFormatPreference,
  type RegionalFormatPreferences,
} from "../../i18n/regional-format";
import type { Server } from "../../server";
import { UserPreferencesService } from "../../server/services/user-preferences";
import { workspaceOverviewQuery } from "@myoxus/graphql";
import type {
  DocumentIndexOutputProvider,
  DocumentIndexRow,
  DocumentIndexTable,
} from "@virgultum/editor/shared/services";
import type {
  DocumentIndexQuery,
  DocumentIndexProps,
} from "@virgultum/editor/model";
import type { GraphQLService } from "../../server/services/graphql";
import { I18n } from "@myoxus/i18n";

export function documentIndexRegionalPreferences(
  server?: Server | null,
): RegionalFormatPreferences {
  const values = server?.scope.get(UserPreferencesService).userPreferences$
    .value?.effectiveValues;
  return {
    locale: values?.locale ?? I18n.language ?? "en",
    timezone: values?.timezone ?? "UTC",
    dateFormat: normalizeDateFormatPreference(values?.dateFormat),
    timeFormat: normalizeTimeFormatPreference(values?.timeFormat),
  };
}

/** One transport owner for editor pages and complete, transient export reads. */
export class CoreDocumentIndexProvider implements DocumentIndexOutputProvider {
  constructor(
    private readonly graphql: GraphQLService | undefined,
    readonly workspaceId: string,
    private readonly baseUrl = location.origin,
    private readonly preferences = () => documentIndexRegionalPreferences(),
  ) {}
  get emptyText() {
    return I18n["com.myoxus.workspace-overview.documents.empty"]();
  }
  async read(
    query: DocumentIndexQuery,
    offset: number,
    signal: AbortSignal,
    workspaceId = this.workspaceId,
  ) {
    if (!this.graphql || !navigator.onLine)
      throw new Error("Directory unavailable offline");
    const result = await this.graphql.gql({
      query: workspaceOverviewQuery,
      variables: {
        id: workspaceId,
        folderId: query.folderId,
        registerPresentation: documentIndexPresentation(query),
        first: 50,
        offset,
      },
      context: { signal },
    });
    const page = result.workspace?.overview;
    if (!page) throw new Error("Directory source unavailable");
    return page;
  }
  href(workspaceId: string, id: string) {
    const url = generateUrl({
      baseUrl: this.baseUrl,
      workspaceId: encodeURIComponent(workspaceId),
      pageId: encodeURIComponent(id),
    });
    if (!url) throw new Error("Directory document URL unavailable");
    return url;
  }
  async resolve(
    query: DocumentIndexQuery,
    workspaceId = this.workspaceId,
  ): Promise<DocumentIndexRow[]> {
    return (await this.all(query, workspaceId)).map((row) => ({
      title: row.title || I18n["Untitled"](),
      href: this.href(row.resource.workspaceId, row.resource.id),
    }));
  }

  async resolveTable(
    props: DocumentIndexProps,
    workspaceId = this.workspaceId,
  ): Promise<DocumentIndexTable> {
    const columns = props.displayProperties.map((key) =>
      key.slice("system:".length),
    );
    if (
      !columns.includes("title") ||
      new Set(columns).size !== columns.length ||
      columns.some(
        (key) =>
          !overviewRegisterProperties.includes(
            key as (typeof overviewRegisterProperties)[number],
          ),
      )
    )
      throw new Error("Unsupported report columns");
    const documents = await this.all(props.query, workspaceId);
    const lookups = registerMetadataLookups(documents);
    const preferences = this.preferences();
    const messages = {
      loading: I18n["com.myoxus.document-metadata.loading"](),
      notSet: I18n["com.myoxus.document-metadata.value.not-set"](),
      unversionedChanges:
        I18n["com.myoxus.document-metadata.value.unversioned-changes"](),
      version: I18n["Version"](),
      changedSuffix: I18n["com.myoxus.document-metadata.value.changed"](),
    };
    const headers = columns.map((key) =>
      I18n.t(
        REGISTER_FIELD_LABEL_KEYS[
          key as keyof typeof REGISTER_FIELD_LABEL_KEYS
        ],
      ),
    );
    const rows = documents.map((row) =>
      columns.map((key) => {
        if (key === "title")
          return {
            text: row.title || I18n["Untitled"](),
            href: this.href(row.resource.workspaceId, row.resource.id),
          };
        let text: string | null | undefined;
        if (key === "tags") text = row.tags.map((tag) => tag.name).join(", ");
        else if (key === "createdBy") text = row.createdByName;
        else if (key === "createdAt" || key === "updatedAt")
          text = row[key]
            ? formatRegionalDateTime(row[key]!, preferences)
            : null;
        else
          text = row.metadata
            ? metadataIndexDisplayValue(
                row.metadata,
                key as CanonicalMetadataKey,
                lookups,
                messages,
                preferences,
              )
            : null;
        return { text: text || "–" };
      }),
    );
    if (!rows.length)
      rows.push(
        columns.map((key) => ({
          text: key === "title" ? this.emptyText : "–",
        })),
      );
    return { headers, rows };
  }

  private async all(query: DocumentIndexQuery, workspaceId: string) {
    const signal = AbortSignal.timeout(30_000);
    const documents: Awaited<
      ReturnType<CoreDocumentIndexProvider["read"]>
    >["documents"] = [];
    let offset = 0;
    // Match the existing bounded workspace operation; never truncate silently.
    for (;;) {
      const page = await this.read(query, offset, signal, workspaceId);
      if (page.offset !== offset || page.documentCount > 256)
        throw new Error("Directory changed or exceeds export limit");
      documents.push(...page.documents);
      if (!page.hasMore) return documents;
      offset += page.limit;
    }
  }
}
