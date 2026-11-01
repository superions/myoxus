import { type Signal, signal } from "@preact/signals-core";
import { createIdentifier } from "@virgultum/global/di";

export const ShowQuickSettingBarKey = createIdentifier<
  Signal<Record<string, boolean>>
>("show-quick-setting-bar");

export const createDefaultShowQuickSettingBar = () => {
  return signal<Record<string, boolean>>({});
};
