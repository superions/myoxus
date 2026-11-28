// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { dragHandleWidget, registerDragHandleWidget } from "./controller";

export class DragHandleViewExtension extends ViewExtensionProvider {
  override name = "myoxus-drag-handle-widget";

  override effect(): void {
    super.effect();
    registerDragHandleWidget();
  }

  override setup(context: ViewExtensionContext): void {
    super.setup(context);
    context.register(dragHandleWidget);
  }
}
