// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { getOrCreateI18n, I18nextProvider } from "@myoxus/i18n";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { DocumentFieldSchema } from "@virgultum/shared/types";
import { afterEach, expect, test, vi } from "vitest";
import { DocumentFieldInline } from "./document-field";

const context = vi.hoisted(() => ({ current: null as unknown }));
vi.mock(
  "@myoxus/core/editor/virgultum/doc-editor/document-field-presentation",
  () => ({
    useDocumentFieldPresentation: () => context.current,
  }),
);
vi.unmock("@myoxus/i18n");
afterEach(cleanup);

test("inline fields distinguish owned answers, unset, unavailable and source metadata", () => {
  const input = DocumentFieldSchema.parse({
    type: "input",
    id: "answer",
    definition: { kind: "text", label: "Topic", required: true },
    value: null,
  });
  const metadata = DocumentFieldSchema.parse({
    type: "metadata",
    id: "status",
    key: "status",
    format: "text",
  });
  if (input.type !== "input" || metadata.type !== "metadata")
    throw new Error("invalid test field");
  const preferences = {
    locale: "en",
    timezone: "UTC",
    dateFormat: "locale",
    timeFormat: "locale",
  };
  const state = (template: boolean, projection: unknown) => ({
    template,
    projection,
    preferences,
  });
  context.current = state(false, { state: "pending", values: new Map() });
  const view = (field: typeof input | typeof metadata, readonly = false) => (
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={readonly}
          convertToText={vi.fn()}
          updateDefinition={vi.fn()}
          updateValue={vi.fn()}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>
  );
  const mounted = render(view(input));
  expect(screen.getByLabelText("Topic: required, not set").textContent).toBe(
    "Topic",
  );
  mounted.rerender(
    view(DocumentFieldSchema.parse({ ...input, value: "Literal {{answer}}" })),
  );
  expect(screen.getByLabelText("Topic: Literal {{answer}}").textContent).toBe(
    "Literal {{answer}}",
  );
  context.current = state(false, {
    state: "ready",
    values: new Map([
      [
        metadata.id,
        {
          state: "UNSET",
          text: "Not set",
          descriptor: JSON.stringify(metadata),
        },
      ],
    ]),
  });
  mounted.rerender(view(metadata));
  expect(screen.getByLabelText("Status: not set").textContent).toBe("—");
  context.current = state(false, {
    state: "ready",
    values: new Map([
      [
        metadata.id,
        {
          state: "UNAVAILABLE",
          text: null,
          descriptor: JSON.stringify(metadata),
        },
      ],
    ]),
  });
  mounted.rerender(view(metadata, true));
  expect(screen.getByLabelText("Status: value unavailable").textContent).toBe(
    "—",
  );
  context.current = state(true, { state: "pending", values: new Map() });
  mounted.rerender(view(metadata));
  expect(
    screen.getByLabelText("Status: value from the created document")
      .textContent,
  ).toBe("Status");
  const number = DocumentFieldSchema.parse({
    type: "metadata",
    id: "number",
    key: "versionNumber",
    format: "text",
  });
  mounted.rerender(view(number));
  expect(
    screen.getByLabelText("Version number: value from the created document")
      .textContent,
  ).toBe("Version number");
});

