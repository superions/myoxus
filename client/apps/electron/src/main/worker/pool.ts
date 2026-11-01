import { join } from "node:path";

import { BrowserWindow, MessageChannelMain, type WebContents } from "electron";

import { backgroundWorkerViewUrl } from "../constants";
import { ensureHelperProcess } from "../helper-process";
import { logger } from "../logger";
import { isAppQuitInProgress } from "../cleanup";
import { getRendererAdditionalArguments } from "../renderer-arguments";
import { buildWebPreferences } from "../web-preferences";

export class WorkerManager {
  static readonly instance = new WorkerManager();

  workers = new Map<
    string,
    {
      browserWindow: BrowserWindow;
      ports: Set<string>;
      key: string;
      loaded: PromiseWithResolvers<void>;
    }
  >();

  private async getOrCreateWorker(key: string) {
    const additionalArguments = await getRendererAdditionalArguments("worker");
    const helperProcessManager = await ensureHelperProcess();
    const exists = this.workers.get(key);
    if (exists) {
      return exists;
    } else {
      const worker = new BrowserWindow({
        width: 1200,
        height: 600,
        webPreferences: buildWebPreferences({
          preload: join(__dirname, "./preload.js"),
          additionalArguments: additionalArguments,
        }),
        show: false,
      });

      const record = {
        browserWindow: worker,
        ports: new Set<string>(),
        key,
        loaded: Promise.withResolvers<void>(),
      };

      const deadline = setTimeout(
        () => handleWorkerFailure("startup timed out after 30 seconds"),
        30_000,
      );
      // Failure can precede the caller awaiting readiness.
      void record.loaded.promise.catch(() => undefined);
      let disconnectHelperProcess: (() => void) | null = null;
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) {
          return;
        }
        cleanedUp = true;
        clearTimeout(deadline);
        record.loaded.reject(
          new Error(`worker ${key} closed before readiness`),
        );
        if (this.workers.get(key) === record) this.workers.delete(key);
        disconnectHelperProcess?.();
        disconnectHelperProcess = null;
      };
      const handleWorkerFailure = (reason: string) => {
        if (cleanedUp) return;
        logger.error("[worker] renderer process gone", { key, reason });
        record.loaded.reject(new Error(`worker ${key} failed: ${reason}`));
        cleanup();
        try {
          worker.destroy();
        } catch (err) {
          logger.warn("failed to destroy worker window", err);
        }
      };
      worker.on("closed", cleanup);
      worker.webContents.on("render-process-gone", (_event, details) => {
        if (isAppQuitInProgress()) {
          logger.info("[worker] renderer process exited during quit", {
            key,
            reason: details.reason,
          });
          cleanup();
          return;
        }
        handleWorkerFailure(details.reason ?? "unknown");
      });
      worker.webContents.on("unresponsive", () => {
        handleWorkerFailure("unresponsive");
      });
      worker.webContents.once("did-finish-load", () => {
        if (cleanedUp) return;
        clearTimeout(deadline);
        try {
          disconnectHelperProcess = helperProcessManager.connectRenderer(
            worker.webContents,
          );
          record.loaded.resolve();
        } catch {
          handleWorkerFailure("helper connection failed");
        }
      });

      this.workers.set(key, record);
      worker
        .loadURL(backgroundWorkerViewUrl)
        .catch(() => handleWorkerFailure("load failed"));
      return record;
    }
  }

  async connectWorker(
    key: string,
    portId: string,
    bindWebContent: WebContents,
  ) {
    const worker = await this.getOrCreateWorker(key);
    if (bindWebContent.isDestroyed())
      throw new Error("Requesting renderer closed");
    worker.ports.add(portId);
    const { port1: portForWorker, port2: portForRenderer } =
      new MessageChannelMain();
    let cancelled = false;
    const disconnect = () => {
      cancelled = true;
      this.disconnectWorker(key, portId);
    };
    bindWebContent.once("destroyed", disconnect);
    try {
      await worker.loaded.promise;
      if (cancelled || bindWebContent.isDestroyed())
        throw new Error("Requesting renderer closed");
      worker.browserWindow.webContents.postMessage(
        "worker-connect",
        { portId },
        [portForWorker],
      );
      return { portForRenderer, portId };
    } catch (error) {
      bindWebContent.removeListener("destroyed", disconnect);
      portForWorker.close();
      portForRenderer.close();
      this.disconnectWorker(key, portId);
      throw error;
    }
  }

  disconnectWorker(key: string, portId: string) {
    const worker = this.workers.get(key);
    if (worker) {
      worker.ports.delete(portId);
      if (worker.ports.size === 0) {
        worker.browserWindow.destroy();
        this.workers.delete(key);
      }
    }
  }
}
