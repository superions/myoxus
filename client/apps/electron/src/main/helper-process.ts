import path from "node:path";

import { type _AsyncVersionOf, AsyncCall } from "async-call-rpc";
import {
  app,
  type BaseWindow,
  dialog,
  MessageChannelMain,
  type OpenDialogOptions,
  type SaveDialogOptions,
  shell,
  type UtilityProcess,
  utilityProcess,
  type WebContents,
} from "electron";

import type { HelperToMain, MainToHelper } from "../shared/type";
import { MessageEventChannel } from "../shared/utils";
import { beforeAppQuit, isAppQuitInProgress } from "./cleanup";
import { logger } from "./logger";
import { openExternalSafely } from "./security/open-external";

const HELPER_PROCESS_PATH = path.join(__dirname, "./helper.js");

const isDev = process.env.NODE_ENV === "development";

function pickAndBind<T extends object, U extends keyof T>(
  obj: T,
  keys: U[],
): { [K in U]: T[K] } {
  const selected = {} as { [K in U]: T[K] };
  return keys.reduce((acc, key) => {
    const prop = obj[key];
    acc[key] = typeof prop === "function" ? prop.bind(obj) : prop;
    return acc;
  }, selected);
}

class HelperProcessManager {
  ready: Promise<void>;
  readonly #process: UtilityProcess;

  // a rpc server for the main process -> helper process
  rpc?: _AsyncVersionOf<HelperToMain>;

  static _instance: HelperProcessManager | null = null;

  static get instance() {
    if (!this._instance) {
      this._instance = new HelperProcessManager();
    }
    return this._instance;
  }

  private constructor() {
    const helperProcess = utilityProcess.fork(HELPER_PROCESS_PATH, [], {
      // todo: port number should not being used
      execArgv: isDev ? ["--inspect=40894"] : [],
      serviceName: "myoxus-helper",
    });
    this.#process = helperProcess;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const deadline = setTimeout(() => {
        fail(new Error("Helper startup timed out after 30 seconds"));
        helperProcess.kill();
      }, 30_000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (HelperProcessManager._instance === this)
          HelperProcessManager._instance = null;
        reject(error);
      };
      // UtilityProcess emits a fatal-error type, not a Node child-process Error.
      // Do not retain its diagnostic report, which can contain process secrets.
      helperProcess.once("error", (type) =>
        fail(new Error(`Helper failed before startup (${type})`)),
      );
      helperProcess.once("exit", (code) =>
        fail(new Error(`Helper exited before startup (${code})`)),
      );
      helperProcess.once("spawn", () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        logger.info("[helper] forked", helperProcess.pid);
        resolve();
      });
    });

    beforeAppQuit(() => {
      this.#process.kill();
    });

    this.#process.on("exit", (code) => {
      if (isAppQuitInProgress())
        logger.info("[helper] process exited", { code });
      else logger.error("[helper] process exited", { code });
      if (HelperProcessManager._instance === this)
        HelperProcessManager._instance = null;
    });

    this.#process.on("error", (err) => {
      logger.error("[helper] process error", err);
      if (HelperProcessManager._instance === this)
        HelperProcessManager._instance = null;
    });
  }

  // bridge renderer <-> helper process
  connectRenderer(renderer: WebContents) {
    // connect to the helper process
    const { port1: helperPort, port2: rendererPort } = new MessageChannelMain();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      helperPort.close();
      rendererPort.close();
    };
    try {
      this.#process.postMessage({ channel: "renderer-connect" }, [helperPort]);
      renderer.postMessage("helper-connection", null, [rendererPort]);
    } catch (error) {
      close();
      throw error;
    }
    return close;
  }

  // bridge main <-> helper process
  // also set up the RPC to the helper process
  connectMain(window: BaseWindow) {
    const dialogMethods = {
      showOpenDialog: async (opts: OpenDialogOptions) => {
        return dialog.showOpenDialog(window, opts);
      },
      showSaveDialog: async (opts: SaveDialogOptions) => {
        return dialog.showSaveDialog(window, opts);
      },
    };
    const shellMethods = {
      openExternal: openExternalSafely as typeof shell.openExternal,
      showItemInFolder: shell.showItemInFolder.bind(shell),
    };
    const appMethods = pickAndBind(app, ["getPath"]);

    const mainToHelperServer: MainToHelper = {
      ...dialogMethods,
      ...shellMethods,
      ...appMethods,
    };

    this.rpc = AsyncCall<HelperToMain>(mainToHelperServer, {
      strict: {
        // the channel is shared for other purposes as well so that we do not want to
        // restrict to only JSONRPC messages
        unknownMessage: false,
      },
      channel: new MessageEventChannel(this.#process),
      log: false,
    });
  }
}

export async function ensureHelperProcess() {
  const helperProcessManager = HelperProcessManager.instance;
  await helperProcessManager.ready;
  return helperProcessManager;
}
