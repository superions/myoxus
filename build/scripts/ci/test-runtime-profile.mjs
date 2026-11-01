// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
test("runtime ownership fails before mutation for missing, foreign and escaping profiles", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "myoxus-runtime-")));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const state = join(root, "state");
    mkdirSync(state);
    const profile = join(root, "profile.json");
    const script = resolve("build/scripts/server/runtime-profile.mjs");
    const run = () =>
      spawnSync(process.execPath, [script, "exports", repo], {
        env: { ...process.env, MYOXUS_RUNTIME_PROFILE: profile },
        encoding: "utf8",
      });
    assert.notEqual(run().status, 0);
    const data = {
      schema: "myoxus.runtime-profile.v1",
      checkout: repo,
      project: "isolated-test",
      mode: "isolated",
      stateDirectory: state,
      environment: {},
    };
    for (const key of [
      "MYOXUS_DATA_DIR",
      "MYOXUS_RUNTIME_CONFIG_DIR",
      "MYOXUS_STYLE_HOST_DIR",
      "MYOXUS_POSTGRES_PASSWORD_FILE",
      "MYOXUS_CRYPTO_PRIVATE_KEY_FILE",
      "MYOXUS_FRONTEND_ASSET_ROOT",
    ])
      data.environment[key] = join(state, key);
    writeFileSync(profile, JSON.stringify(data));
    assert.equal(run().status, 0);
    const bin = join(root, "bin");
    mkdirSync(bin);
    const docker = join(bin, "docker");
    writeFileSync(
      docker,
      `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='compose') console.log(JSON.stringify({name:'isolated-test',volumes:{},services:{}}));
else if(args[0]==='ps') console.log('old-container');
else if(args[0]==='inspect') console.log(JSON.stringify([{Id:'old-container',Config:{Labels:{'com.docker.compose.project.working_dir':'/old-checkout/build/server'}},State:{Running:true}}]));
else process.exit(90);
`,
    );
    chmodSync(docker, 0o755);
    data.mode = "maintenance";
    data.volumes = [];
    data.ports = [];
    data.previousContainerIds = ["old-container"];
    data.coldRecoveryVerified = true;
    data.migrationLedgerVerified = true;
    writeFileSync(profile, JSON.stringify(data));
    const refused = spawnSync(process.execPath, [script, "verify", repo], {
      env: {
        ...process.env,
        MYOXUS_RUNTIME_PROFILE: profile,
        PATH: bin + ":" + process.env.PATH,
      },
      encoding: "utf8",
    });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /running old-checkout instance/);
    data.checkout = root;
    writeFileSync(profile, JSON.stringify(data));
    assert.notEqual(run().status, 0);
    data.checkout = repo;
    writeFileSync(profile, JSON.stringify(data));
    assert.match(run().stdout, new RegExp(`${state}/templates`));
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    symlinkSync(foreign, join(state, "redirect"));
    data.environment.MYOXUS_TEMPLATE_HOST_DIR = join(
      state,
      "redirect",
      "missing",
    );
    writeFileSync(profile, JSON.stringify(data));
    const escaping = run();
    assert.notEqual(escaping.status, 0);
    assert.match(escaping.stderr, /escapes through a symlink/);
    delete data.environment.MYOXUS_TEMPLATE_HOST_DIR;
    data.environment.MYOXUS_DATA_DIR = "/unrelated/data";
    writeFileSync(profile, JSON.stringify(data));
    assert.notEqual(run().status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
