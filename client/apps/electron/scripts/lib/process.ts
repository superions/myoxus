// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessOptions {
  args?: string[];
  command: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  stdio?: "inherit" | "pipe";
  timeoutMs?: number;
}

export interface ManagedProcess {
  child: ChildProcess;
  completion: Promise<void>;
  stop(reason?: string): Promise<void>;
}

const activeProcesses = new Set<ManagedProcess>();
let parentStopping = false;

/** Build stages spawn independent process groups. A parent signal must reach
 * those owned groups before the orchestrator exits, including nested stages. */
function stopForParentSignal(signal: "SIGINT" | "SIGTERM") {
  if (parentStopping) return;
  parentStopping = true;
  void Promise.allSettled(
    [...activeProcesses].map((managed) => managed.stop(`parent ${signal}`)),
  ).then((results) => {
    for (const result of results)
      if (result.status === "rejected") console.error(result.reason);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
const parentInterrupted = () => stopForParentSignal("SIGINT");
const parentTerminated = () => stopForParentSignal("SIGTERM");

function trackProcess(managed: ManagedProcess) {
  if (!activeProcesses.size) {
    process.on("SIGINT", parentInterrupted);
    process.on("SIGTERM", parentTerminated);
  }
  activeProcesses.add(managed);
  const release = () => {
    activeProcesses.delete(managed);
    if (!activeProcesses.size) {
      process.removeListener("SIGINT", parentInterrupted);
      process.removeListener("SIGTERM", parentTerminated);
    }
  };
  void managed.completion.then(release, release);
  return managed;
}

async function exitsWithin(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener("exit", exited);
      resolve(false);
    }, timeoutMs);
    const exited = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", exited);
  });
}

export function yarnInvocation(repoRoot: string, args: string[]) {
  const releaseDir = path.join(repoRoot, ".yarn", "releases");
  const release = existsSync(releaseDir)
    ? readdirSync(releaseDir)
        .filter((file) => /^yarn-.*\.cjs$/.test(file))
        .sort()
        .at(-1)
    : undefined;
  return release
    ? { command: process.execPath, args: [path.join(releaseDir, release), ...args] }
    : { command: "corepack", args: ["yarn", ...args] };
}

export async function stopProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  runTaskkill: typeof execFileAsync = execFileAsync,
): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32") {
    await runTaskkill("taskkill", [
      "/pid",
      String(child.pid),
      "/t",
      "/f",
    ]);
    if (!(await exitsWithin(child, 5_000))) {
      throw new Error(`Process ${child.pid} did not exit after taskkill`);
    }
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  if (await exitsWithin(child, 500)) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    return;
  }
  if (!(await exitsWithin(child, 5_000))) {
    throw new Error(`Process ${child.pid} did not exit after SIGKILL`);
  }
}

export function startProcess(options: ProcessOptions): ManagedProcess {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    detached: process.platform !== "win32",
    env: options.env ?? process.env,
    shell: false,
    stdio: options.stdio ?? "inherit",
  });
  let stopping: Promise<void> | undefined;
  let requestedStop = false;
  let terminationError: Error | undefined;
  const stop = (reason = "requested") => {
    requestedStop = true;
    stopping ??= stopProcessTree(child).catch((error) => {
      throw new Error(`Failed to stop ${options.command} (${reason})`, {
        cause: error,
      });
    });
    return stopping;
  };

  const completion = new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout | undefined;
    const abort = () => {
      terminationError = new Error(`${options.command} was aborted`);
      void stop("aborted").then(
        () => reject(terminationError),
        reject,
      );
    };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        terminationError = new Error(
          `${options.command} timed out after ${options.timeoutMs} ms`,
        );
        void stop("timeout").then(
          () => reject(terminationError),
          reject,
        );
      }, options.timeoutMs);
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (terminationError) return;
      if (code === 0 || requestedStop) resolve();
      else reject(new Error(`${options.command} exited with code ${code ?? "null"} and signal ${signal ?? "none"}`));
    });
  });

  return trackProcess({ child, completion, stop });
}

export async function runProcess(options: ProcessOptions): Promise<void> {
  await startProcess(options).completion;
}

export async function runProcessCapture(
  options: Omit<ProcessOptions, "stdio">,
): Promise<{ stderr: string; stdout: string }> {
  const managed = startProcess({ ...options, stdio: "pipe" });
  let stdout = "";
  let stderr = "";
  managed.child.stdout?.setEncoding("utf8");
  managed.child.stderr?.setEncoding("utf8");
  managed.child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  managed.child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await managed.completion;
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
      { cause: error },
    );
  }
  return { stderr, stdout };
}
