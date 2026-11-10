import { JournalService } from "@myoxus/core/modules/journal";
import { i18nTime } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { Group, JournalDocumentDayTag } from "@myoxus/ui-facade";
import type { Store } from "@virgultum/editor/store";
import dayjs from "dayjs";

export const VirgultumEditorJournalDocTitle = ({ page }: { page: Store }) => {
  const journalService = useService(JournalService);
  const journalDateStr = useLiveData(journalService.journalDate$(page.id));

  return <VirgultumEditorJournalDocTitleUI date={journalDateStr} />;
};

export const VirgultumEditorJournalDocTitleUI = ({
  date: dateStr,
  overrideClassName,
}: {
  date?: string;
  /**
   * The `doc-title-container` class style is defined in editor,
   * which means if we use this component outside editor, the style will not work,
   * so we provide a className to override
   */
  overrideClassName?: string;
}) => {
  const localizedJournalDate = i18nTime(dateStr, {
    absolute: { accuracy: "day" },
  });
  // TODO(catsjuice): i18n
  const today = dayjs();
  const date = dayjs(dateStr);
  const day = dayjs(date).format("dddd") ?? null;
  const isToday = date.isSame(today, "day");

  return (
    <Group
      className={overrideClassName ?? "doc-title-container"}
      data-testid="journal-title"
      gap="xs"
      wrap="nowrap"
    >
      <span data-testid="date">{localizedJournalDate}</span>
      {!isToday ? <JournalDocumentDayTag>{day}</JournalDocumentDayTag> : null}
    </Group>
  );
};
