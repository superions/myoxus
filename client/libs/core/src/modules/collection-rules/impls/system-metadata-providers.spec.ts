// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { DocsService } from "@myoxus/core/modules/doc";
import { Framework } from "@myoxus/infra";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, test } from "vitest";

import { CreatedByFilterProvider } from "./filters/created-by";
import { DocPrimaryModeFilterProvider } from "./filters/doc-primary-mode";
import { EdgelessThemeFilterProvider } from "./filters/edgeless-theme";
import { EmptyJournalFilterProvider } from "./filters/empty-journal";
import { IntegrationTypeFilterProvider } from "./filters/integration-type";
import { JournalFilterProvider } from "./filters/journal";
import { PageWidthFilterProvider } from "./filters/page-width";
import { TemplateFilterProvider } from "./filters/template";
import { UpdatedByFilterProvider } from "./filters/updated-by";
import { CreatedByGroupByProvider } from "./group-by/created-by";
import { DocPrimaryModeGroupByProvider } from "./group-by/doc-primary-mode";
import { EdgelessThemeGroupByProvider } from "./group-by/edgeless-theme";
import { IntegrationTypeGroupByProvider } from "./group-by/integration-type";
import { JournalGroupByProvider } from "./group-by/journal";
import { PageWidthGroupByProvider } from "./group-by/page-width";
import { TemplateGroupByProvider } from "./group-by/template";
import { UpdatedByGroupByProvider } from "./group-by/updated-by";
import { CreatedByOrderByProvider } from "./order-by/created-by";
import { DocPrimaryModeOrderByProvider } from "./order-by/doc-primary-mode";
import { EdgelessThemeOrderByProvider } from "./order-by/edgeless-theme";
import { IntegrationTypeOrderByProvider } from "./order-by/integration-type";
import { JournalOrderByProvider } from "./order-by/journal";
import { PageWidthOrderByProvider } from "./order-by/page-width";
import { TemplateOrderByProvider } from "./order-by/template";
import { UpdatedByOrderByProvider } from "./order-by/updated-by";

const ids = new Set(["doc-a", "doc-b", "doc-c"]);
const values = {
  createdBy: new Map([
    ["doc-a", "user-1"],
    ["doc-b", "user-2"],
    ["doc-c", "user-1"],
  ]),
  updatedBy: new Map([
    ["doc-a", "user-2"],
    ["doc-b", "user-1"],
    ["doc-c", "user-1"],
  ]),
  primaryMode: new Map([
    ["doc-a", "edgeless"],
    ["doc-b", "page"],
    ["doc-c", "edgeless"],
  ]),
  edgelessColorTheme: new Map([
    ["doc-a", "dark"],
    ["doc-b", "system"],
    ["doc-c", "light"],
  ]),
  journal: new Map<string, string | undefined>([
    ["doc-a", "2056-01-20"],
    ["doc-b", undefined],
    ["doc-c", "2056-01-21"],
  ]),
  integrationType: new Map<string, string | undefined>([
    ["doc-a", "readwise"],
    ["doc-b", undefined],
    ["doc-c", "readwise"],
  ]),
  pageWidth: new Map([
    ["doc-a", "fullWidth"],
    ["doc-b", "standard"],
    ["doc-c", "standard"],
  ]),
  isTemplate: new Map<string, string | undefined>([
    ["doc-a", "true"],
    ["doc-b", undefined],
    ["doc-c", "true"],
  ]),
} satisfies Record<string, Map<string, string | undefined>>;

const docsService = {
  propertyValues$: (key: keyof typeof values) => of(values[key]),
  allDocsUpdatedDate$: () =>
    of([
      { id: "doc-a", updatedDate: undefined },
      { id: "doc-b", updatedDate: 10 },
      { id: "doc-c", updatedDate: 20 },
    ]),
} as unknown as DocsService;

function createProvider(provider: unknown): any {
  const framework = new Framework();
  const testFramework = framework as any;
  testFramework.service(DocsService, docsService);
  testFramework.service(provider, [DocsService]);
  return framework.provider().get(provider as never);
}

