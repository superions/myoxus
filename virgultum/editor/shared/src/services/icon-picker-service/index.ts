import { createIdentifier } from "@virgultum/global/di";
import type { UniComponent } from "@virgultum/shared/types";
export const IconType = {
  Emoji: "emoji",
  MyoxusIcon: "myoxus-icon",
  Blob: "blob",
} as const;

export type IconType = (typeof IconType)[keyof typeof IconType];

export type IconData =
  | {
      type: typeof IconType.Emoji;
      unicode: string;
    }
  | {
      type: typeof IconType.MyoxusIcon;
      name: string;
      color: string;
    }
  | {
      type: typeof IconType.Blob;
      blob: Blob;
    };

export interface IconPickerService {
  iconPickerComponent: UniComponent<{ onSelect?: (data?: IconData) => void }>;
}

export const IconPickerServiceIdentifier =
  createIdentifier<IconPickerService>("IconPickerService");
