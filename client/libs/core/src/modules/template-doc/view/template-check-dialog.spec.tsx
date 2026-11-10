// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
import { getOrCreateI18n, I18nextProvider } from "@myoxus/i18n";
import { LiveData } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { TemplateCheckDialog } from "./template-check-dialog";

vi.unmock("@myoxus/i18n");
const calls = vi.hoisted(() => ({
  check: vi.fn(),
  locate: vi.fn(),
  openDoc: vi.fn(),
}));
vi.mock("@myoxus/infra", async (original) => ({
  ...(await original<typeof import("@myoxus/infra")>()),
  useService: (service: { name: string }) => {
    if (service.name === "TemplateCheckService") return calls;
    if (service.name === "WorkbenchService")
      return { workbench: { openDoc: calls.openDoc } };
    throw new Error(`Unexpected service ${service.name}`);
  },
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test("source check displays and locates native unfinished and invalid cell fields", async () => {
  const unfinished = {
    kind: "text",
    blockId: "body",
    start: 3,
    length: 1,
    captured: false,
    state: "input-unset",
    complete: false,
    field: {
      type: "input",
      id: "answer",
      definition: { kind: "text", label: "Question", required: true },
      value: null,
    },
  };
  const invalid = {
    kind: "cell",
    blockId: "table",
    rowId: "row",
    columnId: "column",
    start: 4,
    length: 1,
    captured: false,
    state: "invalid",
    complete: false,
    field: {
      type: "input",
      id: "deadline",
      definition: { kind: "date", label: "Deadline", required: false },
      value: "2026-02-30",
    },
  };
  const withDefault = {
    ...unfinished,
    start: 5,
    field: {
      ...unfinished.field,
      id: "default",
      definition: {
        ...unfinished.field.definition,
        label: "Defaulted",
        default: "initial",
      },
    },
  };
  const filledSource = {
    ...unfinished,
    start: 6,
    state: "input-filled",
    field: { ...unfinished.field, id: "filled", value: "source answer" },
  };
  const result = {
    diagnostics: [],
    nativeFields: [unfinished, invalid, withDefault, filledSource],
    stale$: new LiveData(false),
    isCurrent: () => true,
    release: vi.fn(),
  };
  calls.check.mockResolvedValue(result);
  function Fixture() {
    const [open, setOpen] = useState(true);
    const focus = useRef<HTMLButtonElement>(null);
    return (
      <TemplateCheckDialog
        sourceDocId="source"
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={focus}
      />
    );
  }
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <Fixture />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  const rows = await screen.findAllByTestId("template-check-field");
  expect(screen.getByTestId("template-check-summary").textContent).toContain(
    "4",
  );
  expect(rows[0].textContent).toContain("Question");
  expect(rows[0].textContent).toContain(
    "No default; the input can be filled in the target document",
  );
  expect(rows[1].textContent).toContain("Deadline");
  expect(rows[1].textContent).toContain("Invalid field definition or value");
  expect(rows[2].textContent).toContain(
    "The configured default is applied to the target document",
  );
  expect(rows[3].textContent).toContain("The source answer is not copied");
  fireEvent.click(
    within(rows[1]).getByRole("button", { name: "Open source location" }),
  );
  await waitFor(() =>
    expect(calls.locate).toHaveBeenCalledWith(
      result,
      expect.objectContaining({
        kind: "cell",
        blockId: "table",
        rowId: "row",
        columnId: "column",
        start: 4,
        length: 1,
        status: "error",
      }),
    ),
  );
});
