import type {
  MainClientEvents,
  MainClientHandlers,
} from "@myoxus/desktop-api-contract";

type MainHandlerImplementation<Handler> = Handler extends (
  ...args: infer Args
) => Promise<infer Result>
  ? (event: Electron.IpcMainInvokeEvent, ...args: Args) => Promise<Result>
  : never;

export type MainHandlerImplementations = {
  [Namespace in keyof MainClientHandlers]: {
    [Handler in keyof MainClientHandlers[Namespace]]: MainHandlerImplementation<
      MainClientHandlers[Namespace][Handler]
    >;
  };
};

export type MainEventImplementations = MainClientEvents;
