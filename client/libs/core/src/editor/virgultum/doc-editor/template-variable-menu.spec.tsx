// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { TemplateVariablePicker } from "./template-variable-picker";

vi.mock("@myoxus/i18n", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  return {
    ...actual,
    i18nTime: () => "timestamp",
    useI18n: () => ({
      "com.myoxus.peek-view-controls.close": () => "Close",
      "com.myoxus.template-input.custom-name": () => "Custom input name",
      "com.myoxus.template-input.insert": () => "Insert input",
      "com.myoxus.cmdk.no-results": () => "com.myoxus.cmdk.no-results",
      "com.myoxus.common.operation-failed": () =>
        "com.myoxus.common.operation-failed",
      "com.myoxus.error.retry": () => "com.myoxus.error.retry",
      "com.myoxus.loading": () => "com.myoxus.loading",
      t: (value: unknown) => {
        if (typeof value === "object" && value !== null && "i18nKey" in value) {
          return String((value as { i18nKey: string }).i18nKey);
        }
        return String(value);
      },
    }),
  };
});

vi.unstubAllGlobals();
afterEach(cleanup);

function open() {
  let writable = true;
  const insert = vi.fn();
  const onClose = vi.fn();
  render(
    <MyoxusUIProvider>
      <TemplateVariablePicker
        request={{
          canWrite: () => writable,
          insert,
          onClose,
        }}
        onClosed={() => {}}
      />
    </MyoxusUIProvider>,
  );
  return {
    insert,
    onClose,
    deny: () => {
      writable = false;
    },
  };
}

test("chooser searches the shared catalogue and inserts through keyboard selection", async () => {
  const fixture = open();
  expect(screen.getByRole("group", { name: "Workspace" })).not.toBeNull();
  const creationTime = screen.getByRole("option", {
    name: /document.created_at.datetime/,
  });
  expect(creationTime.querySelector("[data-truncate]")).toBeNull();
  expect(screen.getByRole("group", { name: "Actor" })).not.toBeNull();
  expect(screen.queryByRole("option", { name: /member\.name/ })).toBeNull();
  fireEvent.change(
    screen.getByPlaceholderText("Search variables or type input.name"),
    {
      target: { value: "{{workspace.name}}" },
    },
  );
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option").textContent).toContain("Current workspace");
  expect(screen.getByRole("option").textContent).toContain("Web and Electron");
  fireEvent.keyDown(screen.getByTestId("cmdk-quick-search"), { key: "Enter" });
  await waitFor(() =>
    expect(fixture.insert).toHaveBeenCalledExactlyOnceWith(
      "{{workspace.name}}",
    ),
  );
  await waitFor(() => expect(fixture.onClose).toHaveBeenCalledOnce());
});

test("chooser rechecks write access before committing a pointer selection", async () => {
  const fixture = open();
  fixture.deny();
  fireEvent.click(screen.getByRole("option", { name: /Workspace name/ }));
  expect(fixture.insert).not.toHaveBeenCalled();
  await waitFor(() => expect(fixture.onClose).toHaveBeenCalledOnce());
});

test("custom inputs use the same keyboard chooser and reject nested names", async () => {
  const fixture = open();
  const search = screen.getByPlaceholderText(
    "Search variables or type input.name",
  );
  for (const name of ["input.", "input.project.nested", "input.1project"]) {
    fireEvent.change(search, { target: { value: name } });
    expect(screen.queryByRole("option")).toBeNull();
  }
  fireEvent.change(search, { target: { value: "input.project_name" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.keyDown(screen.getByTestId("cmdk-quick-search"), { key: "Enter" });
  await waitFor(() =>
    expect(fixture.insert).toHaveBeenCalledExactlyOnceWith(
      "{{input.project_name}}",
    ),
  );
});
