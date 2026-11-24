import type { ExtensionType } from "../../store/index";

import { WidgetViewIdentifier } from "../identifier.js";

/**
 * Create a widget view extension.
 *
 * @param flavour The flavour of the block that the widget view is for.
 * @param id The id of the widget view.
 * @param view The registered custom-element name.
 *
 * A widget view is to provide a widget view for a block.
 * For every target block, it's view will be rendered with the widget view.
 *
 * @example
 * ```ts
 * import { WidgetViewExtension } from '../index';
 *
 * const MyWidgetViewExtension = WidgetViewExtension('my-flavour', 'my-widget', "my-widget-view");
 */
export function WidgetViewExtension(
  flavour: string,
  id: string,
  view: string,
): ExtensionType {
  return {
    setup: (di) => {
      if (flavour.includes("|") || id.includes("|")) {
        console.error(`Register view failed:`);
        console.error(
          `flavour or id cannot include '|', flavour: ${flavour}, id: ${id}`,
        );
        return;
      }
      const key = `${flavour}|${id}`;
      di.addImpl(WidgetViewIdentifier(key), view);
    },
  };
}
