import { createIdentifier } from "../primitives/di/index";
import type { ExtensionType } from "../store/index";

export interface SidebarService {
  open: (tabId?: string) => void;
  close: () => void;
  getTabIds: () => string[];
}

export const SidebarExtensionIdentifier = createIdentifier<SidebarService>(
  "MyoxusSidebarExtension",
);

export const SidebarExtension = (service: SidebarService): ExtensionType => ({
  setup: (di) => {
    di.addImpl(SidebarExtensionIdentifier, () => service);
  },
});
