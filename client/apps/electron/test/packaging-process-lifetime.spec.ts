// SPDX-License-Identifier: AGPL-3.0-or-later
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import { startProcess } from "../scripts/lib/process";

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

test("parent termination reaches nested detached build groups", async () => {
  const moduleUrl = new URL("../scripts/lib/process.ts", import.meta.url).href;
  const leafScript = "setInterval(() => {}, 1000)";
  const childScript = `import {startProcess} from ${JSON.stringify(moduleUrl)};
    const leaf = startProcess({command:process.execPath,args:['-e',${JSON.stringify(leafScript)}],cwd:${JSON.stringify(tmpdir())}});
    console.log(JSON.stringify({child:process.pid,leaf:leaf.child.pid}));
    await leaf.completion;`;
  const parentScript = `import {startProcess} from ${JSON.stringify(moduleUrl)};
    await startProcess({command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(childScript)}],cwd:${JSON.stringify(tmpdir())}}).completion;`;
  const parent = startProcess({
    command: process.execPath,
    args: ["--input-type=module", "-e", parentScript],
    cwd: tmpdir(),
    stdio: "pipe",
    timeoutMs: 4000,
  });
  let output = "";
  let errors = "";
  parent.child.stderr?.on("data", (chunk) => {
    errors += chunk.toString();
  });
  let descendants: { child: number; leaf: number } | undefined;
  parent.child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  try {
    await vi.waitFor(() => {
      expect(output.trim(), errors).not.toBe("");
      descendants = JSON.parse(output.trim());
      expect(descendants!.child).toBeGreaterThan(0);
      expect(descendants!.leaf).toBeGreaterThan(0);
    });
    await parent.stop();
    await parent.completion;
    await vi.waitFor(() => {
      expect(alive(descendants!.child)).toBe(false);
      expect(alive(descendants!.leaf)).toBe(false);
    });
  } finally {
    await parent.stop();
    for (const pid of [descendants?.child, descendants?.leaf])
      if (pid && alive(pid))
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  }
});
