/** @vitest-environment happy-dom */
import { notify } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
const en: Record<string, string> = enJson;
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ language: "en", t: (key: string) => en[key] ?? key }),
}));
let organization = {
  name: "Myoxus Organisation",
  slug: "myoxus",
  key: "immutable-key",
  createdAt: "2026-08-11T00:00:00Z",
};
const updateTrigger = vi.fn();
const mutate = vi.fn();
vi.mock("./api", () => ({
  useOrganizationQuery: () => ({ organization, mutate }),
  useUpdateOrganizationMutation: () => ({
    trigger: updateTrigger,
    isMutating: false,
  }),
}));
import { OverviewTab } from "./overview-tab";

beforeEach(() => {
  organization = {
    name: "Myoxus Organisation",
    slug: "myoxus",
    key: "immutable-key",
    createdAt: "2026-08-11T00:00:00Z",
  };
  updateTrigger.mockReset().mockResolvedValue(undefined);
  mutate.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  notify.dismiss();
});

function view(mode: "visible" | "hidden" = "visible") {
  return (
    <MyoxusUIProvider>
      <Activity mode={mode}>
        <OverviewTab />
      </Activity>
    </MyoxusUIProvider>
  );
}

describe("Organization overview", () => {
  test("preserves drafts across query updates and retained-tab reactivation", () => {
    const { rerender } = render(view());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Unsaved organization" },
    });
    organization = { ...organization, name: "Server refresh" };
    rerender(view("hidden"));
    rerender(view());
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Unsaved organization",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Server refresh",
    );
    expect(updateTrigger).not.toHaveBeenCalled();
  });

  test("submits only editable metadata and waits for readback before clearing dirty state", async () => {
    let finishReadback!: () => void;
    mutate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishReadback = resolve;
        }),
    );
    render(view());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Updated organization" },
    });
    fireEvent.click(screen.getByTestId("organization-save-button"));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    expect(updateTrigger).toHaveBeenCalledWith({
      input: { name: "Updated organization", slug: "myoxus" },
    });
    expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(
      true,
    );
    finishReadback();
    await waitFor(() =>
      expect((screen.getByLabelText("Name") as HTMLInputElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByText(en["admin.state.unsaved-changes"])).toBeNull();
  });

  test("keeps rejected drafts visible and supports reset", async () => {
    updateTrigger.mockRejectedValueOnce(
      new Error("Organization write rejected"),
    );
    render(view());
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Retained draft" },
    });
    fireEvent.click(screen.getByTestId("organization-save-button"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Organization write rejected",
    );
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Retained draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Myoxus Organisation",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
