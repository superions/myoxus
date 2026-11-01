import type { ViewMeta } from "@virgultum/data-view";
import { viewPresets } from "@virgultum/data-view/view-presets";

export const blockQueryViews: ViewMeta[] = [
  viewPresets.tableViewMeta,
  viewPresets.kanbanViewMeta,
];

export const blockQueryViewMap = Object.fromEntries(
  blockQueryViews.map((view) => [view.type, view]),
);
