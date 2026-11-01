import type { FrameworkProvider } from "@myoxus/infra";
import { IconPickerServiceIdentifier } from "@virgultum/editor/shared/services";
import { type ExtensionType } from "@virgultum/editor/store";
import type { Container } from "@virgultum/global/di";

import { IconPickerService } from "../../../modules/icon-picker/services/icon-picker";

/**
 * Patch the icon picker service to make it available in Virgultum
 * @param framework
 * @returns
 */
export function patchIconPickerService(
  framework: FrameworkProvider,
): ExtensionType {
  return {
    setup: (di: Container) => {
      di.override(IconPickerServiceIdentifier, () => {
        return framework.get(IconPickerService);
      });
    },
  };
}
