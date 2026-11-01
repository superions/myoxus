// SPDX-License-Identifier: AGPL-3.0-or-later

import type { DocsService } from "@myoxus/core/modules/doc";
import { createIdentifier, Framework } from "@myoxus/infra";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, test } from "vitest";

import { PageKindFilterProvider } from "./page-kind";

describe("PageKindFilterProvider", () => {
  const DocsServiceForTest = createIdentifier<DocsService>(
    "DocsServiceForPageKindTest",
  );
  const framework = new Framework();
  framework.impl(DocsServiceForTest, {
    allDocIds$: () => of(["document-1", "document-2"]),
  } as unknown as DocsService);
  framework.service(PageKindFilterProvider, [DocsServiceForTest]);
  const provider = framework.provider().get(PageKindFilterProvider);

  test.each(["all", "document"])(
    "keeps documents for the %s Page-kind value",
    async (value) => {
      await expect(
        firstValueFrom(
          provider.filter$({
            type: "system",
            key: "pageKind",
            method: "is",
            value,
          }),
        ),
      ).resolves.toEqual(new Set(["document-1", "document-2"]));
    },
  );

  test("removes documents from a Database-only result", async () => {
    await expect(
      firstValueFrom(
        provider.filter$({
          type: "system",
          key: "pageKind",
          method: "is",
          value: "database",
        }),
      ),
    ).resolves.toEqual(new Set());
  });
});
