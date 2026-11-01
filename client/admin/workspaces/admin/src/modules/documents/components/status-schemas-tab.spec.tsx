/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";
import { selectMantineOption } from "../../../__tests__/test-utils";

const en: Record<string, string> = enJson;
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

const upsertTransitionMock = vi.fn();
const upsertSchemaMock = vi.fn();
const upsertStatusValueMock = vi.fn();
const mutateSchemasMock = vi.fn();
const mutateValuesMock = vi.fn();
let schemasEmpty = false;

vi.mock("../api", () => ({
  useDocumentMetadataFieldDefinitionsQuery: () => ({
    definitions: [
      {
        key: "classification",
        label: "Classification",
      },
    ],
  }),
  useDocumentStatusSchemasQuery: () => ({
    schemas: schemasEmpty
      ? []
      : [
          {
            id: "schema-1",
            key: "default",
            label: "Default",
            description: "Default lifecycle",
            complexity: "simple",
            isPreset: true,
            isActive: true,
            metadata: {},
          },
          {
            id: "schema-2",
            key: "review",
            label: "Review",
            description: "Review lifecycle",
            complexity: "review",
            isPreset: false,
            isActive: true,
            metadata: {},
          },
        ],
    mutate: mutateSchemasMock,
  }),
  useDocumentStatusValuesQuery: (schemaKey: string) => ({
    values: [
      {
        id: "status-a",
        schemaId: "schema-1",
        key: "a",
        label: "A",
        description: null,
        color: null,
        icon: null,
        sortOrder: 1,
        terminal: false,
        okfStatus: "draft",
        isActive: true,
        metadata: {},
      },
      {
        id: "status-b",
        schemaId: "schema-1",
        key: "b",
        label: "B",
        description: null,
        color: null,
        icon: null,
        sortOrder: 2,
        terminal: false,
        okfStatus: "draft",
        isActive: true,
        metadata: {},
      },
    ].map((value) =>
      schemaKey === "review"
        ? {
            ...value,
            id: value.id + "-review",
            schemaId: "schema-2",
            label: value.label + " Review",
          }
        : value,
    ),
    mutate: mutateValuesMock,
  }),
  useUpsertDocumentStatusSchemaMutation: () => ({
    upsertSchema: upsertSchemaMock,
    isMutating: false,
  }),
  useUpsertDocumentStatusValueMutation: () => ({
    upsertStatusValue: upsertStatusValueMock,
    isMutating: false,
  }),
  useUpsertDocumentStatusTransitionMutation: () => ({
    upsertTransition: upsertTransitionMock,
    isMutating: false,
    error: undefined,
  }),
}));

import { StatusSchemasTab } from "./status-schemas-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

async function selectFacadeOption(
  label: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  selectMantineOption(screen.getByRole("combobox", { name: label }), option);
}

describe("StatusSchemasTab", () => {
  beforeEach(() => {
    upsertTransitionMock.mockReset().mockResolvedValue(undefined);
    upsertSchemaMock.mockReset().mockResolvedValue(undefined);
    upsertStatusValueMock.mockReset().mockResolvedValue(undefined);
    mutateSchemasMock.mockReset().mockResolvedValue(undefined);
    mutateValuesMock.mockReset().mockResolvedValue(undefined);
    schemasEmpty = false;
  });

  afterEach(() => cleanup());

  test("edits the OKF mapping while preserving native workflow fields", async () => {
    renderWithProvider(<StatusSchemasTab />);
    await selectFacadeOption("A · OKF status", "Stable");
    await waitFor(() =>
      expect(upsertStatusValueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "status-a",
          key: "a",
          label: "A",
          terminal: false,
          isActive: true,
          okfStatus: "stable",
        }),
      ),
    );
    expect(mutateValuesMock).toHaveBeenCalledTimes(1);
    upsertStatusValueMock.mockReset().mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId("documents-create-status-value"));
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "custom" },
    });
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Custom" },
    });
    await selectFacadeOption("OKF status", "Deprecated");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(upsertStatusValueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "custom",
          terminal: false,
          okfStatus: "deprecated",
        }),
      ),
    );
  });

  test("saves admin-ui-transition governance fields through the generated mutation", async () => {
    renderWithProvider(<StatusSchemasTab />);
    fireEvent.click(screen.getByTestId("documents-configure-transition"));
    await selectFacadeOption("Required metadata fields", "Classification");
    await selectFacadeOption("Creates version", "Required");
    await selectFacadeOption("Version kind", "Published version");
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);

    await waitFor(() => expect(upsertTransitionMock).toHaveBeenCalledTimes(1));
    expect(upsertTransitionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatusId: "status-a",
        toStatusId: "status-b",
        requiredMetadataFields: ["classification"],
        createsVersion: "required",
        setsVersionKind: "published",
      }),
    );
  });

  test("keeps the selected schema central and opens creation only on demand", async () => {
    renderWithProvider(<StatusSchemasTab />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen
        .getByRole("table", { name: "Status values" })
        .querySelectorAll("tbody tr"),
    ).toHaveLength(2);
    fireEvent.click(screen.getByTestId("documents-create-status-value"));
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "ready" },
    });
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("documents-create-status-value"),
      ),
    );
    expect(upsertStatusValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaId: "schema-1",
        key: "ready",
        label: "Ready",
        sortOrder: 0,
      }),
    );
    expect(mutateValuesMock).toHaveBeenCalledTimes(1);
  });

  test("schema switching uses that schema's status IDs and readable labels", async () => {
    renderWithProvider(<StatusSchemasTab />);
    fireEvent.click(screen.getByTestId("documents-configure-transition"));
    expect(
      screen.getByRole("combobox", { name: "From status" }),
    ).toHaveProperty("value", "A");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    fireEvent.click(screen.getByTestId("documents-configure-transition"));
    expect(
      screen.getByRole("combobox", { name: "From status" }),
    ).toHaveProperty("value", "A Review");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(upsertTransitionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatusId: "status-a-review",
          toStatusId: "status-b-review",
          setsVersionKind: null,
        }),
      ),
    );
  });

  test("retains the dialog and draft when persistence fails", async () => {
    upsertStatusValueMock.mockRejectedValueOnce(
      new Error("Status value rejected"),
    );
    renderWithProvider(<StatusSchemasTab />);
    fireEvent.click(screen.getByTestId("documents-create-status-value"));
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "ready" },
    });
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Ready" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(
      "Status value rejected",
    );
    expect(
      screen.getByRole("dialog").getAttribute("aria-labelledby"),
    ).not.toBeNull();
    expect(screen.getByLabelText("Label")).toHaveProperty("value", "Ready");
    expect(mutateValuesMock).not.toHaveBeenCalled();
  });

  test("allows first-schema creation even when the server catalog is empty", async () => {
    schemasEmpty = true;
    renderWithProvider(<StatusSchemasTab />);
    fireEvent.click(screen.getByTestId("documents-create-schema"));
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "first" },
    });
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "First schema" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(upsertSchemaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "first",
          label: "First schema",
          isPreset: false,
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mutateSchemasMock).toHaveBeenCalledTimes(1);
  });
});
