// Import the identifier for internal use
import { Service } from "@myoxus/infra";
import { uniReactRoot } from "@myoxus/lit-react/uni-component";
import { IconPicker } from "@myoxus/ui-facade";
import { type IconPickerService as IIconPickerService } from "@virgultum/core/services";

// Re-export types from Virgultum shared services
export type {
  IconData,
  IconPickerService as IIconPickerService,
} from "@virgultum/core/services";
export { IconPickerServiceIdentifier } from "@virgultum/core/services";

export class IconPickerService extends Service implements IIconPickerService {
  public readonly iconPickerComponent =
    uniReactRoot.createUniComponent(IconPicker);
}
