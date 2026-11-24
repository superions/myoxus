import { EditorSettingSchema } from "@myoxus/core/modules/editor-setting";
import {
  editorMessage,
  type OpenDocConfigItem,
  OpenDocExtension,
} from "@virgultum/editor/shared/services";

type OpenDocAction = OpenDocConfigItem & {
  enabled: boolean;
  shortcut?: string;
};

export const openDocActions: Array<OpenDocAction> = (
  [
    {
      type: "open-in-active-view",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc",
        "Open this doc",
      ),
      iconName: "ExpandFullIcon",
      enabled: true,
    },
    {
      type: "open-in-new-view",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc-in-split-view",
        "Open in split view",
      ),
      iconName: "SplitViewIcon",
      shortcut: "⌘ + ⌥ + click",
      enabled: BUILD_CONFIG.isElectron,
    },
    {
      type: "open-in-new-tab",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc-in-new-tab",
        "Open in new tab",
      ),
      iconName: "OpenInNewIcon",
      shortcut: "⌘ + click",
      enabled: true,
    },
    {
      type: "open-in-center-peek",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc-in-center-peek",
        "Open in center peek",
      ),
      iconName: "CenterPeekIcon",
      shortcut: "⇧ + click",
      enabled: true,
    },
  ] satisfies OpenDocAction[]
).filter(
  (a) =>
    a.enabled &&
    EditorSettingSchema.shape.openDocMode.safeParse(a.type).success,
);

export function patchOpenDocExtension() {
  return OpenDocExtension({ items: openDocActions });
}
