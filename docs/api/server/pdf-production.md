# PDF production via API

[Documentation](../../README.md) / [API](../README.md) / [Server API](./README.md)

Manage PDF templates, workspace assignments, document branding, add-on fonts
and color profiles through the authenticated Admin API.

For request handling, see [Calling GraphQL](./README.md#calling-graphql).
For validation, state transitions and recovery, use the
[operator guide](../../ops/data/pdf-export-templates.md).

<details>
<summary>On this page</summary>

- [Upload a new template](#upload-a-new-template)
- [Delete a template](#delete-a-template)
- [Update template metadata](#update-template-metadata)
- [Workspace template assignments](#workspace-template-assignments)
- [Document branding](#document-branding)
- [Uploaded font add-ons](#uploaded-font-add-ons)
- [ICC profiles](#icc-profiles)

</details>

## Upload a new template

```graphql
mutation UploadPdfTemplate($manifest: JSON!, $filePaths: [String!]!, $files: [Upload!]!, $rightsConfirmed: Boolean!) {
  admin {
    uploadPdfTemplate(manifest: $manifest, filePaths: $filePaths, files: $files, rightsConfirmed: $rightsConfirmed) {
      id
      slug
      version
      createdAt
    }
  }
}
```

## Delete a template

```graphql
mutation {
  admin {
    deletePdfTemplate(id: "…")
  }
}
```

```graphql
mutation {
  admin {
    unassignPdfTemplateFromWorkspace(workspaceId: "…", templateId: "…")
  }
}
```

## Update template metadata

```graphql
mutation {
  admin {
    updatePdfTemplateMetadata(id: "…", name: "…", description: "…") {
      id
      name
      manifest
    }
  }
}
```

## Workspace template assignments

```graphql
mutation AssignPdfTemplateToWorkspace {
  admin {
    assignPdfTemplateToWorkspace(workspaceId: "…", templateId: "…") {
      isDefault
    }
  }
}
mutation SetWorkspaceDefaultPdfTemplate {
  admin {
    setWorkspaceDefaultPdfTemplate(workspaceId: "…", templateId: "…") {
      defaultTemplateId
    }
  }
}
mutation UnassignPdfTemplateFromWorkspace {
  admin {
    unassignPdfTemplateFromWorkspace(workspaceId: "…", templateId: "…")
  }
}
```

## Document branding

```graphql
mutation UploadDocumentBrandLogo($workspaceId: ID!, $kind: BrandLogoKind!, $file: Upload!) {
  admin {
    uploadDocumentBrandLogo(workspaceId: $workspaceId, kind: $kind, file: $file) {
      updatedAt
    }
  }
}

query DocumentColorPalettes($workspaceId: ID!) {
  admin {
    documentBrandColorPalettes(workspaceId: $workspaceId) {
      paletteKey
      primaryColor
      accentColor
    }
  }
}

mutation UpdateDocumentBrandingColors($workspaceId: ID!) {
  admin {
    updateDocumentBrandingColors(workspaceId: $workspaceId, primary: "#1F2937", accent: "#0F766E") {
      updatedAt
    }
  }
}

mutation UpdatePdfExportSettings($workspaceId: ID!) {
  admin {
    updatePdfExportSettings(workspaceId: $workspaceId, paperSize: "A4", locale: "de", colorProfile: "sRGB", imageQuality: "high", ligaturesEnabled: true) {
      defaultPaperSize
    }
  }
}
```

## Uploaded font add-ons

```graphql
mutation UploadPdfFont($file: Upload!) {
  admin {
    uploadPdfFont(file: $file, license: "OFL-1.1") {
      id
      familyName
      licenseStatus
    }
  }
}

mutation ApprovePdfFont($id: ID!) {
  admin {
    approvePdfFont(id: $id) {
      id
      licenseStatus
    }
  }
}

mutation RejectPdfFont($id: ID!) {
  admin {
    rejectPdfFont(id: $id, reason: "License does not allow server-side embedding") {
      id
      licenseStatus
    }
  }
}
```

## ICC profiles

```graphql
mutation UploadIccProfile($file: Upload!) {
  admin {
    uploadIccProfile(name: "Custom CMYK", profileType: CMYK, file: $file) {
      id
      name
      profileType
    }
  }
}
```
