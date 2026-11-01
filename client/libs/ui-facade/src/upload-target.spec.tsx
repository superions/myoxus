/**
 * @vitest-environment happy-dom
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { UploadTarget } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("UploadTarget", () => {
  test("renders a single facade-owned upload target surface", () => {
    render(
      <MyoxusUIProvider>
        <UploadTarget
          title="Drop file"
          description="Allowed formats: ZIP"
          pickLabel="Choose file"
          onFile={vi.fn()}
          data-testid="upload"
        />
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("upload");
    expect(root.dataset.myoxusUiRole).toBe("button:upload-target");
    expect(root.getAttribute("role")).toBe("button");
    expect(document.querySelector("input[type='file']")).not.toBeNull();
    expect(
      root.querySelector("[data-myoxus-ui-role='button:compact:upload-pick']"),
    ).not.toBeNull();
  });

  test("opens the native file input from root, keyboard and pick button", () => {
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);

    render(
      <MyoxusUIProvider>
        <UploadTarget
          title="Drop file"
          pickLabel="Choose file"
          onFile={vi.fn()}
          data-testid="upload"
        />
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("upload");
    const pick = root.querySelector(
      "[data-myoxus-ui-role='button:compact:upload-pick']",
    );

    fireEvent.click(root);
    fireEvent.keyDown(root, { key: "Enter" });
    fireEvent.keyDown(root, { key: " " });
    fireEvent.click(pick!);

    expect(clickSpy).toHaveBeenCalledTimes(4);
    clickSpy.mockRestore();
  });

  test("updates drag state and emits the first dropped file", () => {
    const onFile = vi.fn();
    render(
      <MyoxusUIProvider>
        <UploadTarget
          title="Drop file"
          pickLabel="Choose file"
          onFile={onFile}
          data-testid="upload"
        />
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("upload");
    const file = new File(["data"], "asset.svg", { type: "image/svg+xml" });

    fireEvent.dragOver(root, {
      dataTransfer: { dropEffect: "copy", files: [] },
    });
    expect(root.dataset.drag).toBe("true");

    fireEvent.drop(root, {
      dataTransfer: { dropEffect: "copy", files: [file] },
    });
    expect(root.dataset.drag).toBe("false");
    expect(onFile).toHaveBeenCalledWith(file);
  });

  test("emits files selected through the hidden input", () => {
    const onFile = vi.fn();
    render(
      <MyoxusUIProvider>
        <UploadTarget
          title="Drop file"
          pickLabel="Choose file"
          onFile={onFile}
          data-testid="upload"
        />
      </MyoxusUIProvider>,
    );

    const input = document.querySelector(
      "input[type='file']",
    ) as HTMLInputElement;
    const file = new File(["data"], "asset.svg", { type: "image/svg+xml" });

    fireEvent.change(input, {
      target: { files: [file] },
    });

    expect(onFile).toHaveBeenCalledWith(file);
  });
});
