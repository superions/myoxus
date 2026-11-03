// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  prepareRelease,
  publishPreparedRelease,
} from "../release/publish-github-release.mjs";

const revision = "1".repeat(40),
  commit = "2".repeat(40),
  version = "1.2.3";
const repository = "https://github.com/superions/myoxus";
const token = "fixture-github-contents-token";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const response = (value, status = 200) =>
  new Response(Buffer.isBuffer(value) ? value : JSON.stringify(value), {
    status,
  });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "myoxus-github-copy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const publicSource = {
    repository,
    commit,
    tree: "3".repeat(40),
  };
  const input = {
    scope: "selfhost",
    tag: `v${version}`,
    version,
    prerelease: true,
    notes: "Public self-hosting beta. Desktop packages are not included.",
    assets: [],
    containers: [],
  };
  const bodies = new Map();
  function asset(name, kind, value, role) {
    const bytes = Buffer.from(
      typeof value === "string" ? value : JSON.stringify(value),
    );
    const url = `https://git.blume29.de/api/packages/myoxus/generic/reviewed/${version}/${name}`;
    bodies.set(url, bytes);
    input.assets.push({
      name,
      kind,
      url,
      sha256: digest(bytes),
      size: bytes.length,
      ...(role ? { role } : {}),
    });
  }
  const provenance = {
    schemaVersion: 1,
    revision,
    publicSource,
    summary: { inReleaseBlocked: [], inReleaseReady: ["server", "frontends"] },
  };
  asset("release-provenance.json", "provenance", provenance);
  asset("server-legal.tar", "legal", "owned legal bundle bytes");
  asset("server.cdx.json", "sbom", {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: { component: { name: "myoxus-server", version } },
  });
  input.containers = [
    {
      role: "server",
      coordinate: `git.blume29.de/myoxus/myoxus@sha256:${"a".repeat(64)}`,
    },
    {
      role: "web",
      coordinate: `git.blume29.de/myoxus/myoxus-web-frontend@sha256:${"b".repeat(64)}`,
    },
    {
      role: "admin",
      coordinate: `git.blume29.de/myoxus/myoxus-admin-frontend@sha256:${"c".repeat(64)}`,
    },
  ];
  const inputFile = path.join(root, "allowlist.json");
  const save = () => fs.writeFileSync(inputFile, JSON.stringify(input));
  save();
  const state = {
    release: undefined,
    assets: [],
    writes: [],
    failNextUpload: false,
    tagCommit: undefined,
    sourcePublished: true,
    nextAssetId: 1,
    tree: publicSource.tree,
  };
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url),
      method = options.method ?? "GET";
    if (method !== "GET") state.writes.push(`${method} ${u.pathname}`);
    if (bodies.has(url)) return response(bodies.get(url));
    if (u.pathname.endsWith(`/git/commits/${commit}`))
      return state.sourcePublished
        ? response({ sha: commit, tree: { sha: state.tree } })
        : response({}, 404);
    if (u.pathname.includes("/git/ref/tags/"))
      return state.tagCommit
        ? response({ object: { type: "commit", sha: state.tagCommit } })
        : response({}, 404);
    if (u.pathname.includes("/releases/tags/"))
      return state.release && !state.release.draft
        ? response(state.release)
        : response({}, 404);
    if (u.hostname === "uploads.github.com") {
      assert.equal(options.headers.Accept, "application/vnd.github+json");
      if (state.failNextUpload) {
        state.failNextUpload = false;
        state.assets.push({
          id: state.nextAssetId++,
          name: u.searchParams.get("name"),
          size: 0,
          state: "starter",
        });
        return response({}, 503);
      }
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      const bytes = Buffer.from(options.body);
      const item = {
        id: state.nextAssetId++,
        name: u.searchParams.get("name"),
        size: bytes.length,
        bytes,
        digest: `sha256:${digest(bytes)}`,
        state: "uploaded",
      };
      state.assets.push(item);
      return response({ id: item.id });
    }
    if (/\/releases\/assets\/\d+$/.test(u.pathname)) {
      const item = state.assets.find(
        (a) => a.id === Number(u.pathname.split("/").at(-1)),
      );
      if (method === "DELETE") {
        assert.equal(state.release.draft, true);
        assert.equal(item.state, "starter");
        state.assets.splice(state.assets.indexOf(item), 1);
        return new Response(null, { status: 204 });
      }
      return response(item.bytes);
    }
    if (/\/releases\/\d+\/assets$/.test(u.pathname))
      return response(state.assets.map(({ bytes: _bytes, ...item }) => item));
    if (u.pathname.endsWith("/releases") && method === "GET")
      return response(state.release ? [state.release] : []);
    if (u.pathname.endsWith("/releases") && method === "POST") {
      assert.equal(
        state.release,
        undefined,
        "retry must recover the existing draft",
      );
      state.release = { ...JSON.parse(options.body), id: 41 };
      return response(state.release, 201);
    }
    if (u.pathname.endsWith("/releases/41") && method === "PATCH") {
      assert.equal(
        state.assets.length,
        2,
        "an incomplete draft must never be published",
      );
      Object.assign(state.release, JSON.parse(options.body));
      state.tagCommit = commit;
      return response(state.release);
    }
    throw new Error(`Unexpected fixture request ${method} ${url}`);
  };
  return { root, inputFile, input, bodies, state, fetchImpl, save, asset };
}

