/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => en[key] ?? key }),
}));

const populatedOverview = {
  totalDocuments: 7,
  byStatus: [{ key: "working", label: "Server status", count: 7 }],
  byDocumentType: [{ key: "custom-type", label: null, count: 7 }],
  byClassification: [{ key: null, label: null, count: 7 }],
  byReviewDue: [],
  byVersionState: [
    { key: "without_current_version", label: "No version", count: 5 },
    { key: "changed", label: "Changed", count: 2 },
  ],
};
let overview: typeof populatedOverview | null = populatedOverview;
let runtimeError: Error | undefined;

vi.mock("../api", () => ({
  useDocumentMetadataFieldDefinitionsQuery: () => ({
    definitions: [
      {
        key: "owner",
        label: "Owner",
        requiredMode: "always",
        exportMode: "required",
      },
      {
        key: "note",
        label: "Note",
        requiredMode: "never",
        exportMode: "optional",
      },
    ],
  }),
  useDocumentStatusSchemasQuery: () => ({ schemas: [{}] }),
  useDocumentTypesQuery: () => ({ types: [{}] }),
  useDocumentVersionPoliciesQuery: () => ({ policies: [{}] }),
  useDocumentRuntimeOverviewQuery: () => ({ overview, error: runtimeError }),
}));

import { OverviewTab } from "./overview-tab";

describe("document overview", () => {
  beforeEach(() => {
    overview = populatedOverview;
    runtimeError = undefined;
  });
  afterEach(cleanup);

  test("preserves server distributions, unknown labels and required metadata", () => {
    render(
      <MyoxusUIProvider>
        <OverviewTab />
      </MyoxusUIProvider>,
    );
    expect(
      screen.getByRole("heading", {
        level: 2,
        name: en["admin.documents.overview.runtime.title"],
      }).tagName,
    ).toBe("H2");
    const status = screen.getByRole("table", {
      name: en["admin.documents.overview.status.title"],
    });
    expect(within(status).getByRole("row").textContent).toBe("Server status7");
    const types = screen.getByRole("table", {
      name: en["admin.documents.overview.types.title"],
    });
    expect(within(types).getByRole("row").textContent).toBe("custom-type7");
    const classification = screen.getByRole("table", {
      name: en["admin.documents.overview.classification.title"],
    });
    expect(within(classification).getByRole("row").textContent).toBe(
      en["admin.documents.overview.bucket.unset"] + "7",
    );
    const versions = screen.getByRole("table", {
      name: en["admin.documents.overview.version.title"],
    });
    expect(
      within(versions)
        .getAllByRole("row")
        .map((row) => row.textContent),
    ).toEqual(["No version5", "Changed2"]);
    expect(screen.getAllByText("Owner")).toHaveLength(2);
    expect(screen.queryByText("Note")).toBeNull();
    expect(screen.getByText(en["admin.common.none"]).textContent).toBe(
      en["admin.common.none"],
    );
  });

  test("does not present a failed or unavailable aggregate as zero documents", () => {
    overview = null;
    runtimeError = new Error("Aggregate unavailable");
    render(
      <MyoxusUIProvider>
        <OverviewTab />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("Aggregate unavailable").textContent).toBe(
      "Aggregate unavailable",
    );
    expect(screen.getByText("-").textContent).toBe("-");
    expect(screen.queryByText("0")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  test("retains an authoritative zero total rather than treating it as missing", () => {
    overview = {
      ...populatedOverview,
      totalDocuments: 0,
      byStatus: [],
      byDocumentType: [],
      byClassification: [],
      byVersionState: [],
    };
    render(
      <MyoxusUIProvider>
        <OverviewTab />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("0").textContent).toBe("0");
    expect(screen.queryByText("-")).toBeNull();
  });
});
