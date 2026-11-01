/**
 * @vitest-environment happy-dom
 */

import { Framework, LiveData } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { WorkspaceDBService } from "../../db";
import { TemplateDocSetting } from "../entities/setting";
import { customSourceMetadata } from "../services/source-metadata";
import { TemplateDocService } from "../services/template-doc";
import { TemplateDocSettingStore } from "../store/setting";
import type { TemplateDocSettings } from "../type";

function createSettingStore(initial: TemplateDocSettings = {}) {
  let settings: TemplateDocSettings = { ...initial };
  const rows$ = new LiveData([{ key: "templateDoc", value: settings }]);
  const create = vi.fn(
    ({ value }: { key: string; value: TemplateDocSettings }) => {
      settings = { ...value };
      rows$.next([{ key: "templateDoc", value: settings }]);
    },
  );
  const dbService = {
    userdataDB$: new LiveData({
      settings: {
        isLoading$: new LiveData(false),
        find$: vi.fn(() => rows$),
        find: vi.fn(() => [{ key: "templateDoc", value: settings }]),
        create,
      },
    }),
  } as unknown as WorkspaceDBService;
  const framework = new Framework();
  framework
    .service(WorkspaceDBService, dbService)
    .service(TemplateDocService, {
      assertDocumentTemplateSource:
        TemplateDocService.prototype.assertDocumentTemplateSource,
      resolveSourceMetadataForDoc: async (id: string) =>
        customSourceMetadata(id, {
          category: id === "building-block" ? "building-blocks" : null,
          tags: [],
        }),
    } as unknown as TemplateDocService)
    .store(TemplateDocSettingStore, [WorkspaceDBService])
    .entity(TemplateDocSetting, [TemplateDocSettingStore]);

  return {
    create,
    setting: framework.provider().get(TemplateDocSetting),
  };
}

describe("TemplateDocSetting", () => {
  test("persists page-template enablement without dropping existing picker assignments", () => {
    const { create, setting } = createSettingStore({
      enablePageTemplate: false,
      pageTemplateId: "page-template",
      journalTemplateId: "journal-template",
    });

    setting.togglePageTemplate(true);

    expect(create).toHaveBeenCalledExactlyOnceWith({
      key: "templateDoc",
      value: {
        enablePageTemplate: true,
        pageTemplateId: "page-template",
        journalTemplateId: "journal-template",
      },
    });
  });

  test("updates distinct default keys and preserves valid choices when a block is rejected", async () => {
    const { create, setting } = createSettingStore({
      enablePageTemplate: true,
    });

    await setting.updatePageTemplateDocId("page-template");
    await expect(
      setting.updatePageTemplateDocId("building-block"),
    ).rejects.toMatchObject({ reason: "building-block-source" });
    await setting.updateJournalTemplateDocId("journal-template");
    await expect(
      setting.updateJournalTemplateDocId("building-block"),
    ).rejects.toMatchObject({ reason: "building-block-source" });
    await setting.updatePageTemplateDocId(undefined);

    expect(create.mock.calls.map(([entry]) => entry.value)).toEqual([
      {
        enablePageTemplate: true,
        pageTemplateId: "page-template",
      },
      {
        enablePageTemplate: true,
        pageTemplateId: "page-template",
        journalTemplateId: "journal-template",
      },
      {
        enablePageTemplate: true,
        pageTemplateId: undefined,
        journalTemplateId: "journal-template",
      },
    ]);
  });

  test("clears a withdrawn journal reference without changing another selection or page enablement", async () => {
    const { create, setting } = createSettingStore({
      enablePageTemplate: false,
      pageTemplateId: "another",
      journalTemplateId: "retired",
    });
    expect(
      await setting.replaceJournalTemplateDocId("unrelated", undefined),
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(
      await setting.replaceJournalTemplateDocId("retired", undefined),
    ).toBe(true);
    expect(setting.journalTemplateDocId$.value).toBeUndefined();
    expect(setting.pageTemplateDocId$.value).toBe("another");
    expect(setting.enablePageTemplate$.value).toBe(false);
    expect(
      await setting.replaceJournalTemplateDocId("retired", undefined),
    ).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("reactively exposes the latest stored template settings", async () => {
    const { setting } = createSettingStore({
      enablePageTemplate: true,
      pageTemplateId: "page-template",
      journalTemplateId: "journal-template",
    });

    expect(setting.enablePageTemplate$.value).toBe(true);
    expect(setting.pageTemplateDocId$.value).toBe("page-template");
    expect(setting.journalTemplateDocId$.value).toBe("journal-template");

    await setting.updateJournalTemplateDocId(undefined);

    expect(setting.enablePageTemplate$.value).toBe(true);
    expect(setting.pageTemplateDocId$.value).toBe("page-template");
    expect(setting.journalTemplateDocId$.value).toBeUndefined();
  });

  test("replaces a page default only when it still points at the retired source", async () => {
    const { create, setting } = createSettingStore({
      enablePageTemplate: true,
      pageTemplateId: "retired-source",
    });

    expect(
      await setting.replacePageTemplateDocId("other-source", "replacement"),
    ).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(
      await setting.replacePageTemplateDocId("retired-source", "replacement"),
    ).toBe(true);
    expect(setting.pageTemplateDocId$.value).toBe("replacement");
  });
});