test("preparation copies qualified bytes and rejects changed source or desktop payloads", async (t) => {
  const f = fixture(t);
  const nativeServerRoot = path.join(f.root, "server-release");
  const nativeRun = path.join(nativeServerRoot, `42-${revision}`);
  const deb = `packages/deb/myoxus-server_${version}+git.${"4".repeat(12)}_amd64.deb`;
  const rpm = `packages/rpm/myoxus-server-${version}+git.${"4".repeat(12)}-1.x86_64.rpm`;
  const files = [
    [deb, "qualified DEB bytes"],
    [rpm, "qualified RPM bytes"],
    [
      "bundle/myoxus-server-linux-x64/legal/sbom/server.cdx.json",
      JSON.stringify({
        metadata: {
          component: {
            version,
            properties: [
              { name: "myoxus:git-revision", value: "5".repeat(40) },
            ],
          },
        },
      }),
    ],
  ];
  for (const [relative, bytes] of files) {
    fs.mkdirSync(path.dirname(path.join(nativeRun, relative)), {
      recursive: true,
    });
    fs.writeFileSync(path.join(nativeRun, relative), bytes);
  }
  fs.writeFileSync(
    path.join(nativeRun, "SHA256SUMS"),
    files
      .map(([relative, bytes]) => `${digest(bytes)}  ${relative}\n`)
      .join(""),
  );
  f.state.sourcePublished = false;
  const prepared = await prepareRelease({
    inputFile: f.inputFile,
    outputDir: path.join(f.root, "prepared"),
    fetchImpl: f.fetchImpl,
    nativeServerRoot,
  });
  assert.equal(prepared.plan.assets.length, 4);
  assert.deepEqual(
    execFileSync("tar", [
      "-xzOf",
      path.join(
        prepared.output,
        "assets",
        `myoxus-${version}-legal-provenance.tar.gz`,
      ),
      "server-legal.tar",
    ]),
    f.bodies.get(f.input.assets.find((a) => a.kind === "legal").url),
  );
  assert.equal(
    prepared.plan.assets.some((a) => /source.*\.tar$/.test(a.name)),
    false,
  );
  assert.equal(
    fs.readFileSync(
      path.join(prepared.output, "assets", path.basename(deb)),
      "utf8",
    ),
    "qualified DEB bytes",
  );
  fs.writeFileSync(path.join(nativeRun, rpm), "changed RPM bytes");
  await assert.rejects(
    prepareRelease({
      inputFile: f.inputFile,
      outputDir: path.join(f.root, "changed-native"),
      fetchImpl: f.fetchImpl,
      nativeServerRoot,
    }),
    /Native server checksum differs/,
  );
  await assert.rejects(
    publishPreparedRelease({
      planFile: path.join(prepared.output, "github-release-plan.json"),
      expectedSha256: prepared.sha256,
      token,
      fetchImpl: f.fetchImpl,
    }),
    /HTTP 404/,
  );
  assert.equal(f.state.writes.length, 0);
  f.bodies.set(
    f.input.assets.find((a) => a.kind === "legal").url,
    Buffer.from("different legal bytes"),
  );
  await assert.rejects(
    prepareRelease({
      inputFile: f.inputFile,
      outputDir: path.join(f.root, "wrong-source"),
      fetchImpl: f.fetchImpl,
    }),
    /bytes differ/i,
  );
  f.input.assets[0].name = "myoxus-installer.exe";
  f.save();
  await assert.rejects(
    prepareRelease({
      inputFile: f.inputFile,
      outputDir: path.join(f.root, "desktop"),
      fetchImpl: f.fetchImpl,
    }),
    /must not contain desktop/,
  );
});

