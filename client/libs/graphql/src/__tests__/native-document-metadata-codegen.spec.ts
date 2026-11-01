import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("native document metadata codegen configuration", () => {
  test("native operation source carries metadata freshness fields", () => {
    const operation = readRepoFile(
      "client/libs/graphql/src/graphql/document-metadata.gql",
    );

    expect(operation).toContain("documentMetadata");
    expect(operation).toContain("projectionVersion");
    expect(operation).toContain("metadataRevision");
    expect(operation).toContain("metadataUpdatedAt");
    expect(operation).toContain("setDocumentMetadata");
    expect(operation).not.toContain("pageMeta");
  });

  test("Android Apollo consumes the shared Myoxus GraphQL operations", () => {
    const buildGradle = readRepoFile(
      "client/apps/android/App/service/build.gradle",
    );
    const serviceGitignore = readRepoFile(
      "client/apps/android/App/service/.gitignore",
    );
    const sharedMetadataOperation = resolve(
      repoRoot,
      "client/libs/graphql/src/graphql/document-metadata.gql",
    );

    expect(existsSync(sharedMetadataOperation)).toBe(true);
    expect(buildGradle).toContain('service("myoxus")');
    expect(buildGradle).toContain(
      'srcDir("../../../../libs/graphql/src/graphql")',
    );
    expect(buildGradle).toContain('srcDir("src/main/graphql")');
    expect(buildGradle).toContain("introspection {");
    expect(buildGradle).toContain(
      'schemaFile.set(file("src/main/graphql/com/myoxus/pro/graphql/schema.graphqls"))',
    );
    expect(buildGradle).not.toContain('mapScalar("Date"');
    expect(buildGradle).not.toContain('mapScalar("SafeInt"');
    expect(buildGradle).not.toContain('mapScalar("Decimal"');
    expect(buildGradle).not.toContain("common/graphql");
    expect(buildGradle).not.toContain("backend/server/src/schema.gql");
    expect(serviceGitignore).toContain(
      "/src/main/graphql/com/myoxus/pro/graphql/schema.graphqls",
    );
  });

  test("iOS Apollo consumes an explicit allowlist of shared operations", () => {
    const config = JSON.parse(
      readRepoFile("client/apps/ios/apollo-codegen-config.json"),
    ) as {
      input?: { operationSearchPaths?: string[]; schemaSearchPaths?: string[] };
    };
    const chore = readRepoFile("client/apps/ios/apollo-codegen-chore.sh");
    const codegen = readRepoFile("client/apps/ios/codegen.ts");
    const operationSearchPaths = config.input?.operationSearchPaths ?? [];

    expect(operationSearchPaths).toContain(
      "../../libs/graphql/src/graphql/get-user-preferences.gql",
    );
    expect(operationSearchPaths.length).toBeGreaterThan(0);
    expect(operationSearchPaths.every((path) => !path.includes("*"))).toBe(
      true,
    );
    expect(
      operationSearchPaths.every((path) =>
        existsSync(resolve(repoRoot, "client/apps/ios", path)),
      ),
    ).toBe(true);
    expect(config.input?.schemaSearchPaths).toContain(
      "./App/Packages/AffineGraphQL/.generated-schema.graphqls",
    );
    expect(chore).toContain("getIntrospectionQuery()");
    expect(chore).toContain("printSchema(buildClientSchema(payload.data))");
    expect(chore).toContain("APOLLO_IOS_CLI_BIN");
    expect(chore).toContain("$(uname -s)");
    expect(chore).not.toContain(
      "throw new Error('Apollo package version marker not found')",
    );
    expect(codegen).toContain("spawnSync");
    expect(codegen).not.toContain("execSync");
  });
});
