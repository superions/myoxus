/**
 * @vitest-environment happy-dom
 */
import { DocumentMetadataProjectionModeType } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalFormatters: () => ({
    formatDateTime: (value: string) => value,
  }),
}));

import {
  LATEST_DOCUMENT_VERSION,
  PdfDocumentVersionPicker,
} from "../version-picker";

const settings = {
  docId: "doc-1",
  enabled: true,
  retentionCount: 25,
  autoVersionOn: ["on_pdf_export"],
};

const versions = [
  {
    id: "ver-1",
    label: "reviewed-v1",
    description: "Reviewed",
    createdAt: "2026-05-01T12:00:00.000Z",
    isPinned: true,
  },
];

const documentMetadata = {
  docId: "doc-1",
  workspaceId: "ws-1",
  projectionMode: DocumentMetadataProjectionModeType.MYOXUS_NATIVE,
  projectionVersion: "1",
  metadataRevision: 1,
  metadataUpdatedAt: null,
  metadataUpdatedBy: null,
  system: {
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
    createdBy: "user-1",
    updatedBy: null,
    metadataUpdatedAt: null,
    metadataUpdatedBy: null,
  },
  fields: [],
  audience: [],
  template: null,
  journal: { journalDate: null },
  presentation: null,
  integration: null,
  policy: { locks: [] },
  legacy: null,
};

describe("PDF document version picker", () => {
  afterEach(cleanup);

  test("stays absent when document versioning is disabled", () => {
    render(
      <MyoxusUIProvider>
        <PdfDocumentVersionPicker
          settings={{ ...settings, enabled: false }}
          versions={versions}
          value={LATEST_DOCUMENT_VERSION}
          onChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    expect(
      screen.queryByRole("combobox", { name: "Document version" }),
    ).toBeNull();
  });

  test("selects a named version through the real facade select", async () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <PdfDocumentVersionPicker
          documentMetadata={documentMetadata}
          settings={settings}
          versions={versions}
          value={LATEST_DOCUMENT_VERSION}
          onChange={onChange}
        />
      </MyoxusUIProvider>,
    );

    const selector = screen.getByRole("combobox", { name: "Document version" });
    fireEvent.click(selector);
    fireEvent.click(await screen.findByRole("option", { name: /reviewed-v1/ }));

    expect(onChange).toHaveBeenCalledWith("ver-1");
  });
});
