import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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

const upsertTypeMock = vi.fn();
const mutateMock = vi.fn();

vi.mock("../api", () => ({
  useDocumentTypesQuery: () => ({
    types: [
      {
        id: "type-1",
        key: "policy",
        label: "Policy",
        description: null,
        icon: null,
        color: null,
        isActive: true,
        isSuggested: true,
      },
    ],
    mutate: mutateMock,
  }),
  useDocumentStatusSchemasQuery: () => ({ schemas: [{ key: "default" }] }),
  useDocumentStatusValuesQuery: () => ({ values: [] }),
  useUpsertDocumentTypeMutation: () => ({
    upsertType: upsertTypeMock,
    isMutating: false,
    error: undefined,
  }),
}));

import { DocumentTypesTab } from "./document-types-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

describe("DocumentTypesTab", () => {
  beforeEach(() => {
    upsertTypeMock.mockReset().mockResolvedValue(undefined);
    mutateMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => cleanup());

  test("deactivates used document types instead of exposing delete", async () => {
    renderWithProvider(<DocumentTypesTab />);
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();

    fireEvent.click(screen.getByRole("switch"));

    await waitFor(() => expect(upsertTypeMock).toHaveBeenCalledTimes(1));
    expect(upsertTypeMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "type-1", key: "policy", isActive: false }),
    );
  });

  test("creates only from the dialog and retains every field after a failed save", async () => {
    upsertTypeMock.mockRejectedValueOnce(new Error("Type write rejected"));
    renderWithProvider(<DocumentTypesTab />);
    expect(screen.queryByLabelText("Key")).toBeNull();
    fireEvent.click(screen.getByTestId("documents-create-type"));
    const dialog = await screen.findByRole("dialog");
    for (const [label, value] of [
      ["Key", "review"],
      ["Label", "Review"],
      ["Description", "Review documents"],
      ["Icon", "file"],
      ["Color", "theme-role"],
    ])
      fireEvent.change(within(dialog).getByLabelText(label), {
        target: { value },
      });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Type write rejected",
    );
    expect(
      (within(dialog).getByLabelText("Label") as HTMLInputElement).value,
    ).toBe("Review");
    expect(upsertTypeMock).toHaveBeenCalledWith({
      key: "review",
      label: "Review",
      description: "Review documents",
      icon: "file",
      color: "theme-role",
      isActive: true,
      isSuggested: true,
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutateMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("cancels without writes and restores the creation trigger focus", async () => {
    renderWithProvider(<DocumentTypesTab />);
    const trigger = screen.getByTestId("documents-create-type");
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.change(await screen.findByLabelText("Label"), {
      target: { value: "Draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect(
      ((await screen.findByLabelText("Label")) as HTMLInputElement).value,
    ).toBe("Draft");
    expect(upsertTypeMock).not.toHaveBeenCalled();
  });

  test("shows a failed activation change without an unhandled rejection", async () => {
    upsertTypeMock.mockRejectedValueOnce(new Error("Activation rejected"));
    renderWithProvider(<DocumentTypesTab />);
    fireEvent.click(screen.getByRole("switch"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Activation rejected",
    );
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });
});
