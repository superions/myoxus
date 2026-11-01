import { LiveData, Store } from "@myoxus/infra";
import type { Observable } from "rxjs";

import type { DocRecord, DocsService } from "../../doc";

function isJournalString(j?: string | false) {
  return j ? !!j?.match(/^\d{4}-\d{2}-\d{2}$/) : false;
}

export class JournalStore extends Store {
  constructor(private readonly docsService: DocsService) {
    super();
  }

  private readonly journalPropertyValues$ = LiveData.from(
    this.docsService.propertyValues$("journal"),
    new Map<string, string | undefined>(),
  );

  private readonly nonTrashDocIds$ = LiveData.from(
    this.docsService.allNonTrashDocIds$(),
    [],
  );

  private readonly journalDocsByDate$ = LiveData.computed((get) => {
    const journalValues = get(this.journalPropertyValues$);
    const nonTrashDocIds = get(this.nonTrashDocIds$);
    const docsMap = get(this.docsService.list.docsMap$);
    const byDate = new Map<string, DocRecord[]>();

    // The journal sidebar only needs a date->docs index. Building it from the
    // property table and non-trash doc-id stream avoids subscribing to every
    // DocRecord's meta/properties LiveData during each sidebar render.
    for (const docId of nonTrashDocIds) {
      const journal = journalValues.get(docId);
      if (!journal || !isJournalString(journal)) continue;
      const doc = docsMap.get(docId);
      if (!doc) continue;
      const bucket = byDate.get(journal);
      if (bucket) {
        bucket.push(doc);
      } else {
        byDate.set(journal, [doc]);
      }
    }

    return byDate;
  });

  allJournalDates$ = LiveData.computed((get) => {
    return new Set(get(this.journalDocsByDate$).keys());
  });

  watchDocJournalDate(docId: string): Observable<string | undefined> {
    return LiveData.computed((get) => {
      const doc = get(this.docsService.list.doc$(docId));
      if (!doc) {
        // if doc not exists
        return undefined;
      }
      const journal = get(doc.journalDate$);
      if (journal && !isJournalString(journal)) {
        return undefined;
      }
      return journal ?? undefined;
    });
  }

  getDocJournalDate(docId: string): string | undefined {
    const doc = this.docsService.list.doc$(docId).value;
    if (!doc) return undefined;

    const journal = doc.journalDate$.value;
    if (journal && !isJournalString(journal)) return undefined;
    return journal ?? undefined;
  }

  setDocJournalDate(docId: string, date: string) {
    const doc = this.docsService.list.doc$(docId).value;
    if (!doc) {
      // doc not exists, do nothing
      return;
    }
    void this.docsService.setDocJournalDate(docId, date);
  }

  removeDocJournalDate(docId: string) {
    void this.docsService.setDocJournalDate(docId, null);
  }

  getDocsByJournalDate(date: string) {
    return this.journalDocsByDate$.value.get(date) ?? [];
  }
  docsByJournalDate$(date: string) {
    return LiveData.computed(
      (get) => get(this.journalDocsByDate$).get(date) ?? [],
    );
  }
}
