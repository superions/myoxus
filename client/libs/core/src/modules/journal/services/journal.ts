import { I18n } from "@myoxus/i18n";
import { LiveData, Service } from "@myoxus/infra";
import dayjs from "dayjs";

import type { DocsService } from "../../doc";
import type {
  TemplateDocService,
  TemplateApplicationService,
} from "../../template-doc";
import type { JournalStore } from "../store/journal";

export type MaybeDate = Date | string | number;

export const JOURNAL_DATE_FORMAT = "YYYY-MM-DD";

export class JournalService extends Service {
  // Journal selectors are used in headers, sidebars and inline menus that can
  // re-render frequently. Cache the LiveData graph per stable key so those
  // renders do not allocate a fresh RxJS subscription tree over all docs.
  private readonly journalDateCache = new Map<
    string,
    LiveData<string | undefined>
  >();
  private readonly journalTodayCache = new Map<string, LiveData<boolean>>();
  private readonly journalsByDateCache = new Map<
    string,
    ReturnType<JournalStore["docsByJournalDate$"]>
  >();

  constructor(
    private readonly store: JournalStore,
    private readonly docsService: DocsService,
    private readonly templateDocService: TemplateDocService,
    private readonly templateApplication: TemplateApplicationService,
  ) {
    super();
  }

  allJournalDates$ = this.store.allJournalDates$;

  journalDate$(docId: string) {
    const cached = this.journalDateCache.get(docId);
    if (cached) return cached;

    const liveData = LiveData.from(
      this.store.watchDocJournalDate(docId),
      this.store.getDocJournalDate(docId),
    );
    this.journalDateCache.set(docId, liveData);
    return liveData;
  }

  getJournalDate(docId: string) {
    return this.store.getDocJournalDate(docId);
  }

  journalToday$(docId: string) {
    const cached = this.journalTodayCache.get(docId);
    if (cached) return cached;

    const liveData = LiveData.computed((get) => {
      const date = get(this.journalDate$(docId));
      if (!date) return false;
      return dayjs(date).isSame(dayjs(), "day");
    });
    this.journalTodayCache.set(docId, liveData);
    return liveData;
  }

  setJournalDate(docId: string, date: string) {
    this.store.setDocJournalDate(docId, date);
  }

  removeJournalDate(docId: string) {
    this.store.removeDocJournalDate(docId);
  }

  journalsByDate$(date: string) {
    const cached = this.journalsByDateCache.get(date);
    if (cached) return cached;

    const liveData = this.store.docsByJournalDate$(date);
    this.journalsByDateCache.set(date, liveData);
    return liveData;
  }

  getJournalsByDate(date: string) {
    return this.store.getDocsByJournalDate(date);
  }

  private createJournal(maybeDate: MaybeDate) {
    const day = dayjs(maybeDate);
    const title = day.format(JOURNAL_DATE_FORMAT);
    const docRecord = this.docsService.createDoc({
      title,
    });
    // set created date to match the journal date
    docRecord.setMeta({
      createDate: dayjs()
        .set("year", day.year())
        .set("month", day.month())
        .set("date", day.date())
        .toDate()
        .getTime(),
    });

    const enablePageTemplate =
      this.templateDocService.setting.enablePageTemplate$.value;
    const pageTemplateDocId =
      this.templateDocService.setting.pageTemplateDocId$.value;
    const journalTemplateDocId =
      this.templateDocService.setting.journalTemplateDocId$.value;
    const instantiate = (templateDocId: string) =>
      this.templateApplication.apply(
        templateDocId,
        {
          creationContext: {},
          date: title,
          regionalPreferences: {
            locale: I18n.language || "en",
            timezone: "UTC",
            dateFormat: "locale",
            timeFormat: "locale",
          },
          targetDocId: docRecord.id,
          titlePolicy: "preserve",
        },
        "journal",
      );
    // if journal template configured
    if (journalTemplateDocId) {
      void instantiate(journalTemplateDocId);
    }
    // journal template not configured, use page template
    else if (enablePageTemplate && pageTemplateDocId) {
      void instantiate(pageTemplateDocId);
    }
    this.setJournalDate(docRecord.id, title);
    return docRecord;
  }

  ensureJournalByDate(maybeDate: MaybeDate) {
    const day = dayjs(maybeDate);
    const title = day.format(JOURNAL_DATE_FORMAT);
    const docs = this.getJournalsByDate(title);
    if (docs.length) return docs[0];
    return this.createJournal(maybeDate);
  }
}
