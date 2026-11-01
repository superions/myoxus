import {
  type ClientEvents,
  type ClientHandler,
  type HelperClientEvents,
  type HelperClientHandlers,
  helperEventChannelManifest,
  helperHandlerChannelManifest,
  type MainClientEvents,
  type MainClientHandlers,
  mainEventChannelManifest,
  mainHandlerChannelManifest,
} from "@myoxus/desktop-api-contract";
import { AsyncCall } from "async-call-rpc";
import { ipcRenderer } from "electron";
import { Subject } from "rxjs";
import { z } from "zod";

import { parseExposedMeta } from "../shared/exposed-meta";
import {
  type ExposedMeta,
  type HelperToRenderer,
  MYOXUS_API_CHANNEL_NAME,
  MYOXUS_EVENT_CHANNEL_NAME,
  MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME,
  type RendererToHelper,
} from "../shared/type";
import {
  createMessagePortChannel,
  type RendererMessagePort,
} from "./message-port-channel";

type Schema = "myoxus" | "myoxus-beta" | "myoxus-internal" | "myoxus-dev";

// todo: remove duplicated codes
const ReleaseTypeSchema = z.enum(["stable", "beta", "internal"]);
const envBuildType = (process.env.BUILD_TYPE || "stable").trim().toLowerCase();
const buildType = ReleaseTypeSchema.parse(envBuildType);
const isDev = process.env.NODE_ENV === "development";
let scheme =
  buildType === "stable" ? "myoxus" : (`myoxus-${envBuildType}` as Schema);
scheme = isDev ? "myoxus-dev" : scheme;

export const appInfo = {
  electron: true,
  windowName:
    process.argv
      .find((arg) => arg.startsWith("--window-name="))
      ?.split("=")[1] ?? "unknown",
  viewId:
    process.argv.find((arg) => arg.startsWith("--view-id="))?.split("=")[1] ??
    "unknown",
  scheme,
};

export type AppInfo = typeof appInfo;

function getMainAPIs(): {
  apis: MainClientHandlers;
  events: MainClientEvents;
} {
  const meta: ExposedMeta = (() => {
    const val = process.argv
      .find((arg) => arg.startsWith("--main-exposed-meta="))
      ?.split("=")[1];

    return parseExposedMeta(
      val ? JSON.parse(val) : null,
      mainHandlerChannelManifest,
      mainEventChannelManifest,
      "main exposed metadata",
    );
  })();

  // main handlers that can be invoked from the renderer process
  const apis = (() => {
    const { handlers: handlersMeta } = meta;

    const all = handlersMeta.map(([namespace, functionNames]) => {
      const namespaceApis = functionNames.map((name) => {
        const channel = `${namespace}:${name}`;
        return [
          name,
          (...args: unknown[]) => {
            return ipcRenderer.invoke(
              MYOXUS_API_CHANNEL_NAME,
              channel,
              ...args,
            );
          },
        ];
      });
      return [namespace, Object.fromEntries(namespaceApis)];
    });

    return Object.fromEntries(all);
  })() as MainClientHandlers;

  // main events that can be listened to from the renderer process
  const events = (() => {
    const { events: eventsMeta } = meta;

    // channel -> callback[]
    const listenersMap = new Map<string, ((...args: unknown[]) => void)[]>();
    const subscribeCounts = new Map<string, number>();

    const subscribe = (channel: string) => {
      const count = (subscribeCounts.get(channel) ?? 0) + 1;
      subscribeCounts.set(channel, count);
      if (count === 1) {
        ipcRenderer.send(
          MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME,
          "subscribe",
          channel,
        );
      }
    };

    const unsubscribe = (channel: string) => {
      const count = (subscribeCounts.get(channel) ?? 0) - 1;
      if (count <= 0) {
        subscribeCounts.delete(channel);
        ipcRenderer.send(
          MYOXUS_EVENT_SUBSCRIBE_CHANNEL_NAME,
          "unsubscribe",
          channel,
        );
      } else {
        subscribeCounts.set(channel, count);
      }
    };

    ipcRenderer.on(MYOXUS_EVENT_CHANNEL_NAME, (_event, channel, ...args) => {
      if (typeof channel !== "string") {
        console.error("invalid ipc event", channel);
        return;
      }
      const [namespace, name] = channel.split(":");
      if (!namespace || !name) {
        console.error("invalid ipc event", channel);
        return;
      }
      const listeners = listenersMap.get(channel) ?? [];
      listeners.forEach((listener) => listener(...args));
    });

    const all = eventsMeta.map(([namespace, eventNames]) => {
      const namespaceEvents = eventNames.map((name) => {
        const channel = `${namespace}:${name}`;
        return [
          name,
          (callback: (...args: unknown[]) => void) => {
            listenersMap.set(channel, [
              ...(listenersMap.get(channel) ?? []),
              callback,
            ]);
            subscribe(channel);

            return () => {
              const listeners = listenersMap.get(channel) ?? [];
              const index = listeners.indexOf(callback);
              if (index === -1) {
                return;
              }
              listeners.splice(index, 1);
              unsubscribe(channel);
              if (listeners.length === 0) {
                listenersMap.delete(channel);
              } else {
                listenersMap.set(channel, listeners);
              }
            };
          },
        ];
      });
      return [namespace, Object.fromEntries(namespaceEvents)];
    });
    return Object.fromEntries(all);
  })() as MainClientEvents;

  return { apis, events };
}

