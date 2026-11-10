import type { ReactElement } from "react";
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

const upsertValueMock = vi.fn();
const mutateMock = vi.fn();
let selectedMetadataField: string | null = null;

vi.mock("../api", () => ({
  useDocumentMetadataFieldDefinitionsQuery: () => ({
    definitions: [
      { key: "classification", label: "Classification" },
      { key: "language", label: "Language" },
      { key: "freeText", label: "Free text" },
    ],
  }),
  useDocumentMetadataValueDefinitionsQuery: (
    metadataFieldKey: string | null,
  ) => {
    selectedMetadataField = metadataFieldKey;
    return {
      values: [
        {
          id: "value-1",
          fieldKey: metadataFieldKey ?? "classification",
          key: "public",
          label: "Public",
          description: "Public content",
          color: null,
          icon: null,
          sortOrder: 10,
          isActive: true,
          metadata: {},
        },
      ],
      mutate: mutateMock,
    };
  },
  useUpsertDocumentMetadataValueDefinitionMutation: () => ({
    upsertValue: upsertValueMock,
    isMutating: false,
    error: undefined,
  }),
}));

import { ValueListsTab } from "./value-lists-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

describe("ValueListsTab", () => {
  beforeEach(() => {
    selectedMetadataField = null;
    mutateMock.mockReset().mockResolvedValue(undefined);
    upsertValueMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  test("deactivates values instead of exposing delete semantics", async () => {
    renderWithProvider(<ValueListsTab />);
    expect(screen.queryByRole("button", { name: /delete|remove/i })).toBeNull();

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(upsertValueMock).toHaveBeenCalledTimes(1));
    expect(upsertValueMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "value-1",
        fieldKey: "classification",
        key: "public",
        isActive: false,
      }),
    );
    expect(selectedMetadataField).toBe("classification");
  });

  test("creates for the chosen field only and keeps failed drafts editable", async () => {
    upsertValueMock.mockRejectedValueOnce(new Error("Value rejected"));
    renderWithProvider(<ValueListsTab />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Language" }));
    fireEvent.click(screen.getByTestId("documents-create-value"));
    fireEvent.change(screen.getByLabelText("Key"), { target: { value: "de" } });
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Deutsch" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("Value rejected");
    expect(screen.getByLabelText("Label")).toHaveProperty("value", "Deutsch");
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByTestId("documents-create-value"),
      ),
    );
    expect(upsertValueMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        fieldKey: "language",
        key: "de",
        label: "Deutsch",
        sortOrder: 0,
      }),
    );
    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  test("does not carry a canceled draft into another field's dialog", async () => {
    renderWithProvider(<ValueListsTab />);
    fireEvent.click(screen.getByTestId("documents-create-value"));
    fireEvent.change(screen.getByLabelText("Key"), {
      target: { value: "classification-only" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("radio", { name: "Language" }));
    fireEvent.click(screen.getByTestId("documents-create-value"));
    expect(screen.getByLabelText("Key")).toHaveProperty("value", "");
    expect(upsertValueMock).not.toHaveBeenCalled();
  });
});
