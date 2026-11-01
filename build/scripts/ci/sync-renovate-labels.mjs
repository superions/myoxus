#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

const endpoint = "https://git.blume29.de/api/v1/repos/myoxus/myoxus";
const token = process.env.RENOVATE_TOKEN || process.env.MYOXUS_FORGEJO_TOKEN;
if (!token)
  throw new Error(
    "Renovate label synchronization requires an issue-write token",
  );
const definitions = [
  {
    name: "dependencies",
    color: "0366d6",
    description: "Dependency maintenance",
  },
  {
    name: "security",
    color: "b60205",
    description: "Update addressing a published security advisory",
  },
  {
    name: "major-update",
    color: "d93f0b",
    description: "Major dependency migration requiring review",
  },
  {
    name: "editor-review",
    color: "5319e7",
    description: "Active editor dependency requiring consumer review",
  },
];

async function api(path, method = "GET", body) {
  const response = await fetch(endpoint + path, {
    method,
    headers: {
      Authorization: `token ${token}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Forgejo ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function pages(path) {
  const result = [];
  for (let page = 1; ; page++) {
    const entries = await api(
      `${path}${path.includes("?") ? "&" : "?"}limit=50&page=${page}`,
    );
    if (!Array.isArray(entries))
      throw new Error("Invalid Forgejo list response");
    result.push(...entries);
    if (entries.length < 50) return result;
  }
}

const labels = new Map(
  (await pages("/labels")).map((label) => [label.name, label.id]),
);
for (const definition of definitions) {
  if (!labels.has(definition.name)) {
    const label = await api("/labels", "POST", definition);
    labels.set(label.name, label.id);
    console.log(`Created label ${label.name}`);
  }
}

for (const pull of await pages("/pulls?state=open")) {
  if (
    pull.user?.login !== "myoxus-renovate" ||
    !pull.head?.ref?.startsWith("renovate/")
  )
    continue;
  const wanted = new Set(["dependencies"]);
  // Renovate retains its requested labels in this metadata even if Forgejo
  // could not apply them because the repository labels did not yet exist.
  const encoded = pull.body?.match(
    /<!--renovate-debug:([A-Za-z0-9+/=]+)-->/,
  )?.[1];
  if (encoded) {
    const debug = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    for (const name of debug.labels ?? [])
      if (labels.has(name)) wanted.add(name);
  }
  if (pull.title.toLowerCase().includes("[security]")) wanted.add("security");
  const present = new Set((pull.labels ?? []).map((label) => label.id));
  const missing = [...wanted]
    .map((name) => labels.get(name))
    .filter((id) => !present.has(id));
  if (missing.length) {
    // POST adds labels and preserves unrelated labels maintained by reviewers.
    await api(`/issues/${pull.number}/labels`, "POST", { labels: missing });
    console.log(
      `Labeled Renovate PR #${pull.number}: ${[...wanted].join(", ")}`,
    );
  }
}
console.log("Renovate repository and PR labels are synchronized.");
