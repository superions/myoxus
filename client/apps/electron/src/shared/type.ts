import type {
  HelperClientHandlers,
  SharedStorageValue,
} from "@myoxus/desktop-api-contract";
import type { app, dialog, shell } from "electron";

export interface ExposedMeta {
  handlers: readonly (readonly [string, readonly string[]])[];
  events: readonly (readonly [string, readonly string[]])[];
}

// render <-> helper
export interface RendererToHelper {
  postEvent: (channel: string, ...args: SharedStorageValue[]) => void;
}

type FlattenHandlerNamespace<Namespace extends keyof HelperClientHandlers> = {
  [
    Handler in keyof HelperClientHandlers[Namespace] as `${Namespace &
      string}:${Handler & string}`
  ]: HelperClientHandlers[Namespace][Handler];
};

type UnionToIntersection<Union> = (
  Union extends object ? (value: Union) => void : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

export type HelperToRenderer = UnionToIntersection<
  {
    [
      Namespace in keyof HelperClientHandlers
    ]: FlattenHandlerNamespace<Namespace>;
  }[keyof HelperClientHandlers]
>;

// helper <-> main
export interface HelperToMain {
  getMeta: () => ExposedMeta;
}

export type MainToHelper = Pick<
  typeof dialog & typeof shell & typeof app,
  | "showOpenDialog"
  | "showSaveDialog"
  | "openExternal"
  | "showItemInFolder"
  | "getPath"
>;

export const MYOXUS_API_CHANNEL_NAME = "myoxus-ipc-api";
export const MYOXUS_EVENT_CHANNEL_NAME = "myoxus-ipc-event";
export const MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME = "myoxus-ipc-event-subscribe";
