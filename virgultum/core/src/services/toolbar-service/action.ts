import type { MyoxusIconExportName } from "@myoxus/icons/names";

import type { ToolbarContext } from "./context";
import type { EditorI18nMessage } from "../i18n-service";

export enum ActionPlacement {
  Start = 0,
  Normal = 1 << 0,
  End = 1 << 1,
  More = 1 << 2,
}

export type ToolbarText = string | EditorI18nMessage;

type ActionBase = {
  id: string;
  score?: number;
  when?: ((cx: ToolbarContext) => boolean) | boolean;
  active?: ((cx: ToolbarContext) => boolean) | boolean;
  placement?: ActionPlacement;
};

/** Presentation values only; callbacks retain editor command ownership. */
export type ToolbarControl =
  | {
      type: "notice";
      title: ToolbarText;
      message: ToolbarText;
      tone: "warning";
    }
  // Existing native family views pass through the original React portal; never Lit panels.
  | { type: "native"; node: unknown }
  | {
      type: "menu";
      items: ToolbarActions;
      onOpen?: () => void;
      onClose?: () => void;
    }
  | {
      type: "choice";
      presentation?: "icons";
      value: string | null;
      options: readonly {
        value: string;
        label: ToolbarText;
        icon?: MyoxusIconExportName;
        disabled?: boolean;
      }[];
      change: (value: string) => void;
      onOpen?: () => void;
    }
  | {
      type: "color";
      value: string;
      swatches?: readonly string[];
      custom?: boolean;
      /** One preview gesture becomes one history entry, including interrupted sessions. */
      start?: () => () => void;
      change: (value: string) => void;
    }
  | {
      type: "number";
      value: number | string;
      min?: number;
      max?: number;
      step?: number;
      suffix?: string;
      presets?: readonly number[];
      onOpen?: () => void;
      change: (value: number | string) => void;
    }
  | { type: "toggle"; checked: boolean; change: (value: boolean) => void }
  | {
      type: "text";
      value: string;
      placeholder?: ToolbarText;
      change: (value: string) => void;
      submit?: () => ToolbarText | null | void;
    };

export type ToolbarAction = ActionBase & {
  label?: ToolbarText;
  showLabel?: boolean;
  shortcut?: string;
  icon?: MyoxusIconExportName;
  control?: ToolbarControl | ((cx: ToolbarContext) => ToolbarControl | null);
  /** Theme-owned color preview for a palette command; the command owns its stored value. */
  swatch?: string;
  tooltip?: ToolbarText;
  variant?: "destructive";
  disabled?: ((cx: ToolbarContext) => boolean) | boolean;
  run?: (cx: ToolbarContext, anchor?: HTMLElement, event?: MouseEvent) => void;
};

// Generates an action at runtime
export type ToolbarActionGenerator = ActionBase & {
  generate: (cx: ToolbarContext) => Omit<ToolbarAction, "id"> | null;
};

export type ToolbarActionGroup<
  T extends ActionBase = ToolbarAction | ToolbarActionGenerator,
> = ActionBase &
  Pick<
    ToolbarAction,
    "control" | "icon" | "label" | "tooltip" | "showLabel"
  > & {
    actions: T[];
  };

// Generates an action group at runtime
export type ToolbarActionGroupGenerator = ActionBase & {
  generate: (cx: ToolbarContext) => Omit<ToolbarActionGroup, "id"> | null;
};

export type ToolbarGenericAction =
  | ToolbarAction
  | ToolbarActionGenerator
  | ToolbarActionGroup
  | ToolbarActionGroupGenerator;

export type ToolbarActions<T extends ActionBase = ToolbarGenericAction> = T[];
