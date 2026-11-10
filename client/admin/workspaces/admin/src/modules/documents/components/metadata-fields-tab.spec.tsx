import type { ReactElement } from "react";
import { Activity } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
    t: (key: string) => en[key] ?? key,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

const mutateMock = vi.fn();
const updateDefinitionMock = vi.fn();
let mutationError: any = undefined;

const definitions = [
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "classification",
    label: "Classification",
    enabled: true,
    requiredMode: "never",
    editableBy: "workspace_admin",
    visibleInHeader: true,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00Z",
  },
  {
    __typename: "DocumentMetadataFieldDefinitionType",
    key: "language",
    label: "Language",
    enabled: true,
    requiredMode: "never",
    editableBy: "editor",
    visibleInHeader: false,
    visibleInProperties: true,
    visibleInLists: true,
    exportMode: "optional",
    validationConfig: {},
    metadata: {},
    updatedBy: null,
    updatedAt: "2026-05-02T00:00:00Z",
  },
];

vi.mock("../api", () => ({
  useDocumentMetadataFieldDefinitionsQuery: () => ({
    definitions,
    mutate: mutateMock,
  }),
  useUpdateDocumentMetadataFieldDefinitionMutation: () => ({
    updateDefinition: updateDefinitionMock,
    isMutating: false,
    error: mutationError,
  }),
}));

import { MetadataFieldsTab } from "./metadata-fields-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

async function selectFacadeOption(
  label: string | RegExp,
  option: string | RegExp,
): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("MetadataFieldsTab", () => {
  beforeEach(() => {
    mutateMock.mockReset().mockResolvedValue(undefined);
    updateDefinitionMock.mockReset().mockResolvedValue(undefined);
    mutationError = undefined;
  });

  afterEach(() => cleanup());

  test("sends the generated metadata-field mutation payload with changed export mode", async () => {
    renderWithProvider(<MetadataFieldsTab />);

    expect(screen.getAllByText("Never").length).toBeGreaterThan(0);
    expect(screen.queryByText("never")).toBeNull();

    await selectFacadeOption("Export mode", "Required");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(updateDefinitionMock).toHaveBeenCalledTimes(1));
    expect(updateDefinitionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "classification",
        requiredMode: "never",
        exportMode: "required",
        editableBy: "workspace_admin",
      }),
    );
  });

  test("renders server validation errors next to the field", () => {
    mutationError = {
      message: "Validation failed",
      extensions: { fieldErrors: { exportMode: "Export mode is invalid" } },
    };
    renderWithProvider(<MetadataFieldsTab />);
    expect(screen.getByText("Export mode is invalid")).toBeTruthy();
  });

  test("reveals collapsed advanced inputs when asynchronous server field errors arrive", async () => {
    const view = renderWithProvider(<MetadataFieldsTab />);
    expect(
      screen.queryByRole("textbox", { name: "Validation config" }),
    ).toBeNull();
    mutationError = {
      message: "Validation failed",
      extensions: {
        fieldErrors: { validationConfig: "Invalid validation rules" },
      },
    };
    view.rerender(
      <MyoxusUIProvider>
        <MetadataFieldsTab />
      </MyoxusUIProvider>,
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("textbox", { name: "Validation config" })
          .getAttribute("aria-invalid"),
      ).toBe("true"),
    );
    expect(screen.getByText("Invalid validation rules").textContent).toBe(
      "Invalid validation rules",
    );
  });

  test("search filters the register without replacing or resetting its editor", () => {
    renderWithProvider(<MetadataFieldsTab />);
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Draft classification" },
    });
    const search = screen.getByRole("textbox", { name: "Search" });
    fireEvent.change(search, { target: { value: "unmatched" } });
    expect(screen.queryByRole("button", { name: "Classification" })).toBeNull();
    expect(
      screen.getByText(en["admin.common.no-results-found"]).textContent,
    ).toBe(en["admin.common.no-results-found"]);
    expect((screen.getByLabelText("Label") as HTMLInputElement).value).toBe(
      "Draft classification",
    );
    fireEvent.change(search, { target: { value: "CLASSIFICATION" } });
    expect(
      screen
        .getByRole("button", { name: "Classification" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(updateDefinitionMock).not.toHaveBeenCalled();
  });

  test("drafts survive tab reactivation and require explicit discard before another field", async () => {
    const view = renderWithProvider(
      <Activity mode="visible">
        <MetadataFieldsTab />
      </Activity>,
    );
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Draft classification" },
    });
    view.rerender(
      <MyoxusUIProvider>
        <Activity mode="hidden">
          <MetadataFieldsTab />
        </Activity>
      </MyoxusUIProvider>,
    );
    view.rerender(
      <MyoxusUIProvider>
        <Activity mode="visible">
          <MetadataFieldsTab />
        </Activity>
      </MyoxusUIProvider>,
    );
    expect(screen.getByLabelText("Label")).toHaveProperty(
      "value",
      "Draft classification",
    );
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    expect((await screen.findByRole("dialog")).textContent).toContain(
      en["admin.unsaved.discard-description"],
    );
    fireEvent.click(screen.getByTestId("admin-confirm-modal-cancel"));
    expect(screen.getByLabelText("Label")).toHaveProperty(
      "value",
      "Draft classification",
    );
    fireEvent.click(screen.getByRole("button", { name: "Language" }));
    fireEvent.click(screen.getByTestId("admin-confirm-modal-confirm"));
    await waitFor(() =>
      expect(screen.getByLabelText("Label")).toHaveProperty(
        "value",
        "Language",
      ),
    );
    expect(updateDefinitionMock).not.toHaveBeenCalled();
  });

  test("invalid JSON reveals its advanced fields and never reaches persistence", async () => {
    renderWithProvider(<MetadataFieldsTab />);
    expect(
      screen.queryByRole("textbox", { name: "Validation config" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Validation config" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Validation config" }),
      {
        target: { value: "{" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        screen
          .getByRole("textbox", { name: "Validation config" })
          .getAttribute("aria-invalid"),
      ).toBe("true"),
    );
    expect(
      screen.getByRole("textbox", { name: "Validation config" }),
    ).toHaveProperty("value", "{");
    expect(updateDefinitionMock).not.toHaveBeenCalled();
  });

  test("failed persistence retains the field draft and reset restores the server value", async () => {
    updateDefinitionMock.mockRejectedValueOnce(new Error("Policy rejected"));
    renderWithProvider(<MetadataFieldsTab />);
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      (await screen.findByText("Policy rejected")).closest('[role="alert"]'),
    ).not.toBeNull();
    expect(screen.getByLabelText("Label")).toHaveProperty(
      "value",
      "Keep this draft",
    );
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(screen.getByLabelText("Label")).toHaveProperty(
      "value",
      "Classification",
    );
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty(
      "disabled",
      true,
    );
  });
});
