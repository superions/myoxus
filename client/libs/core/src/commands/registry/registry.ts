import { DebugLogger } from "@myoxus/debug";
import { LiveData } from "@myoxus/infra";
import { createMyoxusHotkeyHandler } from "@myoxus/ui-facade";

import {
  createMyoxusCommand,
  type MyoxusCommand,
  type MyoxusCommandOptions,
} from "./command";

const commandLogger = new DebugLogger("command:registry");

interface KeyBindingOptions {
  /**
   * Key presses will listen to this event (default: "keydown").
   */
  event?: "keydown" | "keyup";

  /**
   * Whether to capture the event during the capture phase (default: false).
   */
  capture?: boolean;
}

const bindKeys = (
  target: Window | HTMLElement,
  keybinding: string,
  handler: (event: KeyboardEvent) => void,
  options: KeyBindingOptions = {},
) => {
  const event = options.event ?? "keydown";
  const onKeyEvent = createMyoxusHotkeyHandler([[keybinding, handler]]);
  const listener: EventListener = (nativeEvent) => {
    onKeyEvent(nativeEvent as KeyboardEvent);
  };
  target.addEventListener(event, listener, options.capture);
  return () => {
    target.removeEventListener(event, listener, options.capture);
  };
};

export const MyoxusCommandRegistry = new (class {
  readonly commands: Map<string, MyoxusCommand> = new Map();
  /**
   * Monotonic registry revision for consumers that render command-backed UI.
   *
   * Commands are registered by mounted workspace capabilities. Reading only
   * `getAll()` during render would leave early-mounted menus permanently empty,
   * so consumers subscribe to this revision and still execute the canonical
   * registry entries rather than copying command state.
   */
  readonly revision$ = new LiveData(0);

  register(options: MyoxusCommandOptions) {
    if (this.commands.has(options.id)) {
      commandLogger.warn(`Command ${options.id} already registered.`);
      return () => {};
    }
    const command = createMyoxusCommand(options);
    this.commands.set(command.id, command);
    this.revision$.next(this.revision$.value + 1);

    let unsubKb: (() => void) | undefined;

    if (
      command.keyBinding &&
      !command.keyBinding.skipRegister &&
      typeof window !== "undefined"
    ) {
      const { binding: keybinding, capture } = command.keyBinding;
      unsubKb = bindKeys(
        window,
        keybinding,
        (event) => {
          event.preventDefault();
          command.run()?.catch((error) => {
            console.error(`Failed to run command [${command.id}]`, error);
          });
        },
        {
          capture,
        },
      );
    }

    commandLogger.debug(`Registered command ${command.id}`);
    return () => {
      unsubKb?.();
      this.commands.delete(command.id);
      this.revision$.next(this.revision$.value + 1);
      commandLogger.debug(`Unregistered command ${command.id}`);
    };
  }

  get(id: string): MyoxusCommand | undefined {
    if (!this.commands.has(id)) {
      commandLogger.warn(`Command ${id} not registered.`);
      return undefined;
    }
    return this.commands.get(id);
  }

  getAll(): MyoxusCommand[] {
    return Array.from(this.commands.values());
  }
})();

export function registerMyoxusCommand(options: MyoxusCommandOptions) {
  return MyoxusCommandRegistry.register(options);
}
