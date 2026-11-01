// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  AllDocsIcon,
  DatabaseIcon,
  FavoriteIcon,
  ProgressIcon,
} from "@myoxus/icons/react";
import { ViewSwitcher, type ViewSwitcherItem } from "@myoxus/ui-facade";
import { useMemo } from "react";

export type DatabaseInventoryScope =
  "all" | "database" | "project" | "favorites";

export function DatabaseInventoryScopeSwitcher({
  onChange,
  value,
}: {
  onChange: (scope: DatabaseInventoryScope) => void;
  value: DatabaseInventoryScope;
}) {
  const t = useI18n();
  const items = useMemo(
    () =>
      [
        {
          icon: <AllDocsIcon />,
          label: t["com.myoxus.database.index.scope.all"](),
          testId: "database-inventory-scope-all",
          value: "all",
        },
        {
          icon: <DatabaseIcon />,
          label: t["com.myoxus.database.template.category.database"](),
          testId: "database-inventory-scope-database",
          value: "database",
        },
        {
          icon: <ProgressIcon />,
          label: t["com.myoxus.database.template.category.project"](),
          testId: "database-inventory-scope-project",
          value: "project",
        },
        {
          icon: <FavoriteIcon />,
          label: t.Favorites(),
          testId: "database-inventory-scope-favorites",
          value: "favorites",
        },
      ] satisfies ViewSwitcherItem<DatabaseInventoryScope>[],
    [t],
  );

  return (
    <ViewSwitcher
      aria-label={t["com.myoxus.database.index.title"]()}
      data-myoxus-ui-role="database-inventory-header-scope"
      data-testid="database-inventory-scope"
      items={items}
      onChange={onChange}
      value={value}
    />
  );
}
