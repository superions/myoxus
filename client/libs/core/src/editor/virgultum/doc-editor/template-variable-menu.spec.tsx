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
      "com.myoxus.editor.field.document-fields": () => "Document fields",
      "com.myoxus.editor.field.search": () => "Search document fields",
      "com.myoxus.editor.field.insert-mixed": () => "Insert field or variable",
      "com.myoxus.editor.field.search-mixed": () =>
        "Search fields or variables",
      "com.myoxus.editor.field.input-fields": () => "Input fields",
      "com.myoxus.editor.field.definition": () => "Input field definition",
      "com.myoxus.editor.field.label": () => "Field label",
      "com.myoxus.editor.field.use-default": () => "Set a default value",
      "com.myoxus.editor.field.default-value": () => "Default value",
      "com.myoxus.editor.field.single-select": () => "Single selection",
      "com.myoxus.editor.field.multi-select": () => "Multiple selection",
      "com.myoxus.editor.field.option-label": ({
        number,
      }: {
        number: string;
      }) => `Option ${number}`,
      "com.myoxus.editor.field.add-option": () => "Add option",
      "com.myoxus.editor.field.remove-option": ({
        number,
      }: {
        number: string;
      }) => `Remove option ${number}`,
      "com.myoxus.editor.field.option-up": ({ number }: { number: string }) =>
        `Move option ${number} up`,
      "com.myoxus.editor.field.option-down": ({ number }: { number: string }) =>
        `Move option ${number} down`,
      "com.myoxus.editor.field.invalid-definition": () => "Invalid definition",
      "com.myoxus.common.description": () => "Description",
      "com.myoxus.page-properties.property.required": () => "Required",
      "com.myoxus.common.name": () => "Name",
      "com.myoxus.settings.email": () => "Email",
      Text: () => "Text",
      Date: () => "Date",
      Time: () => "Time",
      Cancel: () => "Cancel",
      Apply: () => "Apply",
      Delete: () => "Delete",
      "com.myoxus.common.date-time": () => "Date and time",
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
vi.mock("./document-field-labels", () => ({
  documentFieldLabels: () => ({ status: "Status" }),
}));

vi.unstubAllGlobals();
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

test("ordinary documents insert an authorized catalog field on LAN HTTP, not a static token", async () => {
  const nativeCrypto = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
  });
  let writable = true;
  const insert = vi.fn();
  const insertField = vi.fn();
  const request = {
    templateSource: false,
    canWrite: () => writable,
    insert,
    insertField,
    onClose: vi.fn(),
  };
  const catalog = {
    metadata: [{ key: "status", formats: ["text", "invalid"] }],
    inputKinds: [],
    maxOptions: 100,
    maxStringBytes: 8192,
    maxIdBytes: 128,
  };
  const view = () => (
    <MyoxusUIProvider>
      <TemplateVariablePicker
        request={request}
        catalog={catalog}
        onClosed={() => {}}
      />
    </MyoxusUIProvider>
  );
  const mounted = render(view());
  expect(
    screen.getByRole("group", { name: "Document fields" }).textContent,
  ).toContain("Status");
  expect(screen.queryByRole("group", { name: "Workspace" })).toBeNull();
  expect(screen.getAllByRole("option")).toHaveLength(1);
  fireEvent.click(screen.getByRole("option", { name: /Status/ }));
  await waitFor(() => expect(insertField).toHaveBeenCalledOnce());
  expect(insertField.mock.calls[0][0]).toMatchObject({
    type: "metadata",
    key: "status",
    format: "text",
  });
  expect(insert).not.toHaveBeenCalled();
  mounted.unmount();

  insertField.mockClear();
  writable = false;
  render(view());
  fireEvent.click(screen.getByRole("option", { name: /Status/ }));
  await waitFor(() => expect(request.onClose).toHaveBeenCalledTimes(2));
  expect(insertField).not.toHaveBeenCalled();
});

test("template source retains static variables alongside native document fields", () => {
  render(
    <MyoxusUIProvider>
      <TemplateVariablePicker
        request={{
          templateSource: true,
          canWrite: () => true,
          insert: vi.fn(),
          insertField: vi.fn(),
          onClose: vi.fn(),
        }}
        catalog={{
          metadata: [{ key: "status", formats: ["text"] }],
          inputKinds: [{ kind: "text", multiple: false, hasOptions: false }],
          maxOptions: 100,
          maxStringBytes: 8192,
          maxIdBytes: 128,
        }}
        onClosed={() => {}}
      />
    </MyoxusUIProvider>,
  );
  expect(
    screen.getByRole("group", { name: "Document fields" }).textContent,
  ).toContain("Status");
  expect(
    screen.getByRole("group", { name: "Input fields" }).textContent,
  ).toContain("Text");
  expect(
    screen.getByRole("group", { name: "Workspace" }).textContent,
  ).toContain("workspace.name");
  fireEvent.change(screen.getByPlaceholderText("Search fields or variables"), {
    target: { value: "input fields" },
  });
  expect(screen.getByRole("option", { name: "Text" }).textContent).toBe("Text");
});

