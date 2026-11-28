// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { NetworkIcon } from "@myoxus/icons/react";
import track from "@myoxus/track";
import { ViewSwitcher, type ViewSwitcherItem } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

import {
  type DocListItemView,
  DocListViewIcon,
} from "../docs-view/doc-list-item";

export type AllContentView = DocListItemView | "graph";

export const ViewToggle = ({
  view,
  onViewChange,
  includeGraph = false,
}: {
  view: AllContentView;
  onViewChange: (view: AllContentView) => void;
  includeGraph?: boolean;
}) => {
  const t = useI18n();

  const items = useMemo<ViewSwitcherItem<AllContentView>[]>(() => {
    const base: ViewSwitcherItem<AllContentView>[] = [
      {
        icon: <DocListViewIcon view="masonry" />,
        label: t["com.myoxus.all-docs.view.masonry"](),
        value: "masonry",
      },
      {
        icon: <DocListViewIcon view="grid" />,
        label: t["com.myoxus.all-docs.view.grid"](),
        value: "grid",
      },
      {
        icon: <DocListViewIcon view="list" />,
        label: t["com.myoxus.all-docs.view.list"](),
        value: "list",
      },
    ];
    if (includeGraph) {
      base.push({
        icon: <NetworkIcon />,
        label: t["com.myoxus.documentGraph.title"](),
        value: "graph",
      });
    }
    return base;
  }, [includeGraph, t]);

  const handleChange = useCallback(
    (nextView: AllContentView) => {
      if (nextView !== "graph") {
        track.allDocs.header.viewMode.editDisplayMenu({ type: nextView });
      }
      onViewChange(nextView);
    },
    [onViewChange],
  );

  return (
    <ViewSwitcher
      items={items}
      value={view}
      onChange={handleChange}
      data-myoxus-ui-role="all-docs-header-view-toggle"
    />
  );
};
