import { readFileSync, writeFileSync } from "node:fs";

import type { Path } from "@myoxus-tools/utils/path";
import {
  type Package,
  Workspace,
  yarnList,
} from "@myoxus-tools/utils/workspace";
import { applyEdits, modify } from "jsonc-parser";
import { type BuiltInParserName, format, resolveConfig } from "prettier";

import { Command } from "./command";

export class InitCommand extends Command {
  static override paths = [["init"], ["i"], ["codegen"]];
  private readonly defaultPrettierOptions = {
    quoteProps: "preserve" as const,
    trailingComma: "none" as const,
  };
  private prettierConfig:
    Awaited<ReturnType<typeof resolveConfig>> | null | undefined;

  async execute() {
    this.logger.info("Generating Workspace configs");
    await this.generateWorkspaceFiles();
    this.logger.info("Workspace configs generated");
  }

  async generateWorkspaceFiles() {
    this.workspace = new Workspace(yarnList());
    const filesToGenerate: [
      Path,
      (prev: string) => string,
      BuiltInParserName?,
    ][] = [
      [this.workspace.join("tsconfig.json"), this.genProjectTsConfig, "json"],
      [
        this.workspace
          .getPackage("@myoxus-tools/utils")
          .join("src/workspace.gen.ts"),
        this.genWorkspaceInfo,
        "typescript",
      ],
      [this.workspace.join(".oxlintrc.json"), this.genOxlintConfig, "json"],
      ...this.workspace.packages
        .filter((p) => p.isTsProject)
        .map(
          (p) =>
            [
              p.join("tsconfig.json"),
              this.genPackageTsConfig.bind(this, p),
              "json",
            ] as any,
        ),
    ];

    for (const [path, content, formatter] of filesToGenerate) {
      this.logger.info(`Generating: ${path}`);
      const previous = readFileSync(path.value, "utf-8");
      let file = content(previous);
      if (formatter) {
        file = await this.format(file, formatter);
      }
      writeFileSync(path.value, file);
    }
  }

  async format(content: string, parser: BuiltInParserName) {
    const config = await this.getPrettierConfig();
    return format(content, {
      ...this.defaultPrettierOptions,
      ...config,
      parser,
    });
  }

  private async getPrettierConfig() {
    if (this.prettierConfig !== undefined) {
      return this.prettierConfig ?? {};
    }

    try {
      this.prettierConfig = await resolveConfig(
        this.workspace.join("package.json").value,
      );
    } catch {
      this.prettierConfig = null;
    }

    return this.prettierConfig ?? {};
  }

  genOxlintConfig = () => {
    const json = JSON.parse(
      readFileSync(this.workspace.join(".oxlintrc.json").value, "utf-8"),
    );

    const ignoreList = readFileSync(
      this.workspace.join(".prettierignore").value,
      "utf-8",
    )
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith("#"));

    json["ignorePatterns"] = ignoreList;

    return JSON.stringify(json, null, 2);
  };

  genWorkspaceInfo = () => {
    const list = yarnList();

    const names = list.map((p) => p.name);

    const content = [
      "// Auto generated content",
      "// DO NOT MODIFY THIS FILE MANUALLY",
      `export const PackageList = ${JSON.stringify(list, null, 2)}`,
      "",
      `export type PackageName = ${names.map((n) => `'${n}'`).join(" | ")}`,
    ];

    return content.join("\n");
  };

  genProjectTsConfig = (prev: string) => {
    return applyEdits(
      prev,
      modify(
        prev,
        ["references"],
        this.workspace.packages
          .filter((p) => p.isTsProject)
          .map((p) => ({ path: p.path.relativePath })),
        {},
      ),
    );
  };

  genPackageTsConfig = (pkg: Package, prev: string) => {
    return applyEdits(
      prev,
      modify(
        prev,
        ["references"],
        pkg.deps
          .filter((p) => p.isTsProject)
          .map((d) => ({ path: pkg.path.relative(d.path.value) })),
        {},
      ),
    );
  };
}
