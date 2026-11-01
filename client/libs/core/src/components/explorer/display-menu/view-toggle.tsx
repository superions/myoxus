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
  const views = useMemo(
    () =>
      [
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
        ...(includeGraph
          ? [
              {
                icon: <NetworkIcon />,
                label: t["com.myoxus.documentGraph.title"](),
                value: "graph" as const,
              },
            ]
          : []),
      ] satisfies ViewSwitcherItem<AllContentView>[],
    [includeGraph, t],
  );

  const handleViewChange = useCallback(
    (view: AllContentView) => {
      if (view !== "graph") {
        track.allDocs.header.viewMode.editDisplayMenu({
          type: view,
        });
      }
      onViewChange(view);
    },
    [onViewChange],
  );

  return (
    <ViewSwitcher
      items={views}
      value={view}
      onChange={handleViewChange}
      data-myoxus-ui-role="all-docs-header-view-toggle"
    />
  );
};