function params(method: string, value?: string) {
  return { key: "", method, type: "system", value } as never;
}

function sorted(values: Set<string>) {
  return [...values].sort();
}

describe("native document metadata collection providers", () => {
  test("all nine filter families preserve their matches", async () => {
    const cases = [
      [
        createProvider(CreatedByFilterProvider),
        params("include", "user-1"),
        ["doc-a", "doc-c"],
      ],
      [
        createProvider(UpdatedByFilterProvider),
        params("include", "user-2"),
        ["doc-a"],
      ],
      [
        createProvider(DocPrimaryModeFilterProvider),
        params("is", "edgeless"),
        ["doc-a", "doc-c"],
      ],
      [
        createProvider(EdgelessThemeFilterProvider),
        params("is", "dark"),
        ["doc-a"],
      ],
      [
        createProvider(EmptyJournalFilterProvider),
        params("is", "true"),
        ["doc-a"],
      ],
      [
        createProvider(IntegrationTypeFilterProvider),
        params("is", "readwise"),
        ["doc-a", "doc-c"],
      ],
      [
        createProvider(JournalFilterProvider),
        params("is", "true"),
        ["doc-a", "doc-c"],
      ],
      [
        createProvider(PageWidthFilterProvider),
        params("is", "fullWidth"),
        ["doc-a"],
      ],
      [
        createProvider(TemplateFilterProvider),
        params("is", "true"),
        ["doc-a", "doc-c"],
      ],
    ] as const;

    for (const [provider, input, expected] of cases) {
      const result = (await firstValueFrom(
        provider.filter$(input),
      )) as Set<string>;
      expect(sorted(result)).toEqual(expected);
    }
  });

  test("all metadata-backed group families preserve their group keys", async () => {
    const cases = [
      [createProvider(CreatedByGroupByProvider), "user-1", ["doc-a", "doc-c"]],
      [createProvider(UpdatedByGroupByProvider), "user-2", ["doc-a"]],
      [
        createProvider(DocPrimaryModeGroupByProvider),
        "edgeless",
        ["doc-a", "doc-c"],
      ],
      [createProvider(EdgelessThemeGroupByProvider), "dark", ["doc-a"]],
      [
        createProvider(IntegrationTypeGroupByProvider),
        "readwise",
        ["doc-a", "doc-c"],
      ],
      [createProvider(JournalGroupByProvider), "true", ["doc-a", "doc-c"]],
      [createProvider(PageWidthGroupByProvider), "fullWidth", ["doc-a"]],
      [createProvider(TemplateGroupByProvider), "true", ["doc-a", "doc-c"]],
    ] as const;

    for (const [provider, group, expected] of cases) {
      const result = (await firstValueFrom(
        provider.groupBy$(of(ids), params("is")),
      )) as Map<string, Set<string>>;
      expect(sorted(result.get(group) ?? new Set())).toEqual(expected);
    }
  });

  test("all metadata-backed order families preserve ascending order", async () => {
    const cases = [
      [createProvider(CreatedByOrderByProvider), ["doc-a", "doc-c", "doc-b"]],
      [createProvider(UpdatedByOrderByProvider), ["doc-b", "doc-c", "doc-a"]],
      [
        createProvider(DocPrimaryModeOrderByProvider),
        ["doc-a", "doc-c", "doc-b"],
      ],
      [
        createProvider(EdgelessThemeOrderByProvider),
        ["doc-a", "doc-c", "doc-b"],
      ],
      [createProvider(IntegrationTypeOrderByProvider), ["doc-a", "doc-c"]],
      [createProvider(JournalOrderByProvider), ["doc-b", "doc-a", "doc-c"]],
      [createProvider(PageWidthOrderByProvider), ["doc-a", "doc-b", "doc-c"]],
      [createProvider(TemplateOrderByProvider), ["doc-b", "doc-a", "doc-c"]],
    ] as const;

    for (const [provider, expected] of cases) {
      await expect(
        firstValueFrom(provider.orderBy$(of(ids), { desc: false } as never)),
      ).resolves.toEqual(expected);
    }
  });
});
