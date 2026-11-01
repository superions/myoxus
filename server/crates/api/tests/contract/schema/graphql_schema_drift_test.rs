//! Schema drift detection test (P11-C-01).
//!
//! Runs a GraphQL introspection query against the Rust server and verifies that
//! all types and fields expected by the generated frontend client
//! (`client/libs/graphql/src/schema.ts`)
//! are present. This catches schema regressions where a rename or removal in the
//! Rust schema breaks server-side contracts. Client operation drift is checked
//! separately by `build/scripts/test/verify-codegen.sh --require-server` and
//! the `client/libs/core` typecheck gate.
//!
//! The test does NOT require the schema.ts file at runtime — instead it encodes
//! the critical type/field pairs directly, so it can run in CI without the full
//! monorepo checkout.

use crate::helpers;

use serde_json::{Value, json};

/// Run a full introspection query and return the schema JSON.
async fn introspect(app: &axum::Router, session: uuid::Uuid) -> Value {
  helpers::gql(
    app,
    session,
    json!({
      "query": r#"
        {
          __schema {
            queryType { name }
            mutationType { name }
            types {
              name
              kind
              fields { name }
              inputFields { name }
              enumValues { name }
            }
          }
        }
      "#
    }),
  )
  .await
}

/// Extract type names from introspection result.
fn type_names(schema: &Value) -> Vec<String> {
  schema["data"]["__schema"]["types"]
    .as_array()
    .expect("schema drift check")
    .iter()
    .filter_map(|t| t["name"].as_str().map(String::from))
    .collect()
}

/// Extract field names for a given type from introspection result.
fn fields_of(schema: &Value, type_name: &str) -> Vec<String> {
  schema["data"]["__schema"]["types"]
    .as_array()
    .expect("schema drift check")
    .iter()
    .find(|t| t["name"].as_str() == Some(type_name))
    .and_then(|t| t["fields"].as_array())
    .map(|fields| {
      fields
        .iter()
        .filter_map(|f| f["name"].as_str().map(String::from))
        .collect()
    })
    .unwrap_or_default()
}

/// Extract input field names for a given input object.
fn input_fields_of(schema: &Value, type_name: &str) -> Vec<String> {
  schema["data"]["__schema"]["types"]
    .as_array()
    .expect("schema drift check")
    .iter()
    .find(|t| t["name"].as_str() == Some(type_name))
    .and_then(|t| t["inputFields"].as_array())
    .map(|fields| {
      fields
        .iter()
        .filter_map(|f| f["name"].as_str().map(String::from))
        .collect()
    })
    .unwrap_or_default()
}

