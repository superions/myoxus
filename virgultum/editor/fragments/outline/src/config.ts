export const headingKeys = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const outlineSettingsKey = "outlinePanelSettings";

export const defaultOutlinePanelLabels = {
  title: "Table of Contents",
  emptyPlaceholder: "Use headings to create a table of contents.",
  previewSettings: "Preview settings",
  visibilityAndSort: "Visibility and sort",
  hiddenContents: "Hidden contents",
  hiddenNoticeTitle: "Some contents hidden",
  hiddenNoticeBody: "Some contents are not visible on edgeless.",
  hiddenNoticeActionPrefix: "Click here or",
  hiddenNoticeActionSuffix: "to organize content.",
  modeBoth: "Both",
  modeEdgeless: "Edgeless",
  modePage: "Page",
  next: "Next",
  previous: "Previous",
};

export type OutlinePanelLabels = typeof defaultOutlinePanelLabels;