test("conversion verifies values and removal deletes the occurrence without resolving it", async () => {
  const input = DocumentFieldSchema.parse({
    type: "input",
    id: "input",
    definition: { kind: "text", label: "Topic", required: true },
    value: null,
  });
  const metadata = DocumentFieldSchema.parse({
    type: "metadata",
    id: "status",
    key: "status",
    format: "text",
  });
  const convert = vi.fn(() => true);
  const verifyMetadata = vi.fn(async () => false);
  const openMetadata = vi.fn(
    (_ref: { current: HTMLElement | null }, _readonly: boolean) => {},
  );
  context.current = {
    template: false,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: {
      state: "ready",
      values: new Map([
        [
          metadata.id,
          {
            state: "VALUE",
            text: "Current",
            descriptor: JSON.stringify(metadata),
          },
        ],
      ]),
    },
    verifyMetadata,
    openMetadata,
  };
  const view = (field: typeof input, readonly = false) => (
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={readonly}
          convertToText={convert}
          updateDefinition={vi.fn()}
          updateValue={vi.fn()}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>
  );
  const mounted = render(view(input));
  fireEvent.click(
    screen.getByRole("button", { name: "Topic: required, not set" }),
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Convert to text" }), {
    key: "Escape",
  });
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Convert to text" }),
    ).toBeNull(),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Topic: required, not set" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Convert to text" }));
  await waitFor(() => expect(convert).toHaveBeenCalledWith(input, ""));
  mounted.rerender(view(metadata));
  fireEvent.click(screen.getByRole("button", { name: "Status: Current" }));
  fireEvent.click(screen.getByRole("button", { name: "Convert to text" }));
  await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  expect(verifyMetadata).toHaveBeenCalledWith(metadata, "Current");
  expect(convert).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(convert).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(convert).toHaveBeenLastCalledWith(metadata, ""));
  expect(verifyMetadata).toHaveBeenCalledTimes(1);
  mounted.rerender(view(metadata, true));
  const readonlyField = screen.getByRole("button", { name: "Status: Current" });
  fireEvent.click(readonlyField);
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Convert to text" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open metadata" }));
  await waitFor(() => expect(openMetadata).toHaveBeenCalledOnce());
  expect(openMetadata.mock.calls[0][0].current).toBe(readonlyField);
  expect(openMetadata.mock.calls[0][1]).toBe(true);
});

test("source definition drafts preserve identities and refuse a stale occurrence", async () => {
  const field = DocumentFieldSchema.parse({
    type: "input",
    id: "decision",
    definition: {
      kind: "single-select",
      label: "Decision",
      required: false,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
      default: "yes",
    },
    value: "no",
  });
  const updateDefinition = vi.fn(() => false);
  context.current = {
    template: true,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: { state: "pending", values: new Map() },
  };
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={false}
          convertToText={vi.fn()}
          updateDefinition={updateDefinition}
          updateValue={vi.fn()}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Decision: Yes" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit definition" }));
  fireEvent.change(screen.getByLabelText(/Field label/), {
    target: { value: "Outcome" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Move option 2 up" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(updateDefinition).toHaveBeenCalledWith(
      field,
      expect.objectContaining({
        id: "decision",
        value: "no",
        definition: expect.objectContaining({
          label: "Outcome",
          default: "yes",
          options: [
            { id: "no", label: "No" },
            { id: "yes", label: "Yes" },
          ],
        }),
      }),
    ),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The field changed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(updateDefinition).toHaveBeenCalledOnce();
});

test("text field drafts commit literal answers and reject a stale occurrence", async () => {
  const field = DocumentFieldSchema.parse({
    type: "input",
    id: "answer",
    definition: { kind: "text", label: "Topic", required: true },
    value: null,
  });
  const updateValue = vi.fn(() => true);
  context.current = {
    template: true,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: { state: "pending", values: new Map() },
  };
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={false}
          textProtected
          convertToText={vi.fn()}
          updateDefinition={vi.fn()}
          updateValue={updateValue}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Topic: required, not set" }),
  );
  expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Convert to text" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: "Topic" }), {
    target: { value: "  {{literal}}  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Topic" })).toBeNull(),
  );
  expect(updateValue).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Topic: required, not set" }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "Topic" }), {
    target: { value: "  {{literal}}  " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(updateValue).toHaveBeenCalledWith(field, {
      ...field,
      value: "  {{literal}}  ",
    }),
  );
  updateValue.mockReturnValue(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Topic: required, not set" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  await waitFor(() =>
    expect(updateValue).toHaveBeenLastCalledWith(field, field),
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "The field changed",
  );
});

