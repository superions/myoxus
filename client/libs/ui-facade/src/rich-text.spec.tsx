// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type Editor, mergeAttributes } from "@tiptap/core";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MyoxusUIProvider } from "./provider";
import { RichTextInput } from "./rich-text";

const labels = {
  boldControlLabel: "Bold",
  italicControlLabel: "Italic",
  strikeControlLabel: "Strikethrough",
  codeControlLabel: "Inline code",
  linkControlLabel: "Add link",
  unlinkControlLabel: "Remove link",
  undoControlLabel: "Undo",
  redoControlLabel: "Redo",
};

afterEach(cleanup);

describe("Facade RichTextInput", () => {
  test("exposes the bounded Mantine toolbar through accessible product labels", async () => {
    render(
      <MyoxusUIProvider>
        <RichTextInput
          aria-label="Description"
          labels={labels}
          value={{
            type: "doc",
            content: [
              { type: "paragraph", content: [{ type: "text", text: "Draft" }] },
            ],
          }}
          onChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    const editor = screen.getByLabelText("Description");
    expect(editor.getAttribute("data-myoxus-ui-role")).toBe("input:rich-text");
    for (const label of Object.values(labels)) {
      expect(await screen.findByRole("button", { name: label })).not.toBeNull();
    }
    expect(screen.queryByRole("button", { name: "Heading 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Bullet list" })).toBeNull();
  });

  test("preserves edited canonical content through undo and redo", async () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <RichTextInput
          aria-label="Description"
          labels={labels}
          value={{ type: "doc", content: [{ type: "paragraph" }] }}
          onChange={onChange}
        />
      </MyoxusUIProvider>,
    );
    const editor = await waitFor(() => {
      const element = document.querySelector(".ProseMirror") as
        (HTMLElement & { editor: Editor }) | null;
      expect(element?.editor).toBeDefined();
      return element!.editor;
    });
    const content = [
      { type: "text", text: "Edited", marks: [{ type: "bold" }] },
      { type: "hardBreak" },
      { type: "text", text: "Next line" },
    ];
    act(() => {
      editor.commands.insertContent(content);
    });
    const edited = {
      type: "doc",
      content: [{ type: "paragraph", content }],
    };
    expect(onChange).toHaveBeenLastCalledWith(edited);
    act(() => {
      expect(editor.commands.undo()).toBe(true);
    });
    expect(onChange).toHaveBeenLastCalledWith({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    act(() => {
      expect(editor.commands.redo()).toBe(true);
    });
    expect(onChange).toHaveBeenLastCalledWith(edited);
    expect(document.querySelector("strong")?.textContent).toBe("Edited");
    expect(document.querySelector(".ProseMirror")?.textContent).toBe(
      "EditedNext line",
    );
  });

  test("removes mutation controls when the shared input is read-only", async () => {
    render(
      <MyoxusUIProvider>
        <RichTextInput
          aria-label="Description"
          labels={labels}
          readOnly
          value={{ type: "doc", content: [{ type: "paragraph" }] }}
          onChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    await waitFor(() =>
      expect(screen.getByLabelText("Description")).not.toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "Bold" })).toBeNull();
    expect(
      document.querySelector(".ProseMirror")?.getAttribute("contenteditable"),
    ).toBe("false");
  });

  test("renders every canonical mark and synchronizes a server value change", async () => {
    const { rerender } = render(
      <MyoxusUIProvider>
        <RichTextInput
          aria-label="Description"
          labels={labels}
          readOnly
          value={{
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Bold", marks: [{ type: "bold" }] },
                  {
                    type: "text",
                    text: " italic",
                    marks: [{ type: "italic" }],
                  },
                  {
                    type: "text",
                    text: " strike",
                    marks: [{ type: "strike" }],
                  },
                  { type: "text", text: " code", marks: [{ type: "code" }] },
                  { type: "hardBreak" },
                  {
                    type: "text",
                    text: "link",
                    marks: [
                      {
                        type: "link",
                        attrs: { href: "https://example.test/spec" },
                      },
                    ],
                  },
                ],
              },
            ],
          }}
          onChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    await waitFor(() =>
      expect(document.querySelector("strong")).not.toBeNull(),
    );
    expect(document.querySelector("em")?.textContent).toBe(" italic");
    expect(document.querySelector("s")?.textContent).toBe(" strike");
    expect(document.querySelector("code")?.textContent).toBe(" code");
    expect(document.querySelector("br")).not.toBeNull();
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.test/spec",
    );

    rerender(
      <MyoxusUIProvider>
        <RichTextInput
          aria-label="Description"
          labels={labels}
          readOnly
          value={{
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Remote canonical value" }],
              },
            ],
          }}
          onChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );
    await waitFor(() =>
      expect(document.querySelector(".ProseMirror")?.textContent).toBe(
        "Remote canonical value",
      ),
    );
  });

  test("keeps hostile attributes inert while preserving supported link content", async () => {
    const hostileAttributes = JSON.parse(
      '{"href":"https://example.test/safe","target":"_self","class":"injected","__proto__":{"polluted":true}}',
    ) as Record<string, unknown>;
    const merged = mergeAttributes({}, hostileAttributes);

    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(Object.hasOwn(merged, "__proto__")).toBe(true);
    expect((merged as { polluted?: boolean }).polluted).toBeUndefined();

    render(
      <MyoxusUIProvider>
        <RichTextInput
          aria-label="Description"
          labels={labels}
          readOnly
          value={{
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  {
                    type: "text",
                    text: "Safe link",
                    marks: [{ type: "link", attrs: hostileAttributes }],
                  },
                ],
              },
            ],
          }}
          onChange={vi.fn()}
        />
      </MyoxusUIProvider>,
    );

    const link = await waitFor(() => {
      const rendered = document.querySelector("a");
      expect(rendered).not.toBeNull();
      return rendered;
    });
    expect(link?.getAttribute("href")).toBe("https://example.test/safe");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("class")).toBeNull();
    expect(
      (Object.prototype as { polluted?: boolean }).polluted,
    ).toBeUndefined();
  });
});