test("failed upload stays a draft; same-byte retry completes once and is idempotent", async (t) => {
  const f = fixture(t);
  const prepared = await prepareRelease({
    inputFile: f.inputFile,
    outputDir: path.join(f.root, "prepared"),
    fetchImpl: f.fetchImpl,
  });
  const options = {
    planFile: path.join(prepared.output, "github-release-plan.json"),
    expectedSha256: prepared.sha256,
    token,
    fetchImpl: f.fetchImpl,
  };
  f.state.failNextUpload = true;
  await assert.rejects(publishPreparedRelease(options), /HTTP 503/);
  assert.equal(f.state.release.draft, true);
  assert.equal(f.state.tagCommit, undefined);
  assert.equal((await publishPreparedRelease(options)).alreadyPublished, false);
  const writes = f.state.writes.length;
  assert.equal((await publishPreparedRelease(options)).alreadyPublished, true);
  assert.equal(f.state.writes.length, writes);
  f.state.assets[0].digest = "sha256:" + "f".repeat(64);
  await assert.rejects(
    publishPreparedRelease(options),
    /immutable asset has different bytes/,
  );
  delete f.state.assets[0].digest;
  assert.equal((await publishPreparedRelease(options)).alreadyPublished, true);
  f.state.assets[0].bytes[0] ^= 1;
  await assert.rejects(
    publishPreparedRelease(options),
    /immutable asset has different bytes/,
  );
  assert.equal(
    f.state.writes.length,
    writes,
    "conflicts must not mutate existing assets",
  );
});

test("publication rejects a different reviewed plan, changed local bytes and an existing foreign tag before writes", async (t) => {
  const f = fixture(t);
  const prepared = await prepareRelease({
    inputFile: f.inputFile,
    outputDir: path.join(f.root, "prepared"),
    fetchImpl: f.fetchImpl,
  });
  const options = {
    planFile: path.join(prepared.output, "github-release-plan.json"),
    expectedSha256: prepared.sha256,
    token,
    fetchImpl: f.fetchImpl,
  };
  await assert.rejects(
    publishPreparedRelease({ ...options, expectedSha256: "f".repeat(64) }),
    /reviewed SHA-256/,
  );
  f.state.tagCommit = "b".repeat(40);
  await assert.rejects(publishPreparedRelease(options), /immutable tag/);
  f.state.tagCommit = undefined;
  fs.appendFileSync(
    path.join(prepared.output, "assets", prepared.plan.assets[0].name),
    "tamper",
  );
  await assert.rejects(
    publishPreparedRelease(options),
    /Prepared bytes changed/,
  );
  assert.equal(f.state.writes.length, 0);
});
