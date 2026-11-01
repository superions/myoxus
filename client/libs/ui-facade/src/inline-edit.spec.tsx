// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { InlineEdit, type InlineEditHandle } from "./inline-edit";
import { MyoxusUIProvider } from "./provider";

function renderInlineEdit(
  props: Partial<Parameters<typeof InlineEdit>[0]> = {},
) {
  return render(
    <MyoxusUIProvider>
      <InlineEdit editable value="Draft" placeholder="Untitled" {...props} />
    </MyoxusUIProvider>,
  );
}

describe("facade InlineEdit", () => {
  afterEach(() => cleanup());

  test("uses a semantic Mantine button and commits once from click or Enter", async () => {
    const onInput = vi.fn();
    const onChange = vi.fn();
    const parentClick = vi.fn();

    render(
      <MyoxusUIProvider>
        <div onClick={parentClick}>
          <InlineEdit
            editable
            value="Draft"
            inputAttrs={{
              "aria-label": "Task title",
              className: "consumer-title-input",
            }}
            onChange={onChange}
            onInput={onInput}
          />
        </div>
      </MyoxusUIProvider>,
    );

    const display = screen.getByRole("button", { name: "Task title" });
    expect(display.dataset.myoxusUiRole).toBe("inline-edit-display");
    fireEvent.click(display);
    expect(parentClick).not.toHaveBeenCalled();

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.dataset.myoxusUiRole).toBe("inline-edit-input");
    expect(input.className).toContain("mantine-Input-input");
    expect(input.className).toContain("consumer-title-input");
    expect(document.querySelector(".myoxus-inline-edit__display")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.change(input, { target: { value: "Published title" } });
    expect(onInput).toHaveBeenCalledWith("Published title");

    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Published title");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Task title" }),
      ),
    );
  });

  test("supports Enter and F2 activation while Escape discards the draft", async () => {
    const onChange = vi.fn();

    renderInlineEdit({ onChange });
    const display = screen.getByRole("button", { name: "Draft" });
    fireEvent.keyDown(display, { key: "F2" });
    const enterInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(enterInput, { target: { value: "Enter title" } });
    fireEvent.keyDown(enterInput, { key: "Enter" });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("Enter title"));

    cleanup();
    const onEscapeChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <InlineEdit editable value="Draft" onChange={onEscapeChange} />
      </MyoxusUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Draft" }));
    const escapeInput = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(escapeInput, { target: { value: "Escape title" } });
    fireEvent.keyDown(escapeInput, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(onEscapeChange).not.toHaveBeenCalled();
    expect(screen.getByText("Draft")).not.toBeNull();
  });

  test("retains remote drafts but cancels them on explicit discard or rights loss", async () => {
    const handleRef = createRef<InlineEditHandle>();
    const { rerender } = render(
      <MyoxusUIProvider>
        <InlineEdit editable value="Initial" handleRef={handleRef} />
      </MyoxusUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Initial" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Local draft" },
    });

    rerender(
      <MyoxusUIProvider>
        <InlineEdit editable value="Remote value" handleRef={handleRef} />
      </MyoxusUIProvider>,
    );
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "Local draft",
    );

    handleRef.current?.discardDraft();
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(await screen.findByText("Remote value")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remote value" }));
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "Revoked draft" },
    });
    rerender(
      <MyoxusUIProvider>
        <InlineEdit
          editable={false}
          value="Remote value"
          handleRef={handleRef}
        />
      </MyoxusUIProvider>,
    );
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    rerender(
      <MyoxusUIProvider>
        <InlineEdit editable value="Remote value" handleRef={handleRef} />
      </MyoxusUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remote value" }));
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
      "Remote value",
    );
  });
});