test("multiple-selection draft commits selected identities and cancels without writing", async () => {
  const field = DocumentFieldSchema.parse({
    type: "input",
    id: "members",
    definition: {
      kind: "multi-select",
      label: "Members",
      required: false,
      options: [
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
      ],
    },
    value: ["alpha"],
  });
  const updateValue = vi.fn(() => true);
  context.current = {
    template: false,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: { state: "pending", values: new Map() },
  };
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={false}
          convertToText={vi.fn()}
          updateDefinition={vi.fn()}
          updateValue={updateValue}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Members: Alpha" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Members" }));
  fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Members" })).toBeNull(),
  );
  expect(updateValue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Members: Alpha" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Members" }));
  fireEvent.click(await screen.findByRole("option", { name: "Beta" }));
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(updateValue).toHaveBeenCalledWith(field, {
      ...field,
      value: ["alpha", "beta"],
    }),
  );
});

test("single selection commits the option identity without another Apply", async () => {
  const field = DocumentFieldSchema.parse({
    type: "input",
    id: "decision",
    definition: {
      kind: "single-select",
      label: "Decision",
      required: true,
      options: [
        { id: "approved", label: "Approved" },
        { id: "deferred", label: "Deferred" },
      ],
    },
    value: null,
  });
  const updateValue = vi.fn(() => true);
  context.current = {
    template: false,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: { state: "pending", values: new Map() },
  };
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={false}
          updateValue={updateValue}
          convertToText={vi.fn()}
          updateDefinition={vi.fn()}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Decision: required, not set" }),
  );
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  fireEvent.click(screen.getByRole("combobox", { name: "Decision" }));
  fireEvent.click(await screen.findByRole("option", { name: "Approved" }));
  await waitFor(() =>
    expect(updateValue).toHaveBeenCalledWith(field, {
      ...field,
      value: "approved",
    }),
  );
});

test("calendar field commits an accepted date while incomplete input stays local", async () => {
  const field = DocumentFieldSchema.parse({
    type: "input",
    id: "deadline",
    definition: { kind: "date", label: "Deadline", required: true },
    value: null,
  });
  const updateValue = vi.fn(() => true);
  context.current = {
    template: false,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: { state: "pending", values: new Map() },
  };
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={false}
          updateValue={updateValue}
          convertToText={vi.fn()}
          updateDefinition={vi.fn()}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Deadline: required, not set" }),
  );
  const input = screen.getByRole("textbox", { name: "Deadline" });
  fireEvent.change(input, { target: { value: "unfinished" } });
  expect(updateValue).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
  fireEvent.change(input, { target: { value: "11/06/2026" } });
  await waitFor(() =>
    expect(updateValue).toHaveBeenCalledWith(field, {
      ...field,
      value: "2026-11-06",
    }),
  );
});

test("date-time edits remain local until native confirmation", async () => {
  const field = DocumentFieldSchema.parse({
    type: "input",
    id: "starts",
    definition: { kind: "datetime", label: "Starts", required: false },
    value: "2026-11-06 10:30:00",
  });
  const updateValue = vi.fn(() => true);
  context.current = {
    template: false,
    preferences: {
      locale: "en",
      timezone: "UTC",
      dateFormat: "locale",
      timeFormat: "locale",
    },
    projection: { state: "pending", values: new Map() },
  };
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <DocumentFieldInline
          field={field}
          readonly={false}
          updateValue={updateValue}
          convertToText={vi.fn()}
          updateDefinition={vi.fn()}
          focusEditor={vi.fn()}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: /^Starts:/ }));
  fireEvent.click(screen.getByLabelText("Starts"));
  const hours = await screen.findByLabelText("Hour");
  fireEvent.change(hours, { target: { value: "11" } });
  fireEvent.blur(hours);
  expect(updateValue).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(updateValue).toHaveBeenCalledWith(field, {
      ...field,
      value: "2026-11-06 11:30:00",
    }),
  );
});
