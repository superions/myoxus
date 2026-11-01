#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  assertValidSchema,
  buildASTSchema,
  Kind,
  parse,
  print,
  visit,
} from "graphql";
import { format } from "prettier";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const outputRoot = path.join(repoRoot, "docs/api/server");
const groups = {
  queries: "Query root",
  mutations: "Mutation root",
  subscriptions: "Subscription root",
  objects: "Objects",
  inputs: "Input objects",
  enums: "Enums",
  unions: "Unions",
  interfaces: "Interfaces",
  scalars: "Scalars",
  directives: "Directives",
};
const kindGroups = {
  [Kind.OBJECT_TYPE_DEFINITION]: "objects",
  [Kind.INPUT_OBJECT_TYPE_DEFINITION]: "inputs",
  [Kind.ENUM_TYPE_DEFINITION]: "enums",
  [Kind.UNION_TYPE_DEFINITION]: "unions",
  [Kind.INTERFACE_TYPE_DEFINITION]: "interfaces",
  [Kind.SCALAR_TYPE_DEFINITION]: "scalars",
  [Kind.DIRECTIVE_DEFINITION]: "directives",
};

// Descriptions are optional commentary, not the executable contract. Do not
// publish private-document references or internal work-item narratives.
const internalCommentary =
  /(?:\b(?:docs\/dev|todo|learnings)\/|\b(?:AGENTS|[\w-]+-done)\.md\b|\bP(?:\d|-[A-Z])[\w/{},-]*\b)/;