const helperPort = new Promise<RendererMessagePort>((resolve, reject) =>
  ipcRenderer.on("helper-connection", (e) => {
    const port = e.ports[0];
    if (!port) {
      reject(new Error("Helper connection did not include a MessagePort"));
      return;
    }
    // Electron exposes a browser MessagePort here, while this Node-targeted
    // preload project intentionally has no global DOM type library.
    resolve(port as unknown as RendererMessagePort);
  }),
);

function getHelperAPIs(): {
  apis: HelperClientHandlers;
  events: HelperClientEvents;
} {
  const events$ = new Subject<{ channel: string; args: unknown[] }>();
  const meta: ExposedMeta = (() => {
    const val = process.argv
      .find((arg) => arg.startsWith("--helper-exposed-meta="))
      ?.split("=")[1];

    return parseExposedMeta(
      val ? JSON.parse(val) : null,
      helperHandlerChannelManifest,
      helperEventChannelManifest,
      "helper exposed metadata",
    );
  })();

  const rendererToHelperServer: RendererToHelper = {
    postEvent: (channel, ...args) => {
      events$.next({ channel, args });
    },
  };

  const rpc = AsyncCall<HelperToRenderer>(rendererToHelperServer, {
    channel: helperPort.then((helperPort) =>
      createMessagePortChannel(helperPort),
    ),
    log: false,
  });
  // The dynamic dispatch table is internal to the validated helper manifest.
  // Unlike persisted shared state, helper RPC values may contain binary data.
  const runtimeRpc = rpc as unknown as Readonly<
    Record<string, (...args: unknown[]) => Promise<unknown>>
  >;

  const toHelperHandler = (namespace: string, name: string) => {
    const handler = runtimeRpc[`${namespace}:${name}`];
    if (!handler) {
      throw new Error(`Missing helper IPC handler: ${namespace}:${name}`);
    }
    return handler;
  };

  const toHelperEventSubscriber = (namespace: string, name: string) => {
    return (callback: (...args: unknown[]) => void) => {
      const subscription = events$.subscribe(({ channel, args }) => {
        if (channel === `${namespace}:${name}`) {
          callback(...args);
        }
      });
      return () => {
        subscription.unsubscribe();
      };
    };
  };

  const setup = (meta: ExposedMeta) => {
    const { handlers, events } = meta;

    const helperHandlers = Object.fromEntries(
      handlers.map(([namespace, functionNames]) => {
        return [
          namespace,
          Object.fromEntries(
            functionNames.map((name) => {
              return [name, toHelperHandler(namespace, name)];
            }),
          ),
        ];
      }),
    );

    const helperEvents = Object.fromEntries(
      events.map(([namespace, eventNames]) => {
        return [
          namespace,
          Object.fromEntries(
            eventNames.map((name) => {
              return [name, toHelperEventSubscriber(namespace, name)];
            }),
          ),
        ];
      }),
    );
    return [
      helperHandlers as unknown as HelperClientHandlers,
      helperEvents as HelperClientEvents,
    ] as const;
  };

  const [apis, events] = setup(meta);
  return { apis, events };
}

const mainAPIs = getMainAPIs();
const helperAPIs = getHelperAPIs();

export const apis: ClientHandler = {
  ...mainAPIs.apis,
  ...helperAPIs.apis,
};

export const events: ClientEvents = {
  ...mainAPIs.events,
  ...helperAPIs.events,
};
