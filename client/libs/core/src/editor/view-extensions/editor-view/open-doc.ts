import { EditorSettingSchema } from "@myoxus/core/modules/editor-setting";
import {
  CenterPeekIcon,
  ExpandFullIcon,
  OpenInNewIcon,
  SplitViewIcon,
} from "@myoxus/icons/lit";
import {
  editorMessage,
  type OpenDocConfig,
  type OpenDocConfigItem,
  OpenDocExtension,
} from "@virgultum/editor/shared/services";

type OpenDocAction = OpenDocConfigItem & {
  iconName: import("@myoxus/icons/names").MyoxusIconExportName;
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
      icon: ExpandFullIcon(),
      iconName: "ExpandFullIcon",
      enabled: true,
    },
    {
      type: "open-in-new-view",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc-in-split-view",
        "Open in split view",
      ),
      icon: SplitViewIcon(),
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
      icon: OpenInNewIcon(),
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
      icon: CenterPeekIcon(),
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
  const openDocConfig: OpenDocConfig = {
    items: openDocActions.map<OpenDocConfigItem>(({ type, label, icon }) => ({
      type,
      label,
      icon,
    })),
  };
  return OpenDocExtension(openDocConfig);
}
