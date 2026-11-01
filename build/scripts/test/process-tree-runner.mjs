// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";

const DEFAULT_KILL_GRACE_MS = 15_000;
const POST_KILL_SETTLE_MS = 100;

function terminateProcessGroup(child, signal) {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/**
 * Run one matrix command in its own process group.
 *
 * A timeout always signals the complete group and escalates to KILL even when
 * the direct shell exits after TERM. Waiting for that escalation is essential:
 * Cargo, Yarn and Vitest descendants can otherwise outlive their wrapper.
 */
export function runWithProcessTreeTimeout(
  command,
  args,
  { timeoutMs, killGraceMs = DEFAULT_KILL_GRACE_MS, ...spawnOptions },
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("timeoutMs must be a positive number");
  }
  if (!Number.isFinite(killGraceMs) || killGraceMs <= 0) {
    throw new Error("killGraceMs must be a positive number");
  }

  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(command, args, {
      ...spawnOptions,
      detached: process.platform !== "win32",
    });
    let childError;
    let childStatus = null;
    let childSignal = null;
    let timedOut = false;
    let settled = false;
    let timeoutTimer;
    let killTimer;
    let settleTimer;

    const elapsedMs = () =>
      Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(settleTimer);
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        pid: child.pid,
        status: timedOut ? 124 : childStatus,
        signal: childSignal,
        error: childError,
        elapsedMs: elapsedMs(),
        timedOut,
      });
    };

    const forwardInterrupt = () => terminateProcessGroup(child, "SIGINT");
    const forwardTerminate = () => terminateProcessGroup(child, "SIGTERM");
    process.once("SIGINT", forwardInterrupt);
    process.once("SIGTERM", forwardTerminate);

    child.once("error", (error) => {
      childError = error;
      if (!timedOut) finish();
    });
    child.once("close", (status, signal) => {
      childStatus = status;
      childSignal = signal;
      if (!timedOut) finish();
      // On timeout, wait for the mandatory group KILL below. The direct shell
      // may already be gone while a signal-ignoring compiler child remains.
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        terminateProcessGroup(child, "SIGKILL");
        child.unref();
        settleTimer = setTimeout(finish, POST_KILL_SETTLE_MS);
      }, killGraceMs);
    }, timeoutMs);
  });
}
