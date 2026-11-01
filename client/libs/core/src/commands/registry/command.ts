import type { ReactNode } from "react";

// TODO(@Peng): need better way for composing different precondition strategies
export enum PreconditionStrategy {
  Always,
  InPaperOrEdgeless,
  InPaper,
  InEdgeless,
  InEdgelessPresentationMode,
  NoSearchResult,
  Never,
}

export type CommandCategory =
  | "editor:insert-object"
  | "editor:page"
  | "editor:edgeless"
  | "myoxus:recent"
  | "myoxus:pages"
  | "myoxus:edgeless"
  | "myoxus:collections"
  | "myoxus:navigation"
  | "myoxus:creation"
  | "myoxus:settings"
  | "myoxus:layout"
  | "myoxus:updates"
  | "myoxus:help"
  | "myoxus:general"
  | "myoxus:results";

export interface KeybindingOptions {
  binding: string;
  capture?: boolean;
  // some keybindings are already registered in virgultum
  // we can skip the registration of these keybindings __FOR NOW__
  skipRegister?: boolean;
}

export interface MyoxusCommandOptions {
  id: string;
  // a set of predefined precondition strategies, but also allow user to customize their own
  // note: this only controls the visibility of the command, not the availability (e.g., shortcut keybinding still works)
  preconditionStrategy?: PreconditionStrategy | (() => boolean);
  // main text on the left..
  // make text a function so that we can do i18n and interpolation when we need to
  label:
    | string
    | (() => string)
    | {
        title: string;
        subTitle?: string;
      }
    | (() => {
        title: string;
        subTitle?: string;
      });
  icon: ReactNode; // TODO(@JimmFly): need a mapping from string -> React element/SVG
  category?: CommandCategory;
  // `$mod` resolves to the platform's primary modifier through the UI Facade.
  keyBinding?: KeybindingOptions | string;
  run: () => void | Promise<void>;
}

export interface MyoxusCommand {
  readonly id: string;
  readonly preconditionStrategy: PreconditionStrategy | (() => boolean);
  readonly label: {
    title: string;
    subTitle?: string;
  };
  readonly icon?: ReactNode; // icon name
  readonly category: CommandCategory;
  readonly keyBinding?: KeybindingOptions;
  run(): void | Promise<void>;
}

export function createMyoxusCommand(
  options: MyoxusCommandOptions,
): MyoxusCommand {
  return {
    id: options.id,
    run: options.run,
    icon: options.icon,
    preconditionStrategy:
      options.preconditionStrategy ?? PreconditionStrategy.Always,
    category: options.category ?? "myoxus:general",
    get label() {
      let label = options.label;
      label = typeof label === "function" ? label?.() : label;
      label =
        typeof label === "string"
          ? {
              title: label,
            }
          : label;
      return label;
    },
    keyBinding:
      typeof options.keyBinding === "string"
        ? { binding: options.keyBinding }
        : options.keyBinding,
  };
}
