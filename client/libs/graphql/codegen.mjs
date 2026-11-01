// SPDX-License-Identifier: AGPL-3.0-or-later

import { codegen } from "@graphql-codegen/core";
import * as typescriptOperationsPlugin from "@graphql-codegen/typescript-operations";
import * as typescriptPlugin from "@graphql-codegen/typescript";
import {
  buildASTSchema,
  lexicographicSortSchema,
  parse,
  Source,
} from "graphql";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { parse as parseYaml } from "yaml";

import * as exportGqlPlugin from "./export-gql-plugin.cjs";
import loadRuntimeSchema from "./schema-loader.cjs";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(packageRoot, "codegen.yml");

function asRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

async function collectGraphqlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectGraphqlFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".gql")) {
      files.push(path);
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function loadDocuments(pattern) {
  if (pattern !== "./src/**/*.gql") {
    throw new Error(`Unsupported GraphQL document pattern: ${pattern}`);
  }

  const paths = await collectGraphqlFiles(resolve(packageRoot, "src"));
  if (!paths.length) {
    throw new Error(`No GraphQL documents matched ${pattern}`);
  }
  return Promise.all(
    paths.map(async (path) => {
      const rawSDL = await readFile(path, "utf8");
      const location = `./${relative(packageRoot, path).split(sep).join("/")}`;
      return {
        location,
        rawSDL,
        document: parse(new Source(rawSDL, location)),
      };
    }),
  );
}

function resolveSchema(config) {
  if (!Array.isArray(config.schema) || config.schema.length !== 1) {
    throw new Error("codegen.yml must declare exactly one schema source");
  }
  const entry = asRecord(config.schema[0], "GraphQL schema source");
  const sources = Object.entries(entry);
  if (sources.length !== 1) {
    throw new Error("GraphQL schema source must contain exactly one URL");
  }
  const [pointer, options] = sources[0];
  const loader = asRecord(options, "GraphQL schema options").loader;
  if (loader !== "./schema-loader.cjs") {
    throw new Error(`Unsupported GraphQL schema loader: ${String(loader)}`);
  }
  return pointer;
}

function resolvePlugins(entries, generatedPaths) {
  if (!Array.isArray(entries)) {
    throw new Error("Each generated output must declare plugins");
  }

  const plugins = [];
  const pluginMap = {};
  for (const entry of entries) {
    let name;
    let pluginConfig = {};
    if (typeof entry === "string") {
      name = entry;
    } else {
      const configuredPlugins = Object.entries(
        asRecord(entry, "GraphQL plugin"),
      );
      if (configuredPlugins.length !== 1) {
        throw new Error("Each GraphQL plugin entry must have exactly one name");
      }
      [name, pluginConfig] = configuredPlugins[0];
    }
    const implementation = {
      typescript: typescriptPlugin,
      "typescript-operations": typescriptOperationsPlugin,
      "./export-gql-plugin.cjs": exportGqlPlugin,
    }[name];
    if (!implementation) {
      throw new Error(`Unsupported GraphQL codegen plugin: ${String(name)}`);
    }
    if (name === "./export-gql-plugin.cjs") {
      const sideOutput = asRecord(
        pluginConfig,
        "GraphQL export plugin config",
      ).output;
      if (typeof sideOutput !== "string" || !sideOutput) {
        throw new Error("GraphQL export plugin must declare its side output");
      }
      generatedPaths.add(sideOutput);
    }
    pluginMap[name] = implementation;
    plugins.push({ [name]: pluginConfig ?? {} });
  }
  return { pluginMap, plugins };
}

async function formatGeneratedFiles(generatedPaths) {
  for (const generatedPath of [...generatedPaths].sort()) {
    const path = resolve(packageRoot, generatedPath);
    const source = await readFile(path, "utf8");
    await writeFile(path, await format(source, { filepath: path }));
  }
}

async function generate() {
  const config = asRecord(
    parseYaml(await readFile(configPath, "utf8")),
    "GraphQL codegen configuration",
  );
  const schemaDocument = await loadRuntimeSchema(resolveSchema(config));
  // Sorting the schema here preserves the stable generated contract previously
  // provided by the CLI without retaining its universal loader stack.
  const schema = lexicographicSortSchema(buildASTSchema(schemaDocument));
  const documents = await loadDocuments(config.documents);
  const outputs = asRecord(config.generates, "GraphQL generated outputs");
  const generatedPaths = new Set(Object.keys(outputs));

  for (const [outputPath, outputConfigValue] of Object.entries(outputs)) {
    const outputConfig = asRecord(
      outputConfigValue,
      `GraphQL output ${outputPath}`,
    );
    const { pluginMap, plugins } = resolvePlugins(
      outputConfig.plugins,
      generatedPaths,
    );
    const localConfig =
      outputConfig.config === undefined
        ? {}
        : asRecord(outputConfig.config, `GraphQL output ${outputPath} config`);
    const content = await codegen({
      config: {
        ...asRecord(config.config, "GraphQL shared config"),
        ...localConfig,
      },
      documents,
      filename: resolve(packageRoot, outputPath),
      pluginMap,
      plugins,
      schema,
    });
    await writeFile(resolve(packageRoot, outputPath), content);
  }

  // The custom export plugin writes its configured side output while generating
  // operations; format all three contracts only after every plugin succeeded.
  await formatGeneratedFiles(generatedPaths);
  return [...generatedPaths].sort();
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length && !check) {
    throw new Error(`Unknown codegen arguments: ${args.join(" ")}`);
  }

  process.chdir(packageRoot);
  const generatedPaths = await generate();
  if (check) {
    execFileSync("git", ["diff", "--exit-code", "--", ...generatedPaths], {
      cwd: packageRoot,
      stdio: "inherit",
    });
  }
}

await main();
