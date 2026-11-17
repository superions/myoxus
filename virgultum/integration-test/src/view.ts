import {
  ViewExtensionManager,
  ViewExtensionProvider,
  type ViewExtensionContext,
} from "@virgultum/editor/ext-loader";
import { getInternalViewExtensions } from "@virgultum/editor/extensions/view";
import type { ExtensionType } from "@virgultum/editor/store";

/** Match production's host registration in every nested preview scope. */
export class TestChromeViewExtension extends ViewExtensionProvider<{
  extension: ExtensionType;
}> {
  override name = "TestChrome";
  override setup(
    context: ViewExtensionContext,
    options?: { extension: ExtensionType },
  ) {
    super.setup(context, options);
    if (options) context.register(options.extension);
  }
}

export function getTestViewManager() {
  return new ViewExtensionManager([
    ...getInternalViewExtensions(),
    TestChromeViewExtension,
  ]);
}
