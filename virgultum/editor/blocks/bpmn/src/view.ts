import {
  type ViewExtensionContext,
  ViewExtensionProvider,
} from "@virgultum/ext-loader";

import { BpmnBlockSpec } from "./bpmn-spec.js";
import { effects } from "./effects.js";
import { bpmnQuickTool } from "./edgeless-toolbar.js";

export class BpmnViewExtension extends ViewExtensionProvider {
  override name = "myoxus-bpmn-block";

  override effect() {
    super.effect();
    effects();
  }

  override setup(context: ViewExtensionContext) {
    super.setup(context);
    context.register(BpmnBlockSpec);
    if (this.isEdgeless(context.scope)) context.register(bpmnQuickTool);
  }
}
