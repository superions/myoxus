import { editorMessage, type EditorI18nMessage } from "./i18n-service";
import { CenterPeekIcon, ExpandFullIcon } from "@myoxus/icons/lit";
import { createIdentifier } from "@virgultum/global/di";
import { type ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";

export type OpenDocMode =
  | "open-in-active-view"
  | "open-in-new-view"
  | "open-in-new-tab"
  | "open-in-center-peek";

// todo: later this will be used to generate the menu items.
// for now we only use it as a hint for whether or not to show the open doc buttons.
export interface OpenDocConfigItem {
  type: OpenDocMode;
  label: string | EditorI18nMessage;
  icon: TemplateResult<1>;
}
export interface OpenDocConfig {
  items: OpenDocConfigItem[];
}

export interface OpenDocService {
  isAllowed: (mode: OpenDocMode) => boolean;
  items: OpenDocConfig["items"];
}

export const OpenDocExtensionIdentifier = createIdentifier<OpenDocService>(
  "MyoxusOpenDocExtension",
);

const defaultConfig: OpenDocConfig = {
  items: [
    {
      type: "open-in-active-view",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc",
        "Open this doc",
      ),
      icon: ExpandFullIcon(),
    },
    {
      type: "open-in-center-peek",
      label: editorMessage(
        "com.myoxus.peek-view-controls.open-doc-in-center-peek",
        "Open in center peek",
      ),
      icon: CenterPeekIcon(),
    },
  ],
};

export const OpenDocExtension = (config: OpenDocConfig): ExtensionType => ({
  setup: (di) => {
    di.override(OpenDocExtensionIdentifier, () => {
      const allowedOpenDocModes = new Set(
        config.items.map((item) => item.type),
      );
      return {
        isAllowed: (mode: OpenDocMode) => allowedOpenDocModes.has(mode),
        items: config.items,
      };
    });
  },
});

export const DefaultOpenDocExtension = OpenDocExtension(defaultConfig);