function plain(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replace(/[\\`*_[\]]/g, "\\$&")
    .replace(/\s+/g, " ")
    .trim();
}

function table(headers, rows) {
  return [
    "<!-- prettier-ignore -->",
    "",
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
  ].join("\n");
}

function details(node) {
  const deprecated = node.directives?.find(
    (directive) => directive.name.value === "deprecated",
  );
  const reason = deprecated?.arguments?.find(
    (argument) => argument.name.value === "reason",
  )?.value.value;
  return [
    plain(node.description?.value),
    deprecated
      ? `**Deprecated:** ${plain(reason ?? "No longer supported")}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function generateArtifacts(source) {
  const byName = (a, b) => {
    const left = a.name?.value ?? a.kind;
    const right = b.name?.value ?? b.kind;
    return left < right ? -1 : left > right ? 1 : 0;
  };
  const ast = visit(parse(source), {
    StringValue(node, key) {
      if (key === "description" && internalCommentary.test(node.value)) {
        return null;
      }
    },
    leave(node) {
      const sorted = { ...node };
      for (const key of [
        "definitions",
        "fields",
        "arguments",
        "values",
        "types",
        "interfaces",
      ]) {
        if (Array.isArray(node[key]) && node.kind !== Kind.LIST) {
          sorted[key] = [...node[key]].sort(byName);
        }
      }
      return sorted;
    },
  });
  const schema = buildASTSchema(ast);
  assertValidSchema(schema);
  // Print the AST, not printSchema(schema): custom directive applications must
  // survive alongside OneOf, descriptions, defaults and deprecation reasons.
  const sdl = await format(print(ast) + "\n", { parser: "graphql" });
  const definitions = ast.definitions.filter(
    (definition) => kindGroups[definition.kind],
  );
  const roots = new Map(
    [
      [schema.getQueryType()?.name, "queries"],
      [schema.getMutationType()?.name, "mutations"],
      [schema.getSubscriptionType()?.name, "subscriptions"],
    ].filter(([name]) => name),
  );
  const groupOf = (definition) =>
    roots.get(definition.name.value) ?? kindGroups[definition.kind];
  const destination = (definition) =>
    `./${groupOf(definition)}.md#${definition.name.value.toLowerCase()}`;
  const destinations = new Map(
    definitions
      .filter((definition) => definition.kind !== Kind.DIRECTIVE_DEFINITION)
      .map((definition) => [definition.name.value, destination(definition)]),
  );
  const link = (name) =>
    destinations.has(name)
      ? `[${name}](${destinations.get(name)})`
      : `\`${name}\``;
  const type = (node) => {
    if (node.kind === Kind.NON_NULL_TYPE) return `${type(node.type)}!`;
    if (node.kind === Kind.LIST_TYPE) return `\\[${type(node.type)}\\]`;
    return link(node.name.value);
  };
  const defaultValue = (node) =>
    node.defaultValue === undefined
      ? ""
      : ` = ${plain(print(node.defaultValue))}`;
  const argumentsText = (args = []) =>
    args
      .map(
        (arg) =>
          `\`${arg.name.value}\`: ${type(arg.type)}${defaultValue(arg)}${details(arg) ? ` — ${details(arg)}` : ""}`,
      )
      .join("<br>");

  const files = new Map([["schema.graphql", sdl]]);
  const pages = [];
  for (const [group, title] of Object.entries(groups)) {
    const members = definitions.filter(
      (definition) => groupOf(definition) === group,
    );
    pages.push([`[${title}](./${group}.md)`, String(members.length)]);
    const sections = [
      `# ${title}`,
      "[Documentation](../../../README.md) / [API](../../README.md) / [Server API](../README.md) / [Schema reference](./README.md)",
      "This page lists the compiled schema definitions for this section. Use the type links to follow related fields and inputs.",
      "<!-- Generated by build/scripts/docs/generate-server-api.sh. -->",
    ];
    if (members.length === 0) sections.push("None defined in this schema.");
    for (const definition of members) {
      sections.push(`## ${definition.name.value}`);
      if (definition.description)
        sections.push(plain(definition.description.value));
      if (
        definition.directives?.some(
          (directive) => directive.name.value === "oneOf",
        )
      ) {
        sections.push(
          "**OneOf input:** supply exactly one field with a non-null value.",
        );
      }
      if (definition.interfaces?.length) {
        sections.push(
          `Implements: ${definition.interfaces.map((item) => link(item.name.value)).join(", ")}.`,
        );
      }
      if (definition.fields?.length) {
        const input = definition.kind === Kind.INPUT_OBJECT_TYPE_DEFINITION;
        sections.push(
          table(
            input
              ? ["Field", "Type", "Default", "Description"]
              : ["Field and return type", "Arguments and description"],
            definition.fields.map((field) =>
              input
                ? [
                    `\`${field.name.value}\``,
                    type(field.type),
                    defaultValue(field),
                    details(field),
                  ]
                : [
                    `\`${field.name.value}\`<br>${type(field.type)}`,
                    [argumentsText(field.arguments), details(field)]
                      .filter(Boolean)
                      .join("<br><br>"),
                  ],
            ),
          ),
        );
      }
      if (definition.values) {
        sections.push(
          table(
            ["Value", "Description"],
            definition.values.map((value) => [
              `\`${value.name.value}\``,
              details(value),
            ]),
          ),
        );
      }
      if (definition.types) {
        sections.push(
          `Possible types: ${definition.types.map((item) => link(item.name.value)).join(", ")}.`,
        );
      }
      if (definition.kind === Kind.DIRECTIVE_DEFINITION) {
        sections.push(
          `Locations: ${definition.locations.map((item) => `\`${item.value}\``).join(", ")}.`,
        );
        if (definition.repeatable)
          sections.push("This directive is repeatable.");
        if (definition.arguments?.length)
          sections.push(argumentsText(definition.arguments));
      }
    }
    files.set(
      `graphql/${group}.md`,
      await format(sections.join("\n\n") + "\n", { parser: "markdown" }),
    );
  }
  const index = [
    "# GraphQL schema reference",
    "[Documentation](../../../README.md) / [API](../../README.md) / [Server API](../README.md)",
    "<!-- Generated by build/scripts/docs/generate-server-api.sh. -->",
    "[Machine-readable SDL](../schema.graphql)",
    "This reference describes the compiled server schema. A trailing `!` means non-null; brackets denote a list. An omitted default differs from an explicit `null` default. Authorization and runtime validation remain server-enforced and cannot be inferred from type signatures alone.",
    "## Sections",
    table(["Reference", "Types / directives"], pages),
    "## Type index",
    table(
      ["Name", "Kind"],
      definitions.map((definition) => [
        `[${definition.name.value}](${destination(definition)})`,
        groups[groupOf(definition)],
      ]),
    ),
  ].join("\n\n");
  files.set(
    "graphql/README.md",
    await format(index + "\n", { parser: "markdown" }),
  );
  return files;
}

async function main() {
  const { values } = parseArgs({
    options: {
      schema: { type: "string" },
      output: { type: "string", default: outputRoot },
      check: { type: "boolean", default: false },
    },
  });
  if (!values.schema)
    throw new Error(
      "Usage: node build/scripts/docs/generate-server-api.mjs --schema <SDL file> [--output <directory>] [--check]",
    );
  const files = await generateArtifacts(await readFile(values.schema, "utf8"));
  const drift = [];
  for (const [name, content] of files) {
    const destination = path.join(values.output, name);
    if (values.check) {
      let existing;
      try {
        existing = await readFile(destination, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (existing !== content) drift.push(name);
    } else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, content);
    }
  }
  if (drift.length) {
    throw new Error(
      `Generated API documentation differs: ${drift.join(", ")}. Run build/scripts/docs/generate-server-api.sh and commit the results.`,
    );
  }
  console.log(
    `${values.check ? "Verified" : "Generated"} ${files.size} server API documentation artifacts.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  await main();
}
