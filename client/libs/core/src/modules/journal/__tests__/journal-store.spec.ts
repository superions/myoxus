/**
 * @vitest-environment happy-dom
 */

import { Framework, LiveData } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { DocsService } from "../../doc";
import {
  TemplateDocService,
  TemplateApplicationService,
} from "../../template-doc";
import { JournalService } from "../services/journal";
import { JournalStore } from "../store/journal";

function journalDoc(id: string, journal: string, trash = false) {
  return {
    id,
    journal,
    trash,
    journalDate$: new LiveData(journal),
    properties$: new LiveData({ journal }),
    trash$: new LiveData(trash),
  };
}

function createStore(
  docs: ReturnType<typeof journalDoc>[],
  templateSetting: {
    enablePageTemplate?: boolean;
    pageTemplateDocId?: string | null;
    journalTemplateDocId?: string | null;
  } = {},
) {
  const docsMap$ = new LiveData<Map<string, any>>(
    new Map(docs.map((doc) => [doc.id, doc])),
  );
  const journalValues$ = new LiveData(
    new Map(docs.map((doc) => [doc.id, doc.journal])),
  );
  const nonTrashDocIds$ = new LiveData(
    docs.filter((doc) => !doc.trash).map((doc) => doc.id),
  );
  const createdDocs: Array<{
    id: string;
    properties$: LiveData<Record<string, unknown>>;
    setMeta: ReturnType<typeof vi.fn>;
    trash$: LiveData<boolean>;
  }> = [];
  const createDoc = vi.fn(() => {
    const doc = {
      id: `created-${createdDocs.length + 1}`,
      journal: "",
      journalDate$: new LiveData<string | undefined>(undefined),
      properties$: new LiveData({}),
      setMeta: vi.fn(),
      trash: false,
      trash$: new LiveData(false),
    };
    createdDocs.push(doc);
    docsMap$.next(new Map([...docsMap$.value, [doc.id, doc]]));
    nonTrashDocIds$.next([...nonTrashDocIds$.value, doc.id]);
    return doc;
  });
  const setDocJournalDate = vi.fn();
  const instantiateTemplate = vi.fn(async () => ({
    ok: true,
    docId: "created-1",
  }));
  const docsService = {
    list: {
      docs$: new LiveData(docs),
      docsMap$,
      doc$: (id: string) =>
        docsMap$.selector((docsById) => docsById.get(id) ?? undefined),
    },
    propertyValues$: () => journalValues$,
    allNonTrashDocIds$: () => nonTrashDocIds$,
    createDoc,
    setDocJournalDate,
  } as unknown as DocsService;
  const framework = new Framework();
  const templateDocService = {
    setting: {
      enablePageTemplate$: new LiveData(
        templateSetting.enablePageTemplate ?? false,
      ),
      journalTemplateDocId$: new LiveData(
        templateSetting.journalTemplateDocId ?? null,
      ),
      pageTemplateDocId$: new LiveData(
        templateSetting.pageTemplateDocId ?? null,
      ),
    },
  };
  framework.service(DocsService, docsService);
  framework.service(TemplateDocService, templateDocService as any);
  framework.service(TemplateApplicationService, {
    apply: instantiateTemplate,
  } as any);
  framework.store(JournalStore, [DocsService]);
  framework.service(JournalService, [
    JournalStore,
    DocsService,
    TemplateDocService,
    TemplateApplicationService,
  ]);
  return {
    createDoc,
    createdDocs,
    docsService,
    instantiateTemplate,
    journalValues$,
    nonTrashDocIds$,
    service: framework.provider().get(JournalService),
    setDocJournalDate,
    store: framework.provider().get(JournalStore),
  };
}