/// Critical types that the frontend expects to exist in the schema.
/// If any of these are missing, the frontend will break.
const CRITICAL_TYPES: &[&str] = &[
  // Core domain
  "WorkspaceType",
  "UserType",
  "InvitationType",
  // Admin
  "AdminWorkspaceType",
  "ThemeCatalogType",
  "ThemeDefinitionType",
  "ThemeTypographyStyleType",
  "ThemeFontFamilyType",
  "ThemeFontAssetType",
  "ThemeProfileType",
  "BrandAssetType",
  "AppServerBrandingType",
  "OrganizationIdentityType",
  "DocumentBrandColorPaletteType",
  // Auth
  "tokenType",
  // Input types
  "PaginationInput",
  "SetThemeProfileInput",
  "SetTypographyStylesInput",
  "TypographyStylePatchInput",
  "SetColorSchemaValuesInput",
  "ColorSchemaValuePatchInput",
  "DeleteDocumentPermanentlyInput",
  "DeleteDocumentsPermanentlyInput",
  "EmptyWorkspaceTrashInput",
  "DeleteDocumentsPermanentlyPayload",
  "DeleteDocumentPermanentlyResultType",
  "DocumentMetadataType",
  "DocumentMetadataSystemFactsType",
  "DocumentMetadataFieldValueType",
  "DocumentMetadataAudienceType",
  "DocumentMetadataReferenceValueType",
  "DocumentMetadataPolicyType",
  "DocumentMetadataFieldLockType",
  "DocumentMetadataTemplateType",
  "DocumentMetadataJournalType",
  "DocumentMetadataPresentationType",
  "DocumentMetadataIntegrationType",
  "DocumentMetadataProjectionModeType",
  "DocumentMetadataSourceType",
  "DocumentMetadataInheritanceModeType",
  "SetDocumentMetadataInput",
  "SetDocumentMetadataPayload",
  "CreateWorkspaceEventInput",
  "UpdateWorkspaceEventInput",
  "DatabaseDocumentLinkCellValueType",
  "DatabaseDocumentLinkCellValueInput",
  "WorkspaceImportPartManifestInput",
  "WorkspaceImportPartUploadType",
  "WorkspaceImportUploadType",
  "WorkspaceImportCountsType",
  "WorkspaceImportTargetPlanType",
  "WorkspaceImportDiagnosticType",
  "WorkspaceImportPreviewType",
  "WorkspaceImportType",
  "LegacyDatabaseMigrationInput",
  "LegacyDatabaseMigrationReferenceObjectType",
  "LegacyDatabaseMigrationPlanObjectType",
  "LegacyDatabaseMigrationApplyObjectType",
  // Enums
  "OAuthProviderType",
  "DeleteDocumentPermanentlyStatus",
];

/// Critical input fields that must stay available to generated frontend clients.
const CRITICAL_INPUT_FIELDS: &[(&str, &[&str])] = &[
  (
    "CreateWorkspaceEventInput",
    &[
      "workspaceId",
      "title",
      "descriptionDelta",
      "startsAt",
      "endsAt",
      "allDay",
      "allMembers",
      "tagId",
      "sourceDocId",
      "sourceBlockId",
      "sourceStartOffset",
      "sourceEndOffset",
      "sourceKind",
      "reminders",
    ],
  ),
  (
    "UpdateWorkspaceEventInput",
    &[
      "title",
      "descriptionDelta",
      "startsAt",
      "endsAt",
      "allDay",
      "allMembers",
      "tagId",
      "sourceDocId",
      "sourceBlockId",
      "sourceStartOffset",
      "sourceEndOffset",
      "sourceKind",
    ],
  ),
  ("DatabaseCellValueInput", &["text", "relation", "documentLink"]),
  ("DatabaseDocumentLinkCellValueInput", &["docId"]),
  (
    "WorkspaceImportPartManifestInput",
    &["partNumber", "sizeBytes", "contentHash"],
  ),
  ("LegacyDatabaseMigrationInput", &["workspaceId", "documentIds"]),
];

