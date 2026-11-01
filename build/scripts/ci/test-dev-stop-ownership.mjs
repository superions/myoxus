// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test(
  "dev-stop preserves another checkout despite matching commands and a stale PID file",
  { timeout: 15_000, skip: process.platform === "win32" },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "myoxus-dev-stop-"));
    const children = [];
    try {
      for (const name of ["own", "parallel"]) {
        const cwd = path.join(root, name);
        await mkdir(path.join(cwd, "build/scripts/server"), {
          recursive: true,
        });
        await mkdir(path.join(cwd, "tmp/dev"), { recursive: true });
        await writeFile(
          path.join(cwd, "build/scripts/server/dev-gateway.mjs"),
          "setInterval(() => {}, 1000);\n",
        );
        const child = spawn(
          process.execPath,
          ["build/scripts/server/dev-gateway.mjs"],
          { cwd, detached: true, stdio: "ignore" },
        );
        children.push(child);
        await once(child, "spawn");
      }
      const [owned, parallel] = children;
      const cwd = path.join(root, "own");
      await cp(
        fileURLToPath(new URL("../server/dev-stop.sh", import.meta.url)),
        path.join(cwd, "build/scripts/server/dev-stop.sh"),
      );
      await writeFile(
        path.join(cwd, "tmp/dev/dev-gateway.pid"),
        String(parallel.pid),
      );
      const stopped = once(owned, "exit");
      const command = spawn("bash", ["build/scripts/server/dev-stop.sh"], {
        cwd,
        stdio: "pipe",
      });
      let output = "";
      command.stdout.on("data", (chunk) => (output += chunk));
      command.stderr.on("data", (chunk) => (output += chunk));
      const [code] = await once(command, "exit");
      assert.equal(code, 0, output);
      await stopped;
      assert.equal(parallel.exitCode, null, "parallel checkout was stopped");
      assert.equal(
        parallel.signalCode,
        null,
        "parallel checkout received a signal",
      );
      assert.equal(process.kill(parallel.pid, 0), true);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const stopped = once(child, "exit");
          process.kill(-child.pid, "SIGKILL");
          await stopped;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);
