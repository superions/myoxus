// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { PlusIcon } from "@myoxus/icons/react";
import {
  IconButton,
  WorkbenchHeaderFrame,
  WorkbenchHeaderTitle,
} from "@myoxus/ui-facade";

export function AllCollectionHeader({
  onCreateCollection,
}: {
  onCreateCollection?: () => void;
}) {
  const t = useI18n();
  const createLabel = t["com.myoxus.collections.empty.new-collection-button"]();

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="all-collections-header-frame"
      title={<WorkbenchHeaderTitle>{t["Collections"]()}</WorkbenchHeaderTitle>}
      right={
        onCreateCollection ? (
          <IconButton
            icon={<PlusIcon />}
            aria-label={createLabel}
            tooltip={createLabel}
            onClick={onCreateCollection}
            data-testid="create-collection-header-button"
          />
        ) : null
      }
    />
  );
}
