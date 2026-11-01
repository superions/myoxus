/**
 * Codegen Reproducibility — documentation test (P95-FE-28).
 *
 * The actual verification requires a running server and is performed by:
 *   build/scripts/test/verify-codegen.sh
 *
 * This test documents the requirement:
 * - Running `yarn codegen` (in client/libs/graphql/) must produce identical
 *   `src/graphql/index.ts`, `src/schema.ts` and `src/operations.ts` to the
 *   committed versions.
 * - Any drift indicates either:
 *   (a) manual edits to generated files (not allowed), or
 *   (b) a schema change on the server that hasn't been committed.
 *
 * Invariant: committed generated files == output of yarn codegen against current server.
 */
import {
  buildASTSchema,
  buildSchema,
  introspectionFromSchema,
  parse,
  print,
} from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

import * as exportGqlPlugin from "../../export-gql-plugin.cjs";

const loadRuntimeSchema = createRequire(import.meta.url)(
  "../../schema-loader.cjs",
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

import {
  adminDocumentMetadataFieldDefinitionsQuery,
  documentMetadataAudienceFieldsFragment,
  documentMetadataFieldsFragment,
  documentMetadataFieldValueFieldsFragment,
  documentMetadataQuery,
  documentMetadataValidationFieldsFragment,
  documentMetadataValidationQuery,
  setDocumentMetadataMutation,
} from "../graphql";

describe("codegen reproducibility (P95-FE-28)", () => {
  it("normalizes native exports and live introspection to identical descriptions and OneOf contracts", async () => {
    const root = mkdtempSync(join(tmpdir(), "myoxus-gql-transports-"));
    const file = join(root, "schema.graphql");
    const sdl = `
      directive @deprecated(reason: String = "No longer supported") on FIELD_DEFINITION | ARGUMENT_DEFINITION | INPUT_FIELD_DEFINITION | ENUM_VALUE
      directive @oneOf on INPUT_OBJECT
      """A native point date.""" scalar LocalDate
      """One selector.""" input Selection @oneOf { id: ID name: String }
      """A native query.""" type Query {
        date(input: Selection): LocalDate
        text: String identifier: ID enabled: Boolean count: Int ratio: Float
      }
    `;
    writeFileSync(file, sdl);
    const network = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: introspectionFromSchema(buildSchema(sdl), { oneOf: true }),
      }),
    });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("MYOXUS_GRAPHQL_SCHEMA_FILE", file);
    try {
      const fromFile = await loadRuntimeSchema(
        "https://unused.example/graphql",
      );
      expect(network).not.toHaveBeenCalled();
      vi.stubEnv("MYOXUS_GRAPHQL_SCHEMA_FILE", undefined);
      const fromLive = await loadRuntimeSchema(
        "https://unused.example/graphql",
      );
      expect(print(fromFile)).toBe(print(fromLive));
      expect(network).toHaveBeenCalledTimes(1);
      expect(print(fromFile)).not.toContain("directive @deprecated");
      expect(
        buildASTSchema(fromFile).getDirective("deprecated")?.description,
      ).toBe(buildASTSchema(fromLive).getDirective("deprecated")?.description);
      expect(buildASTSchema(fromFile).getType("String")?.description).toContain(
        "The `String` scalar type",
      );
      expect(print(fromFile)).toContain("@oneOf");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing, malformed and semantically invalid explicit SDL instead of using HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "myoxus-gql-invalid-"));
    const file = join(root, "schema.graphql");
    const network = vi.fn(() => {
      throw new Error("unexpected network access");
    });
    vi.stubGlobal("fetch", network);
    vi.stubEnv("MYOXUS_GRAPHQL_SCHEMA_FILE", file);
    try {
      await expect(
        loadRuntimeSchema("https://unused.example/graphql"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      writeFileSync(file, "type Query {");
      await expect(
        loadRuntimeSchema("https://unused.example/graphql"),
      ).rejects.toThrow(/Syntax Error/);
      writeFileSync(file, "type Query { value: MissingNativeType }");
      await expect(
        loadRuntimeSchema("https://unused.example/graphql"),
      ).rejects.toThrow(/Unknown type/);
      vi.stubEnv("MYOXUS_GRAPHQL_SCHEMA_FILE", "");
      await expect(
        loadRuntimeSchema("https://unused.example/graphql"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(network).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("retains exported operation and fragment names for ASCII GraphQL identifiers", () => {
    // Use the same CJS GraphQL instance as the codegen plugin; Vitest's ESM
    // instance constructs schema objects from a different module realm.
    const { buildSchema, parse } = createRequire(import.meta.url)("graphql");
    const root = mkdtempSync(join(tmpdir(), "myoxus-gql-names-"));
    const output = join(root, "operations.ts");
    const schema = buildSchema(
      "type Query { value: String! } type Mutation { value: String! }",
    );
    const rawSDL =
      "query URLValue { ...ValueFields } query existingQuery { value } query _private { value } mutation SaveValue { value } fragment ValueFields on Query { value }";
    try {
      const unions = exportGqlPlugin.plugin(
        schema,
        [{ location: "names.gql", rawSDL, document: parse(rawSDL) }],
        { output },
      );
      const generated = readFileSync(output, "utf8");
      for (const name of [
        "uRLValueQuery",
        "existingQuery",
        "_privateQuery",
        "saveValueMutation",
        "valueFieldsFragment",
      ])
        expect(generated).toContain(`export const ${name} =`);
      for (const name of [
        "URLValueQuery",
        "ExistingQuery",
        "_privateQuery",
        "SaveValueMutation",
      ])
        expect(unions).toContain(`${name}Variables`);
      expect(generated).not.toContain("existingQueryQuery");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("rejects a parsed document whose source text was not loaded", () => {
    const schema = buildSchema("type Query { value: String! }");
    const document = parse("query value { value }");

    expect(() =>
      exportGqlPlugin.plugin(schema, [{ location: "./value.gql", document }], {
        output: "unused.ts",
      }),
    ).toThrow("./value.gql is missing its parsed AST or rawSDL");
  });

  it("exports committed GraphQL operation descriptors instead of undefined placeholders", () => {
    for (const operation of [
      adminDocumentMetadataFieldDefinitionsQuery,
      documentMetadataQuery,
      documentMetadataValidationQuery,
      setDocumentMetadataMutation,
    ]) {
      expect(operation.id).toBeTruthy();
      expect(operation.op).toBeTruthy();
      expect(operation.query).toContain(operation.op);
      expect(operation.query).not.toContain("undefined");
    }
  });

  it("exports executable operation strings with referenced fragment definitions", () => {
    expect(adminDocumentMetadataFieldDefinitionsQuery.query).toContain(
      "...DocumentMetadataFieldDefinitionFields",
    );
    expect(adminDocumentMetadataFieldDefinitionsQuery.query).toContain(
      "fragment DocumentMetadataFieldDefinitionFields",
    );

    expect(adminDocumentMetadataFieldDefinitionsQuery.query).not.toContain(
      "undefined",
    );
  });

  it("exports native document metadata operations with transitive fragments", () => {
    expect(documentMetadataQuery.id).toBe("documentMetadataQuery");
    expect(documentMetadataQuery.op).toBe("documentMetadata");
    expect(documentMetadataQuery.query).toContain(
      "query documentMetadata($workspaceId: ID!, $docId: ID!, $requestedProjectionMode: DocumentMetadataProjectionModeType)",
    );
    expect(documentMetadataQuery.query).toContain(
      "fragment DocumentMetadataFields",
    );
    expect(documentMetadataQuery.query).toContain(
      "fragment DocumentMetadataFieldValueFields",
    );
    expect(documentMetadataQuery.query).toContain(
      "fragment DocumentMetadataAudienceFields",
    );
    expect(documentMetadataQuery.query).toContain(
      "fragment DocumentMetadataReferenceValueFields",
    );
    expect(documentMetadataFieldsFragment).toContain("projectionVersion");
    expect(documentMetadataFieldsFragment).toContain("metadataRevision");
    expect(documentMetadataFieldsFragment).toContain("metadataUpdatedAt");

    expect(setDocumentMetadataMutation.id).toBe("setDocumentMetadataMutation");
    expect(setDocumentMetadataMutation.op).toBe("setDocumentMetadata");
    expect(setDocumentMetadataMutation.query).toContain(
      "mutation setDocumentMetadata($workspaceId: ID!, $docId: ID!, $input: SetDocumentMetadataInput!)",
    );
    expect(setDocumentMetadataMutation.query).toContain(
      "fragment DocumentMetadataFields",
    );

    expect(documentMetadataValidationQuery.id).toBe(
      "documentMetadataValidationQuery",
    );
    expect(documentMetadataValidationQuery.op).toBe(
      "documentMetadataValidation",
    );
    expect(documentMetadataValidationQuery.query).toContain(
      "query documentMetadataValidation($workspaceId: ID!, $docId: ID!, $action: DocumentMetadataValidationActionType)",
    );
    expect(documentMetadataValidationQuery.query).toContain(
      "fragment DocumentMetadataValidationFields",
    );
    expect(documentMetadataValidationFieldsFragment).toContain(
      "blockedActions",
    );

    for (const fragment of [
      documentMetadataFieldsFragment,
      documentMetadataFieldValueFieldsFragment,
      documentMetadataAudienceFieldsFragment,
    ]) {
      expect(fragment).toContain("fragment DocumentMetadata");
      expect(fragment).not.toContain("undefined");
    }
  });
});
