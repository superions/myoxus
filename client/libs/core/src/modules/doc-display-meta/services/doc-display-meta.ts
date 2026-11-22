import { i18nTime } from "@myoxus/i18n";
import {
  BlockLinkIcon,
  EdgelessIcon,
  LinkIcon,
  PageIcon,
  TodayIcon,
  TomorrowIcon,
  YesterdayIcon,
} from "@myoxus/icons/react";
import { LiveData, Service } from "@myoxus/infra";
import dayjs, { type Dayjs } from "dayjs";

import type { DocRecord, DocsService } from "../../doc";
import type { ExplorerIconService } from "../../explorer-icon/services/explorer-icon";
import type { I18nService } from "../../i18n";
import type { JournalService } from "../../journal";
import { getDocIconComponent } from "./icon";

interface DocDisplayIconOptions {
  /**
   * Override the mode detected inside the hook:
   * by default, it will use the `primaryMode$` of the doc.
   */
  mode?: "edgeless" | "page";
  title?: string; // title alias
  reference?: boolean;
  referenceToNode?: boolean;
  /**
   * @default true
   */
  enableEmojiIcon?: boolean;
}
interface DocDisplayTitleOptions {
  title?: string; // title alias
  reference?: boolean;
  /**
   * @default true
   */
  enableEmojiIcon?: boolean;
}

const rcIcons = {
  BlockLinkIcon,
  EdgelessIcon,
  LinkIcon,
  PageIcon,
  TodayIcon,
  TomorrowIcon,
  YesterdayIcon,
};
export class DocDisplayMetaService extends Service {
  constructor(
    private readonly journalService: JournalService,
    private readonly docsService: DocsService,
    private readonly i18nService: I18nService,
    private readonly explorerIconService: ExplorerIconService,
  ) {
    super();
  }

  getJournalIcon(journalDate: string | Dayjs) {
    return rcIcons[this.getJournalIconName(journalDate)];
  }

  getJournalIconName(journalDate: string | Dayjs) {
    const day = dayjs(journalDate);
    return day.isBefore(dayjs(), "day")
      ? "YesterdayIcon"
      : day.isAfter(dayjs(), "day")
        ? "TomorrowIcon"
        : "TodayIcon";
  }

  icon$(docId: string, options?: DocDisplayIconOptions) {
    return this.iconDescriptor$(docId, options).map((icon) =>
      typeof icon === "string" ? rcIcons[icon] : getDocIconComponent(icon),
    );
  }
  /** Editor and shell resolve the same icon choice in their own rendering tier. */
  iconDescriptor$(docId: string, options?: DocDisplayIconOptions) {
    return LiveData.computed((get) => {
      // Link identity must not depend on its label, target mode or custom icon.
      if (options?.reference) {
        return options.referenceToNode
          ? ("BlockLinkIcon" as const)
          : ("LinkIcon" as const);
      }

      const enableEmojiIcon = options?.enableEmojiIcon !== false;
      const doc = get(this.docsService.list.doc$(docId));
      // link to journal doc
      const journalDateString = get(this.journalService.journalDate$(docId));
      const journalIcon = journalDateString
        ? this.getJournalIconName(journalDateString)
        : undefined;
      const mode = doc ? get(doc.primaryMode$) : undefined;
      const finalMode = options?.mode ?? mode ?? "page";

      // emoji title
      if (enableEmojiIcon) {
        const icon = get(this.explorerIconService.icon$("doc", docId))?.icon;
        if (icon) {
          return icon;
        }
      }

      if (journalIcon) return journalIcon;

      // default icon
      return finalMode === "edgeless"
        ? ("EdgelessIcon" as const)
        : ("PageIcon" as const);
    });
  }

  title$(docId: string, options?: DocDisplayTitleOptions) {
    return LiveData.computed((get) => {
      const lng = get(this.i18nService.i18n.currentLanguageKey$);
      const doc = get(this.docsService.list.doc$(docId));
      const referenced = !!options?.reference;
      const titleAlias = referenced ? options?.title : undefined;
      const originalTitle = doc ? get(doc.title$) : "";
      // journal title
      const journalDateString = get(this.journalService.journalDate$(docId));
      const journalTitle = journalDateString
        ? i18nTime(journalDateString, { absolute: { accuracy: "day" } })
        : undefined;
      // const title = titleAlias ?? journalTitle ?? originalTitle;

      // emoji title
      // if (enableEmojiIcon && title) {
      //   // When the title has only one emoji character,
      //   // if it's a journal document, the date should be displayed.
      //   const journalDateString = get(this.journalService.journalDate$(docId));
      //   if (journalDateString) {
      //     return i18nTime(journalDateString, { absolute: { accuracy: 'day' } });
      //   }
      // }

      // title alias
      if (titleAlias) return titleAlias;

      if (journalTitle) return journalTitle;

      // doc not found
      if (!doc) {
        return this.i18nService.i18n.i18next.t(
          "com.myoxus.notFoundPage.title",
          { lng },
        );
      }

      // original title
      if (originalTitle) return originalTitle;

      // empty title
      return this.i18nService.i18n.i18next.t("Untitled", { lng });
    });
  }

  getDocDisplayMeta(docRecord: DocRecord) {
    return {
      title: this.title$(docRecord.id).value,
      icon: this.icon$(docRecord.id).value,
      updatedDate: docRecord.meta$.value.updatedDate,
    };
  }
}
