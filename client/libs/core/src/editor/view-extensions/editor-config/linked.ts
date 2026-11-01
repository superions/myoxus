import { AtMenuConfigService } from "@myoxus/core/modules/at-menu-config/services";
import { type FrameworkProvider } from "@myoxus/infra";
import type { LinkedWidgetConfig } from "@virgultum/editor/widgets/linked-doc";

export function createLinkedWidgetConfig(
  framework: FrameworkProvider,
): Partial<LinkedWidgetConfig> | undefined {
  const service = framework.getOptional(AtMenuConfigService);
  return {
    ...service?.getConfig(),
    convertTriggerKey: false,
  };
}