describe("JournalStore", () => {
  test("excludes trashed journals from active journal-date lookups", () => {
    const trashed = journalDoc("trashed", "2056-01-18", true);
    const active = journalDoc("active", "2056-01-19", false);
    const { store } = createStore([trashed, active]);

    expect(store.getDocsByJournalDate("2056-01-18")).toEqual([]);
    expect(store.docsByJournalDate$("2056-01-18").value).toEqual([]);
    expect(store.docsByJournalDate$("2056-01-19").value).toEqual([active]);
    expect([...store.allJournalDates$.value].sort()).toEqual(["2056-01-19"]);
  });

  test("reacts when a journal is moved to or restored from trash", () => {
    const doc = journalDoc("journal", "2056-01-20", false);
    const { store, nonTrashDocIds$ } = createStore([doc]);
    const byDate$ = store.docsByJournalDate$("2056-01-20");

    expect(byDate$.value).toEqual([doc]);

    nonTrashDocIds$.next([]);
    expect(byDate$.value).toEqual([]);
    expect([...store.allJournalDates$.value]).toEqual([]);

    nonTrashDocIds$.next([doc.id]);
    expect(byDate$.value).toEqual([doc]);
    expect([...store.allJournalDates$.value]).toEqual(["2056-01-20"]);
  });

  test("scans document properties directly instead of allocating per-doc selectors", () => {
    const docs = Array.from({ length: 128 }, (_, index) =>
      journalDoc(
        `doc-${index}`,
        index === 42 ? "2056-01-21" : "not-a-journal-date",
        false,
      ),
    );
    const selectorSpies = docs.map((doc) =>
      vi.spyOn(doc.properties$, "selector"),
    );
    const { store, journalValues$ } = createStore(docs);

    expect([...store.allJournalDates$.value]).toEqual(["2056-01-21"]);
    expect(store.docsByJournalDate$("2056-01-21").value).toEqual([docs[42]]);
    expect(selectorSpies.every((spy) => spy.mock.calls.length === 0)).toBe(
      true,
    );

    const updatedJournalValues = new Map(journalValues$.value);
    updatedJournalValues.set(docs[1].id, "2056-01-22");
    journalValues$.next(updatedJournalValues);
    expect([...store.allJournalDates$.value].sort()).toEqual([
      "2056-01-21",
      "2056-01-22",
    ]);
  });

  test("writes journal dates through the native document metadata boundary", () => {
    const doc = journalDoc("journal", "2056-01-20", false);
    const { store, setDocJournalDate } = createStore([doc]);

    store.setDocJournalDate(doc.id, "2056-01-21");
    store.removeDocJournalDate(doc.id);

    expect(setDocJournalDate).toHaveBeenNthCalledWith(1, doc.id, "2056-01-21");
    expect(setDocJournalDate).toHaveBeenNthCalledWith(2, doc.id, null);
  });

  test("seeds journal-date LiveData from the current document snapshot", () => {
    const doc = journalDoc("journal", "2056-01-23", false);
    const { service } = createStore([doc]);

    expect(service.journalDate$(doc.id).value).toBe("2056-01-23");
  });

  test("keeps same-day duplicate journals addressable for conflict UI owners", () => {
    const first = journalDoc("journal-a", "2056-01-24", false);
    const second = journalDoc("journal-b", "2056-01-24", false);
    const { service, store } = createStore([first, second]);

    expect(store.getDocsByJournalDate("2056-01-24")).toEqual([first, second]);
    expect(service.getJournalsByDate("2056-01-24")).toEqual([first, second]);
    expect(service.journalsByDate$("2056-01-24").value).toEqual([
      first,
      second,
    ]);
  });

  test("reuses an existing daily journal instead of creating a duplicate", () => {
    const existing = journalDoc("journal-existing", "2056-01-25", false);
    const { createDoc, service, setDocJournalDate } = createStore([existing]);

    const result = service.ensureJournalByDate("2056-01-25");

    expect(result).toBe(existing);
    expect(createDoc).not.toHaveBeenCalled();
    expect(setDocJournalDate).not.toHaveBeenCalled();
  });

  test("creates a new daily journal with native metadata when no journal exists", () => {
    const { createDoc, createdDocs, service, setDocJournalDate } = createStore(
      [],
    );

    const result = service.ensureJournalByDate("2056-01-26T10:30:00.000Z");

    expect(result).toBe(createdDocs[0]);
    expect(createDoc).toHaveBeenCalledExactlyOnceWith({
      title: "2056-01-26",
    });
    expect(createdDocs[0]?.setMeta).toHaveBeenCalledOnce();
    expect(setDocJournalDate).toHaveBeenCalledExactlyOnceWith(
      "created-1",
      "2056-01-26",
    );
  });

  test("uses the configured journal template before the generic page template with the journal date context", async () => {
    const { instantiateTemplate, service } = createStore([], {
      enablePageTemplate: true,
      pageTemplateDocId: "page-template",
      journalTemplateDocId: "journal-template",
    });

    service.ensureJournalByDate("2056-04-25T10:30:00.000Z");
    await Promise.resolve();
    await Promise.resolve();

    expect(instantiateTemplate).toHaveBeenCalledExactlyOnceWith(
      "journal-template",
      expect.objectContaining({
        date: "2056-04-25",
        targetDocId: "created-1",
        titlePolicy: "preserve",
      }),
      "journal",
    );
  });

  test("falls back to the generic page template through the same instantiation path", async () => {
    const { instantiateTemplate, service } = createStore([], {
      enablePageTemplate: true,
      pageTemplateDocId: "page-template",
      journalTemplateDocId: null,
    });

    service.ensureJournalByDate("2056-04-26T10:30:00.000Z");
    await Promise.resolve();
    await Promise.resolve();

    expect(instantiateTemplate).toHaveBeenCalledExactlyOnceWith(
      "page-template",
      expect.objectContaining({
        date: "2056-04-26",
        targetDocId: "created-1",
        titlePolicy: "preserve",
      }),
      "journal",
    );
  });

  test("returns the dated journal immediately even when its optional template fails", async () => {
    const { instantiateTemplate, service, createdDocs, setDocJournalDate } =
      createStore([], {
        journalTemplateDocId: "journal-template",
      });
    let finish!: (value: { ok: boolean; docId: string }) => void;
    instantiateTemplate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    const journal = service.ensureJournalByDate("2056-04-27");
    expect(journal).toBe(createdDocs[0]);
    expect(setDocJournalDate).toHaveBeenCalledExactlyOnceWith(
      "created-1",
      "2056-04-27",
    );
    finish({ ok: false, docId: "" });
    await Promise.resolve();
    expect(journal.trash$.value).toBe(false);
    expect(instantiateTemplate).toHaveBeenCalledOnce();
  });
});
