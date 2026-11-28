// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import {
  registerSlashMenuWidget,
  SlashMenuExtension,
} from "./slash-controller";

export class SlashMenuViewExtension extends ViewExtensionProvider {
  override name = "myoxus-slash-menu-widget";

  override effect(): void {
    super.effect();
    registerSlashMenuWidget();
  }

  override setup(context: ViewExtensionContext): void {
    super.setup(context);
    if (this.isMobile(context.scope)) return;
    context.register(SlashMenuExtension);
  }
}
