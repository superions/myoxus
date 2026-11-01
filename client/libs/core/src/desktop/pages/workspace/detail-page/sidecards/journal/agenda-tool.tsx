// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Journal agenda sidecard body. */
import { useI18n } from "@myoxus/i18n";
import { SettingsNotice, Stack } from "@myoxus/ui-facade";

import { EventSections } from "./event-sections";
import { useJournalToolState } from "./tool-state";

export function JournalAgendaToolBody() {
  const t = useI18n();
  const { readonly, selectedDate, view } = useJournalToolState();

  return (
    <Stack
      data-myoxus-ui-role="journal-agenda-tool"
      data-testid="journal-agenda-tool"
    >
      {readonly ? (
        <SettingsNotice tone="info">
          {t["com.myoxus.no-permission"]()}
        </SettingsNotice>
      ) : null}
      <EventSections
        selectedDate={selectedDate}
        view={view}
        readonly={readonly}
      />
    </Stack>
  );
}