/// Critical fields on key types that the frontend queries.
const CRITICAL_FIELDS: &[(&str, &[&str])] = &[
  (
    "WorkspaceType",
    &[
      "id",
      "name",
      "public",
      "owner",
      "initialized",
      "createdAt",
      "workspaceType",
    ],
  ),
  (
    "UserType",
    &["id", "name", "email", "avatarUrl", "emailVerified", "hasPassword"],
  ),
  ("AdminWorkspaceType", &["id", "name", "public", "owner", "createdAt"]),
  (
    "AdminRoot",
    &[
      "themeCatalog",
      "effectiveThemeProfile",
      "appServerBranding",
      "organizationIdentity",
      "documentBrandColorPalettes",
      "resetWorkspaceDocumentBranding",
      "setDocumentBrandingColorPolicy",
      "updateOrganizationIdentity",
      "updateAppServerBranding",
      "setThemeProfile",
      "setTypographyStyles",
      "setColorSchemaValues",
      "resetWorkspaceThemeProfile",
      "adminDashboard",
      "adminWorkspaces",
      "users",
    ],
  ),
  (
    "DocumentBrandColorPaletteType",
    &[
      "themeSlug",
      "themeName",
      "paletteKey",
      "name",
      "primaryColor",
      "accentColor",
      "ruleColor",
      "textColor",
      "backgroundColor",
      "isDefault",
    ],
  ),
  ("ThemeCatalogType", &["catalogHash", "themes", "fontFamilies"]),
  (
    "ThemeDefinitionType",
    &[
      "slug",
      "name",
      "category",
      "previewGroup",
      "previewOrder",
      "taglineKey",
      "descriptionKey",
      "origin",
      "locked",
      "isDefault",
      "colorSchemaSlug",
      "typographySlug",
      "colors",
      "typographyStyles",
    ],
  ),
  (
    "ThemeTypographyStyleType",
    &[
      "styleKey",
      "fontFamilySlug",
      "fontFamily",
      "cssFamily",
      "fontWeight",
      "fontStyle",
      "sizePx",
      "lineHeight",
      "letterSpacingEm",
      "fontFeatures",
      "fontVariations",
      "pdfRole",
    ],
  ),
  (
    "ThemeFontFamilyType",
    &[
      "slug",
      "displayName",
      "cssFamily",
      "genericClass",
      "source",
      "licenseSpdx",
      "licenseStatus",
      "isSelectable",
      "assets",
    ],
  ),
  (
    "ThemeFontAssetType",
    &[
      "usage",
      "format",
      "style",
      "weightMin",
      "weightMax",
      "weightDefault",
      "assetKey",
      "sha256",
      "mime",
      "unicodeRanges",
      "subsetTags",
    ],
  ),
  ("ThemeProfileType", &["scope", "workspaceId", "themeMode", "theme"]),
  (
    "MutationRoot",
    &[
      "deleteDocumentPermanently",
      "deleteDocumentsPermanently",
      "emptyWorkspaceTrash",
      "createWorkspaceImportUpload",
      "completeWorkspaceImportUpload",
      "previewWorkspaceImport",
      "applyWorkspaceImport",
      "cancelWorkspaceImport",
      "retryWorkspaceImportCleanup",
      "applyLegacyDatabaseMigration",
    ],
  ),
  ("QueryRoot", &["workspaceImport", "previewLegacyDatabaseMigration"]),
  (
    "WorkspaceImportType",
    &[
      "id",
      "status",
      "queuedOperation",
      "progressStage",
      "progressCurrent",
      "progressTotal",
      "cancelRequested",
      "preview",
      "targetWorkspaceId",
      "errorCode",
      "errorMessage",
      "createdAt",
      "updatedAt",
      "expiresAt",
    ],
  ),
  (
    "WorkspaceImportPreviewType",
    &[
      "detectedFormat",
      "proposedWorkspaceTitle",
      "counts",
      "omittedCounts",
      "targetPlan",
      "diagnostics",
      "sourceHash",
      "configFingerprint",
      "applyAllowed",
    ],
  ),
  (
    "LegacyDatabaseMigrationPlanObjectType",
    &[
      "databaseIds",
      "blockReferences",
      "fieldCount",
      "rowCount",
      "cellCount",
      "viewCount",
      "diagnostics",
      "applyAllowed",
    ],
  ),
  (
    "DeleteDocumentsPermanentlyPayload",
    &[
      "requested",
      "deleted",
      "notFound",
      "forbidden",
      "alreadyDeleted",
      "failed",
      "rootMetaRemoved",
      "documents",
    ],
  ),
  (
    "DocumentMetadataType",
    &[
      "docId",
      "workspaceId",
      "projectionMode",
      "projectionVersion",
      "metadataRevision",
      "metadataUpdatedAt",
      "metadataUpdatedBy",
      "system",
      "fields",
      "audience",
      "template",
      "journal",
      "presentation",
      "integration",
      "policy",
      "legacy",
    ],
  ),
  (
    "DocumentMetadataSystemFactsType",
    &[
      "createdAt",
      "createdBy",
      "updatedAt",
      "updatedBy",
      "metadataUpdatedAt",
      "metadataUpdatedBy",
    ],
  ),
  (
    "DocumentMetadataFieldValueType",
    &[
      "key",
      "source",
      "reference",
      "textValue",
      "timestampValue",
      "dateValue",
      "userId",
    ],
  ),
  ("DocumentMetadataAudienceType", &["value", "source"]),
  (
    "DocumentMetadataReferenceValueType",
    &["id", "key", "label", "isActive"],
  ),
  ("DocumentMetadataPolicyType", &["locks"]),
  (
    "DocumentMetadataFieldLockType",
    &["key", "inheritanceMode", "editable", "reason"],
  ),
  (
    "DocumentMetadataTemplateType",
    &["state", "templateId", "revisionId", "instanceId"],
  ),
  ("DocumentMetadataJournalType", &["journalDate"]),
  (
    "DocumentMetadataPresentationType",
    &["primaryMode", "pageWidth", "edgelessColorTheme"],
  ),
  ("DocumentMetadataIntegrationType", &["integrationType"]),
  ("SetDocumentMetadataPayload", &["metadata"]),
  (
    "DatabaseCellValueDataType",
    &["kind", "text", "relation", "documentLink"],
  ),
  ("DatabaseDocumentLinkCellValueType", &["docId"]),
  (
    "DeleteDocumentPermanentlyResultType",
    &["clientDocId", "resolvedDocId", "title", "status", "reason"],
  ),
  (
    "BrandAssetType",
    &[
      "id",
      "slot",
      "variant",
      "qualityClass",
      "storageKind",
      "storageKey",
      "publicUrl",
      "mime",
      "sha256",
      "byteSize",
      "widthPx",
      "heightPx",
    ],
  ),
  ("AppServerBrandingType", &["logo", "productMark", "faviconPack"]),
  (
    "OrganizationIdentityType",
    &[
      "displayName",
      "legalName",
      "shortName",
      "jurisdiction",
      "websiteUrl",
      "contactEmail",
      "addressLines",
      "taxId",
      "registrationId",
    ],
  ),
];

