import type { FlagInfo } from "./types";

const isInternalBuild = BUILD_CONFIG.appBuildType === "internal";
const isMobile = BUILD_CONFIG.isMobileEdition;
const isIOS = BUILD_CONFIG.isIOS;

export const MYOXUS_FLAGS = {
  enable_ai: {
    category: "affine",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-ai.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-ai.description",
    hide: true,
    configurable: true,
    defaultState: true,
  },
  enable_ai_playground: {
    category: "affine",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-ai-model-switch.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-ai-model-switch.description",
    configurable: isInternalBuild,
    defaultState: isInternalBuild,
  },
  enable_ai_chat_block: {
    category: "virgultum",
    bsFlag: "enable_ai_chat_block",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-ai-chat-block.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-ai-chat-block.description",
    configurable: false,
    defaultState: true,
  },
  enable_mermaid_block: {
    category: "virgultum",
    bsFlag: "enable_mermaid_block",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-mermaid-block.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-mermaid-block.description",
    hide: true,
    configurable: false,
    defaultState: true,
  },
  enable_block_meta: {
    category: "virgultum",
    bsFlag: "enable_block_meta",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-block-meta.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-block-meta.description",
    configurable: isInternalBuild,
    defaultState: true,
  },

  enable_advanced_block_visibility: {
    category: "virgultum",
    bsFlag: "enable_advanced_block_visibility",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-advanced-block-visibility.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-advanced-block-visibility.description",
    configurable: true,
    defaultState: false,
  },
  enable_mobile_keyboard_toolbar: {
    category: "virgultum",
    bsFlag: "enable_mobile_keyboard_toolbar",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-mobile-keyboard-toolbar.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-mobile-keyboard-toolbar.description",
    configurable: false,
    defaultState: isMobile,
  },
  enable_mobile_linked_doc_menu: {
    category: "virgultum",
    bsFlag: "enable_mobile_linked_doc_menu",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-mobile-linked-doc-menu.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-mobile-linked-doc-menu.description",
    configurable: false,
    defaultState: isMobile,
  },
  enable_mobile_edgeless_editing: {
    category: "affine",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-mobile-edgeless-editing.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-mobile-edgeless-editing.description",
    configurable: isMobile,
    defaultState: false,
  },
  enable_editor_rtl: {
    category: "affine",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-editor-rtl.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-editor-rtl.description",
    configurable: isInternalBuild,
    defaultState: false,
  },
  enable_mobile_ai_button: {
    category: "affine",
    displayName: "Enable AI Button",
    description: "Enable AI Button on mobile",
    configurable: isMobile && isIOS,
    defaultState: isMobile && isIOS,
  },
  enable_turbo_renderer: {
    category: "virgultum",
    bsFlag: "enable_turbo_renderer",
    displayName: "Enable Turbo Renderer",
    description: "Enable experimental edgeless turbo renderer",
    configurable: isInternalBuild,
    defaultState: false,
  },
  enable_dom_renderer: {
    category: "virgultum",
    bsFlag: "enable_dom_renderer",
    displayName: "Enable DOM Renderer",
    description: "Enable DOM renderer for graphics elements",
    configurable: true,
    defaultState: false,
  },
  enable_edgeless_scribbled_style: {
    category: "virgultum",
    bsFlag: "enable_edgeless_scribbled_style",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-edgeless-scribbled-style.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-edgeless-scribbled-style.description",
    configurable: isInternalBuild,
    defaultState: false,
  },
  enable_table_virtual_scroll: {
    category: "virgultum",
    bsFlag: "enable_table_virtual_scroll",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-table-virtual-scroll.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-table-virtual-scroll.description",
    configurable: isInternalBuild,
    defaultState: false,
  },
  enable_setting_subpage_animation: {
    category: "affine",
    displayName: "Enable Setting Subpage Animation",
    description: "Apply animation for setting subpage open/close",
    configurable: isInternalBuild,
    defaultState: false,
  },
  enable_send_detailed_object_to_ai: {
    category: "affine",
    displayName:
      "com.myoxus.settings.workspace.experimental-features.enable-ai-send-detailed-object.name",
    description:
      "com.myoxus.settings.workspace.experimental-features.enable-ai-send-detailed-object.description",
    configurable: true,
    defaultState: true,
  },
  enable_battery_save_mode: {
    category: "affine",
    displayName: "Enable Battery Save Mode (Require Restart)",
    description:
      "Limit indexing and other compute-intensive tasks on this device, may experience longer loading time and latency in search and other features, in exchange for quietness.",
    configurable: true,
    defaultState: isMobile,
  },
} satisfies { [key in string]: FlagInfo };

// oxlint-disable-next-line no-redeclare
export type MYOXUS_FLAGS = typeof MYOXUS_FLAGS;
