/**
 * @vitest-environment happy-dom
 */

import { Framework, LiveData } from "@myoxus/infra";
import { firstValueFrom, of } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import { TemplateFilterProvider } from "../../collection-rules/impls/filters/template";
import { DocsService } from "../../doc";

function createTemplateFilterProvider(entries: Map<string, boolean>) {
  const propertyValues$ = vi.fn(() => of(entries));
  const framework = new Framework();
  framework
    .service(DocsService, { propertyValues$ } as any)
    .service(TemplateFilterProvider, [DocsService]);

  return {
    propertyValues$,
    provider: framework.provider().get(TemplateFilterProvider),
  };
}

describe("TemplateFilterProvider document visibility", () => {
  const docs = new Map<string, boolean>([
    ["template-doc-id", true],
    ["regular-doc-id", false],
  ]);

  test("method=is value=false keeps only non-template docs", async () => {
    const { propertyValues$, provider } = createTemplateFilterProvider(docs);

    const result = await firstValueFrom(
      provider.filter$({ method: "is", value: "false" } as any),
    );

    expect(propertyValues$).toHaveBeenCalledExactlyOnceWith("isTemplate");
    expect([...result]).toEqual(["regular-doc-id"]);
  });

  test("method=is value=true keeps only template docs", async () => {
    const { provider } = createTemplateFilterProvider(docs);

    const result = await firstValueFrom(
      provider.filter$({ method: "is", value: "true" } as any),
    );

    expect([...result]).toEqual(["template-doc-id"]);
  });

  test("method=is-not inverts the template predicate", async () => {
    const { provider } = createTemplateFilterProvider(docs);

    const notTemplates = await firstValueFrom(
      provider.filter$({ method: "is-not", value: "true" } as any),
    );
    const notRegularDocs = await firstValueFrom(
      provider.filter$({ method: "is-not", value: "false" } as any),
    );

    expect([...notTemplates]).toEqual(["regular-doc-id"]);
    expect([...notRegularDocs]).toEqual(["template-doc-id"]);
  });

  test("reactive property sources update the filter result", async () => {
    const source$ = new LiveData(
      new Map<string, boolean>([
        ["template-doc-id", true],
        ["regular-doc-id", false],
      ]),
    );
    const propertyValues$ = vi.fn(() => source$);
    const framework = new Framework();
    framework
      .service(DocsService, { propertyValues$ } as any)
      .service(TemplateFilterProvider, [DocsService]);
    const provider = framework.provider().get(TemplateFilterProvider);
    const results: string[][] = [];
    const subscription = provider
      .filter$({ method: "is", value: "false" } as any)
      .subscribe((value) => results.push([...value]));

    source$.next(
      new Map<string, boolean>([
        ["template-doc-id", true],
        ["regular-doc-id", false],
        ["new-doc-id", false],
      ]),
    );

    expect(results).toEqual([
      ["regular-doc-id"],
      ["regular-doc-id", "new-doc-id"],
    ]);
    subscription.unsubscribe();
  });

  test("unsupported methods fail loudly instead of silently leaking docs", () => {
    const { provider } = createTemplateFilterProvider(docs);

    expect(() =>
      provider.filter$({ method: "contains", value: "false" } as any),
    ).toThrow("Unsupported method: contains");
  });
});
