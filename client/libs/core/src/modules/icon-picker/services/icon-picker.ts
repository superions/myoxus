// Import the identifier for internal use
import { Service } from "@myoxus/infra";
import { uniReactRoot } from "@myoxus/lit-react";
import { IconPicker } from "@myoxus/ui-facade";
import { type IconPickerService as IIconPickerService } from "@virgultum/shared/services";

// Re-export types from Virgultum shared services
export type {
  IconData,
  IconPickerService as IIconPickerService,
} from "@virgultum/shared/services";
export { IconPickerServiceIdentifier } from "@virgultum/shared/services";

export class IconPickerService extends Service implements IIconPickerService {
  public readonly iconPickerComponent =
    uniReactRoot.createUniComponent(IconPicker);
}
