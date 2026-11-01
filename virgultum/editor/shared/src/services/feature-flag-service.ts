import { type Signal, signal } from "@preact/signals-core";
import { type Store, StoreExtension } from "@virgultum/store";

export interface VirgultumFlags {
  enable_block_query: boolean;
  enable_ai_chat_block: boolean;
  enable_mermaid_block: boolean;
  enable_advanced_block_visibility: boolean;
  enable_shape_shadow_blur: boolean;
  enable_mobile_keyboard_toolbar: boolean;
  enable_mobile_linked_doc_menu: boolean;
  enable_block_meta: boolean;
  enable_edgeless_scribbled_style: boolean;
  enable_table_virtual_scroll: boolean;
  enable_turbo_renderer: boolean;
  enable_dom_renderer: boolean;
}

export class FeatureFlagService extends StoreExtension {
  static override key = "feature-flag-server";

  private readonly _flags: Signal<VirgultumFlags> = signal({
    enable_block_query: false,
    enable_ai_chat_block: true,
    enable_mermaid_block: false,
    enable_advanced_block_visibility: false,
    enable_shape_shadow_blur: false,
    enable_mobile_keyboard_toolbar: false,
    enable_mobile_linked_doc_menu: false,
    enable_block_meta: true,
    enable_edgeless_scribbled_style: false,
    enable_table_virtual_scroll: false,
    enable_turbo_renderer: false,
    enable_dom_renderer: false,
  });

  setFlag(key: keyof VirgultumFlags, value: boolean) {
    this._flags.value = {
      ...this._flags.value,
      [key]: value,
    };
  }

  getFlag(key: keyof VirgultumFlags) {
    return this._flags.value[key];
  }

  constructor(store: Store) {
    super(store);
  }
}
