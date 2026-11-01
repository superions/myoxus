// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildSchema } from "graphql";
import { generateArtifacts } from "./generate-server-api.mjs";

const fixture = `
  directive @policy(role: String!) on FIELD_DEFINITION
  input Choice @oneOf { id: ID, name: String }
  input Options {
    missing: String
    nothing: String = null
    zero: Int = 0
    disabled: Boolean = false
    empty: String = ""
    order: [Int!] = [2, 1]
  }
  enum State { ACTIVE OLD @deprecated(reason: "Use ACTIVE") }
  interface Node { id: ID! }
  "A record with <markup> | [link](./missing.md)."
  type Item implements Node { id: ID!, state: State! }
  union Result = Item
  type Query {
    "Useful public description."
    items(choice: Choice, options: Options, limit: Int = 0): [Item!]! @policy(role: "reader")
    old: String @deprecated(reason: "")
    "See docs/dev/private.md and P-API-01."
    internalComment: Result
  }
`;

test("export preserves executable schema metadata and ordered defaults", async () => {
  const files = await generateArtifacts(fixture);
  const sdl = files.get("schema.graphql");
  const schema = buildSchema(sdl);
  const fields = schema.getQueryType().getFields();
  assert.equal(String(fields.items.type), "[Item!]!");
  assert.equal(
    fields.items.args.find((arg) => arg.name === "limit").defaultValue,
    0,
  );
  assert.equal(fields.old.deprecationReason, "");
  assert.equal(schema.getType("Choice").isOneOf, true);
  assert.deepEqual(
    schema.getType("Options").getFields().order.defaultValue,
    [2, 1],
  );
  assert.match(sdl, /@policy\(role: "reader"\)/);
  assert.match(files.get("graphql/inputs.md"), /exactly one field/);
  assert.match(files.get("graphql/enums.md"), /Deprecated:.*Use ACTIVE/);
});

test("reference distinguishes absent, null and falsy defaults", async () => {
  const page = (await generateArtifacts(fixture)).get("graphql/inputs.md");
  assert.match(page, /`missing` \| `String` \|  \|/);
  assert.match(page, /`nothing` \| `String` \|  = null \|/);
  assert.match(page, /`zero` \| `Int` \|  = 0 \|/);
  assert.match(page, /`disabled` \| `Boolean` \|  = false \|/);
  assert.match(page, /`empty` \| `String` \|  = "" \|/);
});

test("private commentary is omitted without removing its API field", async () => {
  const files = await generateArtifacts(fixture);
  for (const body of files.values()) {
    assert.doesNotMatch(body, /docs\/dev\/private|P-API-01/);
  }
  const schema = buildSchema(files.get("schema.graphql"));
  assert.ok(schema.getQueryType().getFields().internalComment);
  assert.equal(
    schema.getQueryType().getFields().items.description,
    "Useful public description.",
  );
  assert.match(files.get("graphql/objects.md"), /&lt;markup&gt; &#124;/);
  assert.doesNotMatch(
    files.get("graphql/objects.md"),
    /(?<!\\)\[link\]\(\.\/missing\.md\)/,
  );
});

test("every generated type link resolves to a generated heading", async () => {
  const files = await generateArtifacts(fixture);
  for (const body of files.values()) {
    for (const match of body.matchAll(/\]\(\.\/([a-z]+\.md)#([\w]+)\)/g)) {
      const target = files.get(`graphql/${match[1]}`);
      assert.ok(target, `missing page ${match[1]}`);
      assert.ok(
        [...target.matchAll(/^## (\w+)$/gm)].some(
          (heading) => heading[1].toLowerCase() === match[2],
        ),
        `missing anchor ${match[2]}`,
      );
    }
  }
  assert.match(files.get("graphql/subscriptions.md"), /None defined/);
});

test("generation is deterministic regardless of type or field registration order", async () => {
  const first = await generateArtifacts(
    "type Query { z: String a: Int } type Z { z: ID a: ID }",
  );
  const second = await generateArtifacts(
    "type Z { a: ID z: ID } type Query { a: Int z: String }",
  );
  assert.deepEqual(first, second);
});

test("invalid schemas cannot produce reassuring but unusable documentation", async () => {
  await assert.rejects(
    generateArtifacts("type Query { value: MissingType }"),
    /Unknown type/,
  );
  await assert.rejects(
    generateArtifacts("type Item { id: ID }"),
    /Query root type must be provided/,
  );
});

test("CLI check rejects drift and missing artifacts without rewriting them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "myoxus-api-docs-"));
  try {
    const source = path.join(directory, "source.graphql");
    const output = path.join(directory, "docs");
    await writeFile(source, fixture);
    const run = (...args) =>
      spawnSync(
        process.execPath,
        [
          path.join(import.meta.dirname, "generate-server-api.mjs"),
          "--schema",
          source,
          "--output",
          output,
          ...args,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
    const generated = run();
    assert.equal(generated.status, 0, generated.stderr);
    const clean = run("--check");
    assert.equal(clean.status, 0, clean.stderr);
    const changed = path.join(output, "graphql/queries.md");
    const missing = path.join(output, "graphql/inputs.md");
    await writeFile(changed, "drift\n");
    await rm(missing);
    const rejected = run("--check");
    assert.equal(rejected.status, 1, rejected.stderr);
    assert.match(rejected.stderr, /graphql\/queries\.md/);
    assert.match(rejected.stderr, /graphql\/inputs\.md/);
    assert.equal(await readFile(changed, "utf8"), "drift\n");
    await assert.rejects(readFile(missing), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
