/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

afterEach(cleanup);

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      key === "admin.config.sensitive.configuredPlaceholder"
        ? "Configured; enter a new value to replace"
        : key,
  }),
}));

import {
  ConfigArrayField,
  ConfigNumberField,
  ConfigTextField,
} from "./config-form-fields";

test("native free-value lists preserve submission, exact duplicates, removal and blur", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(
    <MyoxusUIProvider>
      <ConfigArrayField
        field="security/origins"
        label="Origins"
        defaultValue={["https://one.example"]}
        onChange={onChange}
      />
    </MyoxusUIProvider>,
  );
  const input = screen.getByRole("combobox", { name: "Origins" });
  await user.type(input, "https://two.example{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("security/origins", [
    "https://one.example",
    "https://two.example",
  ]);
  await user.type(input, "https://two.example{Enter}");
  expect(onChange).toHaveBeenLastCalledWith("security/origins", [
    "https://one.example",
    "https://two.example",
  ]);
  await user.keyboard("{Backspace}");
  expect(onChange).toHaveBeenLastCalledWith("security/origins", [
    "https://one.example",
  ]);
  await user.type(input, "https://three.example");
  await user.tab();
  expect(onChange).toHaveBeenLastCalledWith("security/origins", [
    "https://one.example",
    "https://three.example",
  ]);
  fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
  expect(onChange).toHaveBeenLastCalledWith("security/origins", [
    "https://three.example",
  ]);
});

test("native number inputs retain invalid drafts, report bounds and clear to undefined", () => {
  const onChange = vi.fn();
  const onErrorChange = vi.fn();
  render(
    <MyoxusUIProvider>
      <ConfigNumberField
        field="queue/concurrency"
        label="Concurrency"
        defaultValue={5}
        min={1}
        max={10}
        feedback={<span>Owned runtime feedback</span>}
        onChange={onChange}
        onErrorChange={onErrorChange}
      />
    </MyoxusUIProvider>,
  );
  expect(screen.getByText("Owned runtime feedback")).toBeTruthy();
  const input = screen.getByLabelText("Concurrency");
  fireEvent.change(input, { target: { value: "11" } });
  fireEvent.blur(input);
  expect(onChange).toHaveBeenLastCalledWith("queue/concurrency", 11);
  expect(onErrorChange).toHaveBeenLastCalledWith(
    "queue/concurrency",
    "admin.config.validation.maxValue",
  );
  fireEvent.change(input, { target: { value: "" } });
  expect(onChange).toHaveBeenLastCalledWith("queue/concurrency", undefined);
  expect(onErrorChange).toHaveBeenLastCalledWith(
    "queue/concurrency",
    undefined,
  );
});

test("FileOnly native controls cannot produce edits and retain the write-policy explanation", () => {
  const onChange = vi.fn();
  render(
    <MyoxusUIProvider>
      <ConfigTextField
        field="storage/path"
        label="Storage path"
        defaultValue="/data"
        databaseWritable={false}
        restartRequired
        onChange={onChange}
      />
    </MyoxusUIProvider>,
  );
  expect(
    (screen.getByLabelText("Storage path") as HTMLInputElement).disabled,
  ).toBe(true);
  expect(screen.getByText("admin.config.yaml_only_desc").textContent).toBe(
    "admin.config.yaml_only_desc",
  );
  expect(screen.getByText("admin.config.restart_required").textContent).toBe(
    "admin.config.restart_required",
  );
  expect(onChange).not.toHaveBeenCalled();
});

test("descriptorless config fields expose a readable label instead of an internal path", () => {
  render(
    <MyoxusUIProvider>
      <ConfigNumberField
        field="document_graph/maxGraphNodes"
        defaultValue={250}
        onChange={vi.fn()}
      />
    </MyoxusUIProvider>,
  );

  expect(screen.getByText("Max Graph Nodes")).toBeTruthy();
  expect(document.body.textContent).not.toContain(
    "document_graph/maxGraphNodes",
  );
});

test("masked sensitive config is never rendered or resubmitted as the editable value", () => {
  const onChange = vi.fn();
  render(
    <MyoxusUIProvider>
      <ConfigTextField
        field="mailer/SMTP.password"
        label="SMTP password"
        defaultValue="***REDACTED***"
        sensitive
        onChange={onChange}
      />
    </MyoxusUIProvider>,
  );

  const input = screen.getByLabelText("SMTP password") as HTMLInputElement;
  expect(input.value).toBe("");
  expect(input.autocomplete).toBe("new-password");
  expect(input.placeholder).toBe("Configured; enter a new value to replace");
  expect(document.body.textContent).not.toContain("***REDACTED***");

  fireEvent.change(input, { target: { value: " replacement secret " } });
  expect(onChange).toHaveBeenCalledWith(
    "mailer/SMTP.password",
    " replacement secret ",
  );
});
