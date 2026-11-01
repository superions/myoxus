import { i18nTime } from "@myoxus/i18n";
import {
  BlockLinkIcon as LitBlockLinkIcon,
  EdgelessIcon as LitEdgelessIcon,
  LinkIcon as LitLinkIcon,
  PageIcon as LitPageIcon,
  TodayIcon as LitTodayIcon,
  TomorrowIcon as LitTomorrowIcon,
  YesterdayIcon as LitYesterdayIcon,
} from "@myoxus/icons/lit";
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
import { getDocIconComponent, getDocIconComponentLit } from "./icon";

type IconType = "rc" | "lit";
interface DocDisplayIconOptions<T extends IconType> {
  type?: T;
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
const litIcons = {
  BlockLinkIcon: LitBlockLinkIcon,
  EdgelessIcon: LitEdgelessIcon,
  LinkIcon: LitLinkIcon,
  PageIcon: LitPageIcon,
  TodayIcon: LitTodayIcon,
  TomorrowIcon: LitTomorrowIcon,
  YesterdayIcon: LitYesterdayIcon,
};
const icons = { rc: rcIcons, lit: litIcons } as {
  rc: Record<keyof typeof rcIcons, any>;
  lit: Record<keyof typeof litIcons, any>;
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

  getJournalIcon(
    journalDate: string | Dayjs,
    options?: DocDisplayIconOptions<"rc">,
  ): typeof TodayIcon;

  getJournalIcon(
    journalDate: string | Dayjs,
    options?: DocDisplayIconOptions<"lit">,
  ): typeof LitYesterdayIcon;

  getJournalIcon<T extends IconType = "rc">(
    journalDate: string | Dayjs,
    options?: DocDisplayIconOptions<T>,
  ): T extends "rc" ? typeof TodayIcon : typeof LitTodayIcon;

  getJournalIcon<T extends IconType = "rc">(
    journalDate: string | Dayjs,
    options?: DocDisplayIconOptions<T>,
  ) {
    const iconSet = icons[options?.type ?? "rc"];
    const day = dayjs(journalDate);
    return day.isBefore(dayjs(), "day")
      ? iconSet.YesterdayIcon
      : day.isAfter(dayjs(), "day")
        ? iconSet.TomorrowIcon
        : iconSet.TodayIcon;
  }

  icon$<T extends IconType = "rc">(
    docId: string,
    options?: DocDisplayIconOptions<T>,
  ) {
    const iconSet = icons[options?.type ?? "rc"];

    return LiveData.computed((get) => {
      // Link identity must not depend on its label, target mode or custom icon.
      if (options?.reference) {
        return options.referenceToNode
          ? iconSet.BlockLinkIcon
          : iconSet.LinkIcon;
      }

      const enableEmojiIcon = options?.enableEmojiIcon !== false;
      const doc = get(this.docsService.list.doc$(docId));
      // link to journal doc
      const journalDateString = get(this.journalService.journalDate$(docId));
      const journalIcon = journalDateString
        ? this.getJournalIcon(journalDateString, options)
        : undefined;
      const mode = doc ? get(doc.primaryMode$) : undefined;
      const finalMode = options?.mode ?? mode ?? "page";

      // emoji title
      if (enableEmojiIcon) {
        const icon = get(this.explorerIconService.icon$("doc", docId))?.icon;
        if (icon) {
          return options?.type === "lit"
            ? getDocIconComponentLit(icon)
            : getDocIconComponent(icon);
        }
      }

      if (journalIcon) return journalIcon;

      // default icon
      return finalMode === "edgeless" ? iconSet.EdgelessIcon : iconSet.PageIcon;
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
