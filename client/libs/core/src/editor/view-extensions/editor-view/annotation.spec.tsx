// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { getOrCreateI18n, I18nextProvider } from "@myoxus/i18n";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, afterAll, expect, test, vi } from "vitest";
import { AnnotationBlock, AnnotationInline } from "./annotation";
import { CalloutTitle } from "./callout";

vi.unmock("@myoxus/i18n");
afterEach(cleanup);

test("native callout title commits on blur, cancels on Escape and becomes non-editable in reading", () => {
  const apply = vi.fn(() => true);
  const focusEditor = vi.fn();
  const view = (readonly = false) => (
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <CalloutTitle
          title="Current title"
          readonly={readonly}
          apply={apply}
          focusEditor={focusEditor}
        />
      </MyoxusUIProvider>
    </I18nextProvider>
  );
  const mounted = render(view());
  fireEvent.click(screen.getByRole("button", { name: "Note" }));
  let input = screen.getByRole("textbox", { name: "Note" });
  input.focus();
  fireEvent.change(input, { target: { value: "Discarded title" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(apply).not.toHaveBeenCalled();
  expect(focusEditor).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Note" }).textContent).toBe(
    "Current title",
  );
  fireEvent.click(screen.getByRole("button", { name: "Note" }));
  input = screen.getByRole("textbox", { name: "Note" });
  input.focus();
  fireEvent.change(input, { target: { value: "Approved title" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "Approved title",
    "Current title",
  );
  expect(focusEditor).toHaveBeenCalledTimes(2);
  mounted.rerender(view(true));
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("Current title").textContent).toBe("Current title");
});
const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");
test("callout settings Escape cancels the type before focus-return blur, while Enter commits", async () => {
  const applySettings = vi.fn(() => true);
  render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <CalloutTitle
          title="Review"
          type="warning"
          foldable
          defaultOpen={false}
          readonly={false}
          apply={vi.fn(() => true)}
          focusEditor={vi.fn()}
          applySettings={applySettings}
        />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  const settings = screen.getByRole("button", { name: "Settings" });
  fireEvent.click(settings);
  const input = await screen.findByRole("textbox", { name: "Callout type" });
  input.focus();
  fireEvent.change(input, { target: { value: "Discarded" } });
  fireEvent.keyDown(input, { key: "Escape" });
  await waitFor(() =>
    expect(screen.queryByRole("textbox", { name: "Callout type" })).toBeNull(),
  );
  expect(applySettings).not.toHaveBeenCalled();
  fireEvent.click(settings);
  const next = await screen.findByRole("textbox", { name: "Callout type" });
  next.focus();
  fireEvent.change(next, { target: { value: "CAUTION" } });
  fireEvent.keyDown(next, { key: "Enter" });
  expect(applySettings).toHaveBeenCalledExactlyOnceWith({
    type: "CAUTION",
    foldable: true,
    defaultOpen: false,
  });
});
test("fold toggles are viewer-only and read-only callouts expose no author settings", () => {
  const props = {
    title: "Review",
    type: "warning",
    foldable: true,
    defaultOpen: false,
    expanded: false,
    readonly: false,
    toggle: vi.fn(),
    applySettings: vi.fn(() => true),
    apply: vi.fn(() => true),
    focusEditor: vi.fn(),
  };
  const view = () => (
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <CalloutTitle {...props} />
      </MyoxusUIProvider>
    </I18nextProvider>
  );
  const mounted = render(view());
  const expand = screen.getByRole("button", { name: "Expand" });
  expect(expand.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(expand);
  expect(props.toggle).toHaveBeenCalledOnce();
  expect(props.applySettings).not.toHaveBeenCalled();
  expect(props.apply).not.toHaveBeenCalled();
  expect(
    screen.getByRole("button", { name: "Settings" }).hasAttribute("disabled"),
  ).toBe(false);
  props.readonly = true;
  props.expanded = true;
  mounted.rerender(view());
  expect(
    screen
      .getByRole("button", { name: "Collapse" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("Review").textContent).toBe("Review");
});
beforeAll(() => {
  // Mantine autosize subscribes to the browser FontFaceSet. Happy-DOM has no
  // implementation; keep the real Textarea and supply only its event boundary.
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: new EventTarget(),
  });
});
afterAll(() => {
  if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
  else Reflect.deleteProperty(document, "fonts");
});

function inlineFixture(readonly = false) {
  const props = {
    id: "a",
    body: "literal **body**\nsecond line",
    readonly,
    apply: vi.fn(() => true),
    remove: vi.fn(() => true),
    focusEditor: vi.fn(),
  };
  const view = () => (
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider env="test">
        <AnnotationInline {...props} />
      </MyoxusUIProvider>
    </I18nextProvider>
  );
  const mounted = render(view());
  return {
    props,
    update: (change: Partial<typeof props>) => {
      Object.assign(props, change);
      mounted.rerender(view());
    },
  };
}

test("inline popover keeps local drafts, writes literal text and returns focus on Escape", async () => {
  const { props, update } = inlineFixture();
  const marker = screen.getByRole("button", { name: "Annotation" });
  fireEvent.click(marker);
  await screen.findByRole("button", { name: "Edit" });
  expect(
    document.querySelector("[data-myoxus-annotation-body]")?.textContent,
  ).toBe(props.body);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  let input = screen.getByRole("textbox", { name: "Annotation" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "discarded" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(props.apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  input = screen.getByRole("textbox", { name: "Annotation" });
  fireEvent.change(input, { target: { value: "changed\n✓" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(props.apply).toHaveBeenCalledExactlyOnceWith(
    "changed\n✓",
    "literal **body**\nsecond line",
  );
  update({ body: "changed\n✓" });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  input = screen.getByRole("textbox", { name: "Annotation" });
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(screen.getByRole("textbox", { name: "Annotation" })).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(marker.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(marker);
});

test("inline stale drafts and readonly previews cannot mutate, keyboard boundaries delegate to the editor", async () => {
  const { props, update } = inlineFixture();
  const marker = screen.getByRole("button", { name: "Annotation" });
  fireEvent.keyDown(marker, { key: "ArrowLeft" });
  fireEvent.keyDown(marker, { key: "ArrowRight" });
  expect(props.focusEditor.mock.calls).toEqual([["before"], ["after"]]);
  fireEvent.click(marker);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Annotation" }), {
    target: { value: "local" },
  });
  update({ body: "remote" });
  expect(
    screen.getByRole("button", { name: "Apply" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("changed");
  update({ readonly: true });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  fireEvent.keyDown(marker, { key: "Delete" });
  expect(props.remove).not.toHaveBeenCalled();
  update({ readonly: false });
  fireEvent.keyDown(marker, { key: "Backspace" });
  expect(props.remove).toHaveBeenCalledExactlyOnceWith("remote");
});

function fixture(body = "Literal **body**\n[[Not a reference]]") {
  const apply = vi.fn(() => true);
  const props = { body, readonly: false, editRequest: 0, apply };
  const mounted = render(
    <I18nextProvider i18n={getOrCreateI18n()}>
      <MyoxusUIProvider>
        <AnnotationBlock {...props} />
      </MyoxusUIProvider>
    </I18nextProvider>,
  );
  return {
    apply,
    update(change: Partial<typeof props>) {
      Object.assign(props, change);
      mounted.rerender(
        <I18nextProvider i18n={getOrCreateI18n()}>
          <MyoxusUIProvider>
            <AnnotationBlock {...props} />
          </MyoxusUIProvider>
        </I18nextProvider>,
      );
    },
  };
}

test("literal body, collapse and cancel remain local; apply writes once and returns focus", () => {
  const { apply } = fixture();
  const body = document.querySelector("[data-myoxus-annotation-body]")!;
  expect(body.textContent).toBe("Literal **body**\n[[Not a reference]]");
  expect(body.querySelector("strong,a")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Collapse" }));
  expect(document.querySelector("[data-myoxus-annotation-body]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  let input = screen.getByRole("textbox", { name: "Annotation" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "discarded" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(apply).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Edit" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  input = screen.getByRole("textbox", { name: "Annotation" });
  expect((input as HTMLTextAreaElement).value).toBe(body.textContent);
  fireEvent.change(input, { target: { value: "changed\nUnicode ✓" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(apply).toHaveBeenCalledExactlyOnceWith(
    "changed\nUnicode ✓",
    body.textContent,
  );
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Edit" }),
  );
});

test("a remote body change cannot overwrite a draft, and readonly removes all mutation controls", () => {
  const { apply, update } = fixture("original");
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const input = screen.getByRole("textbox", { name: "Annotation" });
  fireEvent.change(input, { target: { value: "local draft" } });
  update({ body: "remote edit" });
  expect((input as HTMLTextAreaElement).value).toBe("local draft");
  expect(screen.getByRole("status").textContent).toContain("changed");
  expect(
    (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(apply).not.toHaveBeenCalled();
  update({ readonly: true });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  expect(
    document.querySelector("[data-myoxus-annotation-body]")!.textContent,
  ).toBe("remote edit");
});

test("slash edit requests focus the body; Escape cancels, but composition Escape does not", () => {
  const { apply, update } = fixture("");
  update({ editRequest: 1 });
  const input = screen.getByRole("textbox", { name: "Annotation" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "draft" } });
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(screen.getByRole("textbox")).toBe(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(apply).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Edit" }),
  );
});

test("a rejected authoritative write keeps the draft open", () => {
  const { apply } = fixture("original");
  apply.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  expect(screen.getByRole("textbox")).not.toBeNull();
  expect(apply).toHaveBeenCalledExactlyOnceWith("draft", "original");
});