test("authored selection defaults keep stable identities through option reorder", async () => {
  const insertField = vi.fn();
  render(
    <MyoxusUIProvider>
      <TemplateVariablePicker
        request={{
          templateSource: true,
          canWrite: () => true,
          insert: vi.fn(),
          insertField,
          onClose: vi.fn(),
        }}
        catalog={{
          metadata: [],
          inputKinds: [
            { kind: "single-select", multiple: false, hasOptions: true },
          ],
          maxOptions: 100,
          maxStringBytes: 8192,
          maxIdBytes: 128,
        }}
        onClosed={() => {}}
      />
    </MyoxusUIProvider>,
  );
  fireEvent.click(screen.getByRole("option", { name: "Single selection" }));
  fireEvent.change(screen.getByLabelText(/Field label/), {
    target: { value: "Decision" },
  });
  fireEvent.change(screen.getByLabelText(/Option 1/), {
    target: { value: "Approve" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add option" }));
  fireEvent.change(screen.getByLabelText(/Option 2/), {
    target: { value: "Approve" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByRole("alert").textContent).toContain("Invalid definition");
  expect(insertField).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Option 2/), {
    target: { value: "Reject" },
  });
  fireEvent.click(screen.getByLabelText("Set a default value"));
  fireEvent.click(screen.getByRole("combobox", { name: "Default value" }));
  fireEvent.click(screen.getByRole("option", { name: "Reject" }));
  fireEvent.click(screen.getByRole("button", { name: "Move option 2 up" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(insertField).toHaveBeenCalledOnce());
  const field = insertField.mock.calls[0][0];
  expect(field).toMatchObject({
    type: "input",
    value: null,
    definition: {
      kind: "single-select",
      label: "Decision",
      options: [{ label: "Reject" }, { label: "Approve" }],
    },
  });
  expect(field.definition.default).toBe(field.definition.options[0].id);
  expect(field.definition.options[0].id).not.toBe(
    field.definition.options[1].id,
  );
});

test("authored multiple-selection defaults retain more than one independent choice", async () => {
  const insertField = vi.fn();
  render(
    <MyoxusUIProvider>
      <TemplateVariablePicker
        request={{
          templateSource: true,
          canWrite: () => true,
          insert: vi.fn(),
          insertField,
          onClose: vi.fn(),
        }}
        catalog={{
          metadata: [],
          inputKinds: [
            { kind: "multi-select", multiple: true, hasOptions: true },
          ],
          maxOptions: 100,
          maxStringBytes: 8192,
          maxIdBytes: 128,
        }}
        onClosed={() => {}}
      />
    </MyoxusUIProvider>,
  );
  fireEvent.click(screen.getByRole("option", { name: "Multiple selection" }));
  fireEvent.change(screen.getByLabelText(/Field label/), {
    target: { value: "Reviewers" },
  });
  fireEvent.change(screen.getByLabelText(/Option 1/), {
    target: { value: "Alpha" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add option" }));
  fireEvent.change(screen.getByLabelText(/Option 2/), {
    target: { value: "Beta" },
  });
  fireEvent.click(screen.getByLabelText("Set a default value"));
  fireEvent.click(screen.getByRole("combobox", { name: "Default value" }));
  fireEvent.click(screen.getByRole("option", { name: "Alpha" }));
  fireEvent.click(screen.getByRole("option", { name: "Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(insertField).toHaveBeenCalledOnce());
  const field = insertField.mock.calls[0][0];
  expect(field.value).toEqual([]);
  expect(field.definition.default).toEqual(
    field.definition.options.map((option: { id: string }) => option.id),
  );
});

test.each([
  ["text", 0, "{{input.project_name}}"],
  ["date", 1, "{{input.date.project_name}}"],
  ["datetime", 2, "{{input.datetime.project_name}}"],
] as const)(
  "custom %s inputs use the keyboard chooser and reject arbitrary nested names",
  async (_kind, index, token) => {
    const fixture = open();
    const search = screen.getByPlaceholderText(
      "Search variables or type input.name",
    );
    for (const name of ["input.", "input.project.nested", "input.1project"]) {
      fireEvent.change(search, { target: { value: name } });
      expect(screen.queryByRole("option")).toBeNull();
    }
    fireEvent.change(search, { target: { value: "input.project_name" } });
    expect(screen.getAllByRole("option")).toHaveLength(3);
    for (let step = 0; step < index; step++) {
      fireEvent.keyDown(screen.getByTestId("cmdk-quick-search"), {
        key: "ArrowDown",
      });
    }
    fireEvent.keyDown(screen.getByTestId("cmdk-quick-search"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(fixture.insert).toHaveBeenCalledExactlyOnceWith(token),
    );
  },
);
