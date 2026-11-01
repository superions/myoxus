// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";

import {
  parseDistributionOverview,
  publishContainerDistributionOverview,
  publishDesktopDistributionOverview,
} from "./publish-distribution-overview.mjs";

const TOKEN = "fixture-token-1234567890";
const SOURCE = "a".repeat(40);
const SERVER_DIGEST = `sha256:${"1".repeat(64)}`;
const WEB_DIGEST = `sha256:${"2".repeat(64)}`;
const ADMIN_DIGEST = `sha256:${"3".repeat(64)}`;

function promotionEvidence(component, version = "1.2.3") {
  const packages =
    component === "server"
      ? [{ image: "myoxus", digest: SERVER_DIGEST }]
      : [
          { image: "myoxus-admin-frontend", digest: ADMIN_DIGEST },
          { image: "myoxus-web-frontend", digest: WEB_DIGEST },
        ];
  return {
    schemaVersion: 1,
    registryHost: "git.blume29.de",
    owner: "myoxus",
    stage: "promoted",
    packages: packages.map(({ image, digest }) => ({
      image,
      commitTag: SOURCE,
      promotionTag: version,
      commitDigest: digest,
      promotionDigest: digest,
      pseudoVersions: [],
    })),
  };
}

function desktopManifest(scope = "linux", version = "1.2.4") {
  return {
    schema: "myoxus.desktop-release.v1",
    version,
    channel: "stable",
    sourceCommit: SOURCE,
    scope,
    publishable: true,
    target: { owner: "myoxus", repository: "packages" },
    artifacts: [
      {
        name: `myoxus-${version}-stable-${scope}-x64.zip`,
        sha256: "4".repeat(64),
        signature: { status: "unsigned", verifier: "none" },
      },
    ],
  };
}

function forgejoContentsFixture() {
  let source = null;
  let revision = 0;
  let conflictOnce = false;
  return {
    conflictNextWrite() {
      conflictOnce = true;
    },
    read() {
      return source;
    },
    async fetch(_url, options = {}) {
      if (!options.method || options.method === "GET") {
        if (!source) return new Response("not found", { status: 404 });
        return Response.json({
          sha: `fixture-${revision}`,
          encoding: "base64",
          content: Buffer.from(source).toString("base64"),
        });
      }
      assert.equal(options.method, "PUT");
      if (conflictOnce) {
        conflictOnce = false;
        return new Response("conflict", { status: 409 });
      }
      const body = JSON.parse(options.body);
      if (source) assert.equal(body.sha, `fixture-${revision}`);
      source = Buffer.from(body.content, "base64").toString("utf8");
      revision += 1;
      return Response.json(
        { content: { sha: `fixture-${revision}` } },
        { status: 200 },
      );
    },
  };
}

test("merges independently published OCI and desktop entries into one overview", async () => {
  const remote = forgejoContentsFixture();
  const now = () => new Date("2026-09-01T20:00:00.000Z");
  await publishContainerDistributionOverview({
    component: "server",
    evidence: promotionEvidence("server"),
    fetchImpl: remote.fetch,
    now,
    sourceCommit: SOURCE,
    token: TOKEN,
    version: "1.2.3",
  });
  remote.conflictNextWrite();
  await publishContainerDistributionOverview({
    component: "frontends",
    evidence: promotionEvidence("frontends"),
    fetchImpl: remote.fetch,
    now,
    sourceCommit: SOURCE,
    token: TOKEN,
    version: "1.2.3",
  });
  await publishDesktopDistributionOverview({
    fetchImpl: remote.fetch,
    manifest: desktopManifest(),
    now,
    token: TOKEN,
  });

  const state = parseDistributionOverview(remote.read());
  assert.equal(state.containers.server.artifacts[0].digest, SERVER_DIGEST);
  assert.deepEqual(
    state.containers.frontends.artifacts.map(({ image }) => image),
    ["myoxus-admin-frontend", "myoxus-web-frontend"],
  );
  assert.equal(state.clients.linux.releaseTag, "linux-client-v1.2.4");
  assert.match(remote.read(), /without copying or rebuilding them/);
});

test("is idempotent and never replaces a newer overview entry", async () => {
  const remote = forgejoContentsFixture();
  const input = {
    component: "server",
    evidence: promotionEvidence("server", "2.0.0"),
    fetchImpl: remote.fetch,
    sourceCommit: SOURCE,
    token: TOKEN,
    version: "2.0.0",
  };
  assert.equal(
    (await publishContainerDistributionOverview(input)).changed,
    true,
  );
  assert.equal(
    (await publishContainerDistributionOverview(input)).changed,
    false,
  );
  const older = await publishContainerDistributionOverview({
    ...input,
    evidence: promotionEvidence("server", "1.9.9"),
    version: "1.9.9",
  });
  assert.equal(older.changed, false);
  assert.equal(
    parseDistributionOverview(remote.read()).containers.server.version,
    "2.0.0",
  );
});

test("rejects different bytes under an already recorded semantic version", async () => {
  const remote = forgejoContentsFixture();
  await publishContainerDistributionOverview({
    component: "server",
    evidence: promotionEvidence("server"),
    fetchImpl: remote.fetch,
    sourceCommit: SOURCE,
    token: TOKEN,
    version: "1.2.3",
  });
  const conflicting = promotionEvidence("server");
  conflicting.packages[0].commitDigest = `sha256:${"f".repeat(64)}`;
  conflicting.packages[0].promotionDigest =
    conflicting.packages[0].commitDigest;
  await assert.rejects(
    publishContainerDistributionOverview({
      component: "server",
      evidence: conflicting,
      fetchImpl: remote.fetch,
      sourceCommit: SOURCE,
      token: TOKEN,
      version: "1.2.3",
    }),
    /conflicts at containers\.server 1\.2\.3/,
  );
});
