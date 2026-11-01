// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Journal activity sidecard body. */
import { Stack } from "@myoxus/ui-facade";

import { JournalActivityList } from "./activity-list";
import { useJournalToolState } from "./tool-state";

export function JournalActivityToolBody() {
  const { selectedDate } = useJournalToolState();

  return (
    <Stack
      data-myoxus-ui-role="journal-activity-tool"
      data-testid="journal-activity-tool"
    >
      <JournalActivityList date={selectedDate} />
    </Stack>
  );
}
