import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/core/extensions";

import { TemplateTool } from "./template-tool";
import { templateSeniorTool } from "./toolbar/senior-tool";

export class TemplateViewExtension extends ViewExtensionProvider {
  override name = "myoxus-template-view";

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    if (this.isEdgeless(context.scope)) {
      context.register(TemplateTool);
      context.register(templateSeniorTool);
    }
  }
}