#[tokio::test]
async fn schema_drift_critical_contract_present() {
  let (app, pool, auth_store) = helpers::setup_app().await;
  let (admin_id, session) = helpers::seed_admin(&pool, &auth_store).await;

  // Keep this as one DB-backed app boot: the quick integration gate needs one
  // schema-contract smoke, while full integration still owns broader coverage.
  let schema = introspect(&app, session).await;
  assert!(schema.get("errors").is_none(), "introspection failed: {schema}");

  let types = type_names(&schema);

  let mut missing = Vec::new();
  for &expected in CRITICAL_TYPES {
    if !types.contains(&expected.to_string()) {
      missing.push(expected);
    }
  }
  assert!(missing.is_empty(), "critical types missing from schema: {missing:?}");

  let mut drift = Vec::new();
  for &(type_name, expected_fields) in CRITICAL_FIELDS {
    let actual_fields = fields_of(&schema, type_name);
    if actual_fields.is_empty() {
      drift.push(format!("{type_name}: type not found or has no fields"));
      continue;
    }
    for &field in expected_fields {
      if !actual_fields.contains(&field.to_string()) {
        drift.push(format!("{type_name}.{field}"));
      }
    }
  }
  assert!(
    drift.is_empty(),
    "schema drift detected — fields missing:\n{}",
    drift.join("\n")
  );

  let mut input_drift = Vec::new();
  for &(type_name, expected_fields) in CRITICAL_INPUT_FIELDS {
    let actual_fields = input_fields_of(&schema, type_name);
    if actual_fields.is_empty() {
      input_drift.push(format!("{type_name}: input type not found or has no input fields"));
      continue;
    }
    for &field in expected_fields {
      if !actual_fields.contains(&field.to_string()) {
        input_drift.push(format!("{type_name}.{field}"));
      }
    }
  }
  assert!(
    input_drift.is_empty(),
    "schema drift detected — input fields missing:\n{}",
    input_drift.join("\n")
  );

  helpers::cleanup_users(&pool, &[admin_id]).await;
}
