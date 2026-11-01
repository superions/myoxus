// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRef } from "react";

import {
  MediaPreviewFrame,
  MediaPreviewIcon,
  MediaPreviewImage,
  Progress,
  ProgressSlider,
} from "./index";
import { MyoxusUIProvider } from "./provider";

describe("facade Progress", () => {
  afterEach(() => cleanup());

  test("keeps the value label by default for settings-style progress", () => {
    render(
      <MyoxusUIProvider>
        <Progress value={42} testId="progress-default" />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("progress-default").dataset.myoxusUiRole).toBe(
      "progress",
    );
    const meter = screen.getByLabelText("Progress");
    expect(meter.getAttribute("aria-valuenow")).toBe("42");
    expect(meter.style.getPropertyValue("--progress-section-size")).toBe("42%");
    expect(meter.style.getPropertyValue("--progress-section-color")).toBe(
      "var(--mantine-color-myoxus-filled)",
    );
    expect(screen.getByText("42%")).not.toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  test("keeps slider draft and end-of-interaction callbacks separate", () => {
    const onChange = vi.fn();
    const onChangeEnd = vi.fn();
    render(
      <MyoxusUIProvider>
        <ProgressSlider
          ariaLabel="Task progress"
          value={42}
          onChange={onChange}
          onChangeEnd={onChangeEnd}
          testId="task-progress"
        />
      </MyoxusUIProvider>,
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
    const slider = screen.getByRole("slider", { name: "Task progress" });
    expect(slider.getAttribute("aria-valuenow")).toBe("42");
    expect(slider.getAttribute("aria-valuetext")).toBe("42%");
    fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(43);
    expect(onChangeEnd).toHaveBeenCalledTimes(1);
    expect(onChangeEnd).toHaveBeenCalledWith(43);
  });

  test("renders readonly progress as text without an edit affordance", () => {
    render(
      <MyoxusUIProvider>
        <ProgressSlider ariaLabel="Readonly progress" readonly value={12} />
      </MyoxusUIProvider>,
    );
    expect(screen.getByText("12%")).not.toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  test("can render a compact meter without duplicate numeric text", () => {
    render(
      <MyoxusUIProvider>
        <Progress
          showValueLabel={false}
          value={125}
          color="var(--quota-meter)"
          testId="progress-compact"
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("progress-compact").dataset.myoxusUiRole).toBe(
      "progress",
    );
    const meter = screen.getByLabelText("Progress");
    expect(meter.getAttribute("aria-valuenow")).toBe("100");
    expect(meter.style.getPropertyValue("--progress-section-size")).toBe(
      "100%",
    );
    expect(meter.style.getPropertyValue("--progress-section-color")).toBe(
      "var(--quota-meter)",
    );
    expect(screen.queryByText("100%")).toBeNull();
  });

  test("projects semantic error progress through Mantine's theme palette", () => {
    render(
      <MyoxusUIProvider>
        <Progress
          showValueLabel={false}
          value={82}
          tone="error"
          testId="progress-error"
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("progress-error").dataset.myoxusUiRole).toBe(
      "progress",
    );
    const meter = screen.getByLabelText("Progress");
    expect(meter.getAttribute("aria-valuenow")).toBe("82");
    expect(meter.style.getPropertyValue("--progress-section-color")).toBe(
      "var(--mantine-color-myoxusError-filled)",
    );
  });

  test("exposes Mantine-backed media preview roles for settings grids and attachments", () => {
    const frameRef = createRef<HTMLDivElement>();
    render(
      <MyoxusUIProvider>
        <MediaPreviewFrame
          ref={frameRef}
          id="preview-focus-owner"
          role="group"
          tabIndex={-1}
          aria-label="Document preview"
          data-source="immutable"
          selected
          fit="cover"
          fill
          data-testid="preview-frame"
        >
          <MediaPreviewImage
            src="blob://preview"
            alt="Preview image"
            fit="cover"
          />
        </MediaPreviewFrame>
        <MediaPreviewFrame>
          <MediaPreviewIcon aria-label="Fallback icon" previewSize="file" />
        </MediaPreviewFrame>
      </MyoxusUIProvider>,
    );

    const frame = screen.getByTestId("preview-frame");
    expect(frameRef.current).toBe(frame);
    expect(screen.getByRole("group", { name: "Document preview" })).toBe(frame);
    expect(frame.id).toBe("preview-focus-owner");
    expect(frame.tabIndex).toBe(-1);
    expect(frame.dataset.source).toBe("immutable");
    expect(frame.getAttribute("fit")).toBeNull();
    expect(frame.getAttribute("fill")).toBeNull();
    expect(frame.getAttribute("selected")).toBeNull();
    frameRef.current?.focus();
    expect(document.activeElement).toBe(frame);
    expect(frame.dataset.myoxusUiRole).toBe("media-preview-frame");
    expect(frame.dataset.selected).toBe("true");
    expect(screen.getByRole("img", { name: "Preview image" })).not.toBeNull();
    const icon = screen.getByLabelText("Fallback icon");
    expect(icon.dataset.myoxusUiRole).toBe("media-preview-icon");
  });
});
