// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { effects } from "./effects.js";
import { EventBlockSpec } from "./event-spec.js";

export class EventViewExtension extends ViewExtensionProvider {
  override name = "myoxus-event-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(EventBlockSpec);
  }
}
