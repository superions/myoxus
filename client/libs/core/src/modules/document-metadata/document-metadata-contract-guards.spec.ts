import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import {
  documentVersioningOverviewQuery,
  pdfExportDialogBootstrapQuery,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();
const sourceExtensions = new Set([".ts", ".tsx"]);
const runtimeDirs = [
  "client/libs/core/src/modules/document-metadata",
  "client/libs/core/src/modules/pdf-export",
  "client/libs/core/src/modules/doc-versioning",
  "client/admin/workspaces/admin/src/modules/documents",
];

function collectSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return entry === "__tests__" ? [] : collectSourceFiles(path);
    }
    const extension = path.slice(path.lastIndexOf("."));
    if (!sourceExtensions.has(extension)) return [];
    if (/\.spec\.tsx?$/.test(path)) return [];
    return [path];
  });
}

function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function allRuntimeSources(): string[] {
  return runtimeDirs.flatMap((dir) => collectSourceFiles(join(repoRoot, dir)));
}

describe("document metadata contract guards", () => {
  test("does not hardcode server preset status/type/classification keys in Web/Admin runtime", () => {
    const businessPresetLiteral =
      /["'`](?:in_progress|current|outdated|archived|draft|in_review|approved|released|active|obsolete|public|internal|confidential|restricted|documentation|concept|guideline|standard|policy|report)["'`]/g;

    const violations = allRuntimeSources().flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const relativePath = relative(repoRoot, file);
      return [...source.matchAll(businessPresetLiteral)]
        .filter(
          (match) =>
            // PDF compliance profiles are not document metadata presets.
            !(
              relativePath ===
                "client/libs/core/src/modules/pdf-export/capability-form.tsx" &&
              match[0] === '"standard"'
            ) &&
            // OKF's fixed format vocabulary is independent of configurable
            // workflow keys. Keep the exception on mapping fields/options so
            // a hardcoded workflow key in this same file still fails.
            !(
              relativePath ===
                "client/admin/workspaces/admin/src/modules/documents/components/status-schemas-tab.tsx" &&
              match[0] === '"draft"' &&
              (/\bokfStatus:\s*$/.test(source.slice(0, match.index)) ||
                (/\{ value:\s*$/.test(source.slice(0, match.index)) &&
                  /^, label: i18n\.t\("admin\.templates\.badge\.draft"\) \}/.test(
                    source.slice(match.index + match[0].length),
                  )))
            ),
        )
        .map((match) => `${relativePath}: ${match[0]}`);
    });

    expect(violations).toEqual([]);
  });

  test("keeps PDF export on native document metadata and explicit version selection", () => {
    const pdfBootstrapQuery = pdfExportDialogBootstrapQuery.query;
    const exportDialog = read(
      "client/libs/core/src/modules/pdf-export/export-dialog.tsx",
    );
    const runServerExport = read(
      "client/libs/core/src/modules/pdf-export/run-server-export.ts",
    );

    expect(pdfBootstrapQuery).toContain(
      "documentMetadata(workspaceId: $workspaceId, docId: $docId)",
    );
    expect(pdfBootstrapQuery).toContain("...DocumentMetadataFields");
    expect(pdfBootstrapQuery).not.toContain(
      "documentAttributes(docId: $docId)",
    );
    expect(pdfBootstrapQuery).toMatch(
      /documentMetadataValidation\(\s*workspaceId: \$workspaceId\s*docId: \$docId\s*action: export_pdf\s*\)/,
    );
    expect(exportDialog).toContain(
      "documentMetadataValidation.blockedActions.includes(",
    );
    expect(exportDialog).toContain('"export_pdf"');
    expect(runServerExport).toMatch(
      /if\s*\(\s*options\.documentVersionId\s*!==\s*undefined\s*\)\s*{\s*input\.documentVersionId\s*=\s*options\.documentVersionId;/s,
    );
    expect(runServerExport).toContain(
      "variables: { input: buildPdfExportInput(workspaceId, docId, options) }",
    );
  });

  test("keeps PDF export bootstrap GraphQL fragments executable", () => {
    const fragmentDefinitions = [
      ...pdfExportDialogBootstrapQuery.query.matchAll(
        /\bfragment\s+([A-Za-z0-9_]+)\s+on\b/g,
      ),
    ].map((match) => match[1]);

    expect(fragmentDefinitions).toEqual([...new Set(fragmentDefinitions)]);
  });

  test("keeps document versioning overview on native document metadata", () => {
    const versioningTypes = documentVersioningOverviewQuery.query;

    expect(versioningTypes).toContain(
      "documentMetadata(workspaceId: $workspaceId, docId: $docId)",
    );
    expect(versioningTypes).toContain(
      "documentMetadataValidation(workspaceId: $workspaceId, docId: $docId)",
    );
    expect(versioningTypes).toContain("...DocumentMetadataFields");
    expect(versioningTypes).not.toContain("documentAttributes(docId: $docId)");
  });

  test("does not publish retired documentAttributes read/write operations as shared Myoxus client operations", () => {
    const metadataPolicyGraphql = read(
      "client/libs/graphql/src/graphql/document-metadata-policy.gql",
    );
    const generatedSchema = read("client/libs/graphql/src/schema.ts");
    const generatedOperations = read(
      "client/libs/graphql/src/graphql/index.ts",
    );
    const retiredGeneratedNames = [
      "documentAttributesQuery",
      "setDocumentAttributesMutation",
      "DocumentAttributesType",
      "DocumentMetadataStateType",
      "SetDocumentAttributesInput",
      "SetDocumentAttributesPayload",
    ];

    expect(metadataPolicyGraphql).not.toContain("query documentAttributes(");
    expect(metadataPolicyGraphql).not.toContain(
      "query documentMetadataValidation(",
    );
    expect(metadataPolicyGraphql).not.toContain(
      "mutation setDocumentAttributes(",
    );
    expect(metadataPolicyGraphql).toContain("query documentMetadataIndex(");
    expect(metadataPolicyGraphql).toContain(
      "mutation transitionDocumentStatus(",
    );
    for (const retiredName of retiredGeneratedNames) {
      expect(generatedSchema, retiredName).not.toContain(retiredName);
      expect(generatedOperations, retiredName).not.toContain(retiredName);
    }
    expect(generatedOperations).toContain("documentMetadataQuery");
    expect(generatedOperations).toContain("setDocumentMetadataMutation");
  });

  test("CUTOVER-09C-01: cloud workspace bootstrap does not author db$docProperties system facts", () => {
    const cloudWorkspaceEngine = read(
      "client/libs/core/src/modules/workspace-engine/impls/cloud.ts",
    );

    expect(cloudWorkspaceEngine).not.toContain("writeInitialDocProperties");
    expect(cloudWorkspaceEngine).not.toContain("db$docProperties");
    expect(cloudWorkspaceEngine).not.toMatch(
      /createdBy["']?\s*,?\s*(?:creatorId|accountId)/,
    );
  });

  test("CUTOVER-09C-02: local account event services cannot write createdBy or updatedBy", () => {
    const serverModule = read("client/libs/core/src/modules/server/index.ts");

    expect(serverModule).not.toContain("DocCreatedByService");
    expect(serverModule).not.toContain("DocUpdatedByService");
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/modules/server/services/doc-created-by.ts",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/modules/server/services/doc-updated-by.ts",
        ),
      ),
    ).toBe(false);
  });

  test("CUTOVER-09C-03: generic DocRecord/Doc APIs do not expose system fact setters", () => {
    const docRecord = read(
      "client/libs/core/src/modules/doc/entities/record.ts",
    );
    const docEntity = read("client/libs/core/src/modules/doc/entities/doc.ts");

    expect(docRecord).not.toContain("applyServerSystemFactsProjection");
    expect(docRecord).toContain("watchDocCreatedBySetting");
    expect(docRecord).toContain("watchDocUpdatedBySetting");
    expect(docRecord).not.toMatch(/\bsetCreatedBy\s*\(/);
    expect(docRecord).not.toMatch(/\bsetUpdatedBy\s*\(/);
    expect(docEntity).not.toMatch(/\bsetCreatedBy\s*\(/);
    expect(docEntity).not.toMatch(/\bsetUpdatedBy\s*\(/);
  });

  test("CUTOVER-09C-04: native system facts never project into client Yjs", () => {
    const docPropertiesStore = read(
      "client/libs/core/src/modules/doc/stores/doc-properties.ts",
    );
    const serverModule = read("client/libs/core/src/modules/server/index.ts");
    const removedPaths = [
      "client/libs/core/src/modules/server/services/doc-created-by-updated-by-sync.ts",
      "client/libs/core/src/modules/server/stores/doc-created-by-updated-by-sync.ts",
      "client/libs/core/src/desktop/pages/workspace/all-page/migration-data.tsx",
    ];

    expect(docPropertiesStore).toContain("RESERVED_SYSTEM_FACT_KEYS");
    expect(docPropertiesStore).not.toContain(
      "applyServerSystemFactsProjection",
    );
    expect(serverModule).not.toContain("DocCreatedByUpdatedBySync");
    for (const path of removedPaths) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }
  });

  test("runtime metadata cache has no persistent client storage dependency", () => {
    const cache = read(
      "client/libs/core/src/modules/document-metadata/services/document-metadata-cache.ts",
    );
    const module = read(
      "client/libs/core/src/modules/document-metadata/module.ts",
    );
    const dbSchema = read("client/libs/core/src/modules/db/schema/schema.ts");

    expect(cache).not.toContain("WorkspaceDBService");
    expect(cache).not.toContain("getWorkspaceDbDoc");
    expect(cache).not.toContain("connectDoc");
    expect(module).toContain(".store(DocumentMetadataCacheStore)");
    expect(module).not.toContain(
      ".store(DocumentMetadataCacheStore, [WorkspaceDBService])",
    );
    expect(dbSchema).not.toContain("documentMetadataCache:");
  });

  test("reserved metadata collections and templates keep an explicit local/native boundary", () => {
    const docsService = read(
      "client/libs/core/src/modules/doc/services/docs.ts",
    );
    const docsStore = read("client/libs/core/src/modules/doc/stores/docs.ts");
    const templateStore = read(
      "client/libs/core/src/modules/template-doc/store/list.ts",
    );
    const templateService = read(
      "client/libs/core/src/modules/template-doc/services/template-doc.ts",
    );

    expect(docsService).toContain("isNativeMetadataPropertyKey(propertyKey)");
    expect(docsService).toContain("watchNativeMetadataPropertyValues");
    expect(docsStore).toContain(
      'this.workspaceService.workspace.flavour === "local"',
    );
    expect(docsStore).toContain("this.documentMetadataCache.hydrateIndex");
    expect(templateStore).toContain("if (!this.isLocalWorkspace)");
    expect(templateStore).toContain(
      'this.workspaceService.workspace.flavour === "local"',
    );
    expect(templateService).toContain("templateSuggestionsQuery");
    expect(templateService).toContain(
      'this.workspaceService.workspace.flavour === "local"',
    );
  });

  test("reserved metadata consumers use the workspace-aware DocRecord boundary", () => {
    const guardedDirs = [
      "client/libs/core/src/components",
      "client/libs/core/src/editor",
      "client/libs/core/src/modules/integration",
      "client/libs/core/src/modules/journal",
    ];
    const reservedField =
      "createdBy|updatedBy|journal|isTemplate|primaryMode|pageWidth|edgelessColorTheme|integrationType";
    const directLegacyRead = new RegExp(
      `(?:\\.property\\$\\(\\s*["'](?:${reservedField})["']|\\.properties\\$(?:\\.value|\\.selector|\\.map)?[\\s\\S]{0,100}?\\b(?:${reservedField})\\b)`,
      "g",
    );

    const violations = guardedDirs
      .flatMap((path) => collectSourceFiles(join(repoRoot, path)))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(directLegacyRead)].map(
          (match) =>
            `${relative(repoRoot, file)}: ${match[0].replace(/\s+/g, " ")}`,
        );
      });

    expect(violations).toEqual([]);

    const docRecord = read(
      "client/libs/core/src/modules/doc/entities/record.ts",
    );
    for (const liveField of [
      "createdBy$",
      "updatedBy$",
      "journalDate$",
      "isTemplate$",
      "primaryMode$",
      "pageWidth$",
      "edgelessColorTheme$",
      "integrationType$",
    ]) {
      expect(docRecord, liveField).toContain(liveField);
    }
  });

  test("CUTOVER-09D: native subsystem writers do not use generic docProperties writes", () => {
    const guardedPaths = [
      "client/libs/core/src/modules/journal",
      "client/libs/core/src/components/workspace-property-types",
      "client/libs/core/src/modules/doc",
      "client/libs/core/src/modules/integration",
      "client/libs/core/src/modules/editor-setting",
      "client/libs/core/src/components/hooks/myoxus",
      "client/libs/core/src/components/providers",
      "client/libs/core/src/modules/import-template",
    ];
    const forbiddenGenericSubsystemWrites =
      /(?:setProperty|updateProperties|updateDocProperties)\s*\([^);]*(?:["'`](?:journal|isTemplate|primaryMode|pageWidth|edgelessColorTheme|integrationType)["'`]|(?:journal|isTemplate|primaryMode|pageWidth|edgelessColorTheme|integrationType)\s*:)/gs;
    const allowedProjectionFiles = new Set([
      "client/libs/core/src/modules/doc/stores/doc-properties.ts",
      "client/libs/core/src/modules/doc/stores/doc-properties.spec.ts",
      "client/libs/core/src/modules/doc/stores/docs.ts",
    ]);

    const violations = guardedPaths
      .flatMap((path) => collectSourceFiles(join(repoRoot, path)))
      .flatMap((file) => {
        const relativePath = relative(repoRoot, file);
        if (allowedProjectionFiles.has(relativePath)) return [];
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(forbiddenGenericSubsystemWrites)].map(
          (match) => `${relativePath}: ${match[0].replace(/\s+/g, " ")}`,
        );
      });

    expect(violations).toEqual([]);

    const docsStore = read("client/libs/core/src/modules/doc/stores/docs.ts");
    const docPropertiesStore = read(
      "client/libs/core/src/modules/doc/stores/doc-properties.ts",
    );
    expect(docsStore).toContain("setDocumentMetadata(");
    expect(docsStore).toContain("WorkspaceServerService");
    expect(docsStore).not.toContain("framework.get(GraphQLService)");
    expect(docsStore).toContain("setDocJournalDateSetting");
    expect(docsStore).toContain("setDocTemplateStateSetting");
    expect(docsStore).toContain("setDocPageWidthSetting");
    expect(docsStore).toContain("setDocEdgelessColorThemeSetting");
    expect(docsStore).toContain("setDocIntegrationTypeSetting");
    expect(docPropertiesStore).toContain("RESERVED_SUBSYSTEM_KEYS");
    expect(docPropertiesStore).not.toContain("applyServerSubsystemProjection");
    expect(docPropertiesStore).toContain("applyOfflineSubsystemProjection");
  });

  test("CUTOVER-09C-05: archive and learning record the no-second-system-facts boundary", () => {
    const archive = read("todo/server-done.md");
    const learning = read("learnings/doc-sync-consolidation.md");

    expect(archive).toContain(
      "Keine offenen Umsetzungspakete in diesem Track.",
    );
    expect(archive).toContain(
      "`docProperties`, freie Workspace-Properties und lokale `db$...`-Shapes sind",
    );
    expect(archive).toContain(
      "keine zweite Wahrheit fuer kanonische Dokumentmetadaten.",
    );
    expect(archive).toContain(
      "Der historische Detailplan wurde am 2026-06-29 in",
    );
    expect(learning).toContain(
      "LRN-20260527-CLIENT-DOC-PROPERTIES-MUST-NOT-AUTHOR-SYSTEM-FACTS",
    );
  });

  test("does not write canonical metadata through free workspace custom properties", () => {
    const forbidden =
      /\b(?:DocCustomPropertyInfo|WorkspacePropertiesTable|docCustomProperty|customProperties|onPropertyAdded|onDatabasePropertyChange)\b/g;
    const guardedDirs = [
      "client/libs/core/src/modules/document-metadata",
      "client/libs/core/src/modules/pdf-export",
      "client/libs/core/src/modules/collection-rules/impls/filters",
    ];

    const violations = guardedDirs
      .flatMap((dir) => collectSourceFiles(join(repoRoot, dir)))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(forbidden)].map(
          (match) => `${relative(repoRoot, file)}: ${match[0]}`,
        );
      });

    expect(violations).toEqual([]);
  });

  test("uses generated native @myoxus/graphql response and input types for document metadata", () => {
    const coreTypes = read(
      "client/libs/core/src/modules/document-metadata/types.ts",
    );
    const coreApi = read(
      "client/libs/core/src/modules/document-metadata/api.ts",
    );
    const adminApi = read(
      "client/admin/workspaces/admin/src/modules/documents/api.ts",
    );
    const localFlatType =
      /\b(?:type|interface)\s+(?:Admin)?DocumentAttribute\w*(?:Response|Result|Payload)\b/g;

    expect(coreTypes).toContain('from "@myoxus/graphql"');
    expect(coreTypes).toContain('DocumentMetadataQuery["documentMetadata"]');
    expect(coreTypes).toContain("SetDocumentMetadataInput");
    expect(coreTypes).toContain("projectionVersion: string");
    expect(coreApi).toContain("type DocumentMetadataQuery");
    expect(coreApi).toContain("type DocumentMetadataValidationQuery");
    expect(coreApi).toContain("type SetDocumentMetadataMutation");
    expect(coreApi).toContain("documentMetadataQuery");
    expect(coreApi).toContain("documentMetadataValidationQuery");
    expect(coreApi).toContain("projectionVersion: metadata.projectionVersion");
    expect(coreApi).toContain("metadataRevision: metadata.metadataRevision");
    expect(coreApi).toContain("metadataUpdatedAt: metadata.metadataUpdatedAt");
    expect(coreApi).not.toMatch(
      /projectionVersion:\s*metadata\.system\.updatedAt/,
    );
    expect(coreApi).not.toMatch(
      /metadataRevision:\s*metadata\.system\.updatedAt/,
    );
    expect(coreApi).toContain("setDocumentMetadataMutation");
    expect(coreApi).not.toContain("documentAttributesQuery");
    expect(coreApi).not.toContain("setDocumentAttributesMutation");
    expect(coreApi).not.toContain("buildNativeValidation");
    expect(coreApi).not.toContain("DOCUMENT_ATTRIBUTE_REQUIRED");
    expect(adminApi).toContain('from "@myoxus/graphql"');
    expect(adminApi).toContain(
      "type AdminUpdateDocumentMetadataFieldDefinitionInput",
    );

    const violations = [
      "client/libs/core/src/modules/document-metadata",
      "client/admin/workspaces/admin/src/modules/documents",
    ]
      .flatMap((dir) => collectSourceFiles(join(repoRoot, dir)))
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(localFlatType)].map(
          (match) => `${relative(repoRoot, file)}: ${match[0]}`,
        );
      });

    expect(violations).toEqual([]);
  });

  test("renders document metadata details through facade chrome without a local CSS island", () => {
    const editor = read(
      "client/libs/core/src/modules/document-metadata/index.tsx",
    );

    expect(editor).toContain("DisclosureCard,");
    expect(editor).toContain("DisclosureCardIndicator,");
    expect(editor).toContain("DisclosureCardTrigger,");
    expect(editor).toContain("DocumentMetadataDetailsProps");
    expect(editor).toContain('layout = "editor"');
    expect(editor).toContain('layout === "embedded"');
    expect(editor).toContain('layout === "dialog"');
    expect(editor).toContain('const constrained = layout === "editor"');
    expect(editor).toContain("const tabbed = dialog || embedded");
    expect(editor).toContain("data-document-metadata-layout={layout}");
    expect(editor).toContain("maw={constrained ?");
    expect(editor).toContain("tabbedBody");
    expect(editor).toContain("editorBody");
    expect(editor).toContain("Badge,");
    expect(editor).toContain("BadgeList,");
    expect(editor).toContain("ColorSwatch,");
    expect(editor).toContain("Group,");
    expect(editor).toContain("Stack,");
    expect(editor).toContain("SettingsNotice,");
    expect(editor).toContain("MyoxusText,");
    expect(editor).toContain("Tabs,");
    expect(editor).toContain("TabsContent,");
    expect(editor).toContain("TabsList,");
    expect(editor).toContain("TabsTrigger,");
    expect(editor).toContain("TableBody,");
    expect(editor).toContain("TableHead,");
    expect(editor).toContain("TableRow,");
    expect(editor).toContain("TagService");
    expect(editor).toContain("tagList.tagsByPageId$(docId)");
    expect(editor).toContain('data-testid="document-metadata-header"');
    expect(editor).toContain('data-testid="document-metadata-tags"');
    expect(editor).toContain("tagColorRole={color}");
    expect(editor).toContain(
      'data-myoxus-ui-role="document-metadata-tag-color"',
    );
    expect(editor).toContain('surface="floating"');
    expect(editor).toContain('tone="neutral"');
    expect(editor).toContain('tone="warning"');
    expect(editor).toContain('tone="error"');
    expect(editor).toMatch(/<DisclosureCard\s+component="section"/);
    expect(editor).toContain("<DisclosureCardTrigger");
    expect(editor).toContain("<DisclosureCardIndicator");
    expect(editor).toMatch(/\{tabbed \? \(\s+tabbedBody\s+\) : \(/);
    expect(editor).toContain('defaultValue="information"');
    expect(editor).toContain('data-testid="document-info-tab-edit"');
    expect(editor).toContain('data-testid="document-info-tab-information"');
    expect(editor).toContain('data-testid="document-info-tab-system"');
    expect(editor).toContain("function DocumentInfoFactTable");
    expect(editor).toContain('<TableHead scope="row">');
    expect(editor).toContain('data-myoxus-ui-role="editor-card"');
    expect(editor).not.toContain("classNames(");
    expect(editor).not.toContain("className={styles.");
    expect(editor).not.toContain("right-sidebar-panel/panel.styles");
    expect(editor).not.toContain("panelStyles");
    expect(editor).not.toContain("./styles.styles");
    expect(
      existsSync(
        join(repoRoot, "client/libs/ui-facade/src/surface-disclosure.css"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/modules/document-metadata/styles.css",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/modules/document-metadata/styles.styles.ts",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/components/right-sidebar-panel/panel.css",
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/components/right-sidebar-panel/panel.styles.ts",
        ),
      ),
    ).toBe(false);
  });

  test("document metadata disclosure arrows use the facade indicator contract", () => {
    const editor = read(
      "client/libs/core/src/modules/document-metadata/index.tsx",
    );
    const facade = read("client/libs/ui-facade/src/card.tsx");

    expect(editor.match(/<DisclosureCardIndicator/g)).toHaveLength(2);
    expect(facade).toContain("export function DisclosureCardIndicator");
    expect(facade).toContain("<ChevronDownIcon");
    expect(facade).toContain("<ChevronRightIcon");
    expect(facade).not.toContain("myoxus-ui-disclosure-card-indicator");
    expect(
      existsSync(
        join(repoRoot, "client/libs/ui-facade/src/surface-disclosure.css"),
      ),
    ).toBe(false);
  });

  test("desktop doc-info dialog uses the native server metadata editor only", () => {
    const dialog = read(
      "client/libs/core/src/desktop/dialogs/doc-info/index.tsx",
    );
    const retiredStyleFiles = [
      "client/libs/core/src/desktop/dialogs/doc-info/styles.css",
      "client/libs/core/src/desktop/dialogs/doc-info/styles.styles.ts",
    ];

    expect(dialog).toContain("DocumentMetadataEditorView");
    expect(dialog).toContain("showSummary={false}");
    expect(dialog).toContain('detailsLayout="dialog"');
    expect(dialog).toContain("GraphQLService");
    expect(dialog).toContain("DocumentMetadataCacheService");
    expect(dialog).toContain("metadataCache={metadataCache}");
    expect(dialog).toContain("canConfigureWorkspaceDefaults=");
    expect(dialog).toContain("canOpenGlobalPolicy=");
    expect(dialog).toContain('width="xl"');
    expect(dialog).toContain('"document-metadata-dialog"');
    expect(dialog).toContain("<DocInfoDialogTitle />");
    expect(dialog).not.toContain('typographySlot="h5"');
    expect(dialog).not.toContain("lineClamp={1}");
    expect(dialog).not.toContain("VirgultumHeaderTitle");
    expect(dialog).not.toContain("withoutCloseButton");
    expect(dialog).not.toContain("./styles.styles");
    expect(dialog).not.toContain("styles.");
    expect(dialog).not.toContain("Scrollable.");
    expect(dialog).not.toContain("calc(100vw");
    expect(dialog).not.toContain("760px");
    expect(dialog).not.toContain("48px");
    expect(dialog).not.toContain("InfoTable");
    expect(dialog).not.toContain("WorkspacePropertyRow");
    expect(dialog).not.toContain("DocDatabaseBacklinkInfo");
    expect(
      existsSync(
        join(
          repoRoot,
          "client/libs/core/src/desktop/dialogs/doc-info/info-modal.tsx",
        ),
      ),
    ).toBe(false);
    for (const retiredStyleFile of retiredStyleFiles) {
      expect(existsSync(join(repoRoot, retiredStyleFile))).toBe(false);
    }
  });

  test("document detail right sidebar does not expose document metadata or legacy workspace properties", () => {
    const detailPage = read(
      "client/libs/core/src/desktop/pages/workspace/detail-page/detail-page.tsx",
    );

    expect(detailPage).not.toContain("DocumentMetadataEditor");
    expect(detailPage).not.toContain('tabId="document-metadata"');
    expect(detailPage).not.toContain("shouldShowDocumentMetadata");
    expect(detailPage).not.toContain('detailsLayout="embedded"');
    expect(detailPage).not.toContain("showSummary={false}");
    expect(detailPage).not.toContain("DocumentMetadataSidebar");
    expect(detailPage).not.toContain("FileIcon");
    expect(detailPage).not.toContain("WorkspacePropertySidebar");
    expect(detailPage).not.toContain('tabId="document-attributes"');
    expect(detailPage).not.toContain('tabId="properties"');
    expect(
      existsSync(
        join(repoRoot, "client/libs/core/src/components/properties/sidebar"),
      ),
    ).toBe(false);
  });

  test("keeps electron renderer on shared core metadata consumers", () => {
    const electronEntrypoints = [
      "client/apps/electron-renderer/src/app/setup.ts",
      "client/apps/electron-renderer/src/shell/setup.ts",
      "client/apps/electron-renderer/src/popup/setup.ts",
    ];
    for (const entrypoint of electronEntrypoints) {
      expect(read(entrypoint)).toContain("@myoxus/core/bootstrap/electron");
    }
    expect(
      read("client/apps/electron-renderer/src/background-worker/index.ts"),
    ).toContain("@myoxus/core/bootstrap/worker");

    const forbiddenElectronMetadataPaths =
      /\b(?:documentMetadataQuery|setDocumentMetadataMutation|documentMetadataQuery|setDocumentMetadataMutation|pageMeta|db\$docProperties)\b/g;
    const violations = collectSourceFiles(
      join(repoRoot, "client/apps/electron-renderer/src"),
    ).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(forbiddenElectronMetadataPaths)].map(
        (match) => `${relative(repoRoot, file)}: ${match[0]}`,
      );
    });

    expect(violations).toEqual([]);
  });
});
