// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";

import { MyoxusUIProvider } from "../../provider";
import { afterEach, describe, expect, test, vi } from "vitest";

import { GanttView } from "./gantt-view";
import type { GanttViewProps } from "./gantt-view";

const DAY = 86_400_000;
const START = Date.UTC(2026, 0, 1);

function baseProps(overrides: Partial<GanttViewProps> = {}): GanttViewProps {
  return {
    axis: {
      end: START + 10 * DAY,
      start: START,
      step: DAY,
      ticks: [
        { label: "01", value: START },
        { label: "08", value: START + 7 * DAY },
      ],
      valueLabel: (value) => new Date(value).toISOString().slice(0, 10),
    },
    labels: {
      empty: "Add section",
      region: "Gantt",
      reorderSection: "Reorder section",
      reorderTask: "Reorder task",
    },
    sections: [
      { id: "s1", label: "Work", order: 0 },
      { id: "s2", label: "Ship", order: 1 },
    ],
    tasks: [
      {
        connect: { enabled: true },
        end: START + 3 * DAY,
        id: "t1",
        label: "Design",
        move: { enabled: true },
        resize: { edges: ["start", "end"], enabled: true },
        sectionId: "s1",
        start: START,
        statuses: ["done"],
      },
      {
        connect: { enabled: true },
        end: START + 6 * DAY,
        id: "t1b",
        label: "Harden",
        move: { enabled: true },
        resize: { edges: ["start", "end"], enabled: true },
        sectionId: "s1",
        start: START + 5 * DAY,
        statuses: [],
      },
      {
        connect: { enabled: true },
        end: START + 8 * DAY,
        id: "t2",
        label: "Build",
        move: { enabled: true },
        resize: { edges: ["start", "end"], enabled: true },
        sectionId: "s2",
        start: START + 4 * DAY,
        statuses: [],
      },
    ],
    dependencies: [
      { fromTaskId: "t1", id: "d1", kind: "after", toTaskId: "t2" },
    ],
    ...overrides,
  };
}

function renderView(element: ReactElement) {
  return render(<MyoxusUIProvider>{element}</MyoxusUIProvider>);
}

afterEach(cleanup);

describe("GanttView", () => {
  test("a pointer drag previews and then commits exactly one move intent", () => {
    const onPreviewMove = vi.fn();
    const onCommitMove = vi.fn();
    const props = baseProps({ onCommitMove, onPreviewMove });
    renderView(
      <GanttView {...props} axis={{ ...props.axis, step: DAY / 24 }} />,
    );
    const bar = screen.getByTestId("gantt-bar-t1");
    // Finer edit precision does not turn the visible weekly axis into hours.
    expect(bar.style.inlineSize).toBe("192px");
    fireEvent.pointerDown(bar, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 102, clientY: 101, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 102, clientY: 101, pointerId: 1 });
    expect(onCommitMove).not.toHaveBeenCalled();
    fireEvent.pointerDown(bar, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 260, pointerId: 1 });
    expect(onPreviewMove.mock.calls.at(-1)?.[0]).toMatchObject({
      mode: "move",
      taskId: "t1",
    });
    fireEvent.pointerUp(bar, { clientX: 260, pointerId: 1 });
    expect(onPreviewMove).toHaveBeenLastCalledWith(null);
    expect(onCommitMove).toHaveBeenCalledTimes(1);
    const committed = onCommitMove.mock.calls[0]![0];
    const lastPreview = onPreviewMove.mock.calls
      .map(([intent]) => intent)
      .find(Boolean)!;
    expect(committed.start).toBe(lastPreview.start);
    expect(committed.end).toBe(lastPreview.end);
  });

  test("Escape cancels a drag without committing", () => {
    const onCommitMove = vi.fn();
    renderView(<GanttView {...baseProps({ onCommitMove })} />);
    const bar = screen.getByTestId("gantt-bar-t1");
    fireEvent.pointerDown(bar, { clientX: 100, pointerId: 2 });
    fireEvent.pointerMove(bar, { clientX: 300, pointerId: 2 });
    expect(document.activeElement).toBe(bar);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    fireEvent.pointerUp(bar, { clientX: 300, pointerId: 2 });
    expect(onCommitMove).not.toHaveBeenCalled();
  });

  test("an end resize drag on the handle commits a resize-end intent", () => {
    const onCommitMove = vi.fn();
    renderView(<GanttView {...baseProps({ onCommitMove })} />);
    const bar = screen.getByTestId("gantt-bar-t1");
    const handle = bar.querySelector(
      '.myoxus-gantt-resize-handle[data-edge="end"]',
    )!;
    // Capture lands on the bar, so move/up retarget to the bar's handlers.
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 3 });
    fireEvent.pointerMove(bar, { clientX: 200, pointerId: 3 });
    fireEvent.pointerUp(bar, { clientX: 200, pointerId: 3 });
    expect(onCommitMove).toHaveBeenCalledTimes(1);
    expect(onCommitMove.mock.calls[0]![0].mode).toBe("resize-end");
  });

  test("reordering retains equivalent reprojection and revokes changed content", () => {
    const onReorderTask = vi.fn();
    const view = renderView(<GanttView {...baseProps({ onReorderTask })} />);
    const reproject = (changed = false) => {
      const props = baseProps({ onReorderTask });
      view.rerender(
        <MyoxusUIProvider>
          <GanttView
            {...props}
            tasks={props.tasks.map((task) => ({
              ...task,
              selected: task.id === "t1",
              start: task.start + (changed ? DAY : 0),
            }))}
          />
        </MyoxusUIProvider>,
      );
    };
    // A lone task in its own section has no legal keyboard reorder target.
    fireEvent.keyDown(screen.getByTestId("gantt-task-reorder-t2"), {
      altKey: true,
      key: "ArrowUp",
    });
    expect(onReorderTask).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId("gantt-task-reorder-t1b"), {
      altKey: true,
      key: "ArrowUp",
    });
    expect(onReorderTask).not.toHaveBeenCalled();
    reproject();
    fireEvent.keyDown(screen.getByTestId("gantt-task-reorder-t1b"), {
      key: "Enter",
    });
    expect(onReorderTask).toHaveBeenCalledWith("t1b", "s1", 0);

    const labels = document.querySelectorAll<HTMLElement>(
      '[data-myoxus-ui-role="gantt-row-label"], [data-myoxus-ui-role="gantt-section-header"]',
    );
    labels.forEach((row, index) =>
      vi
        .spyOn(row, "getBoundingClientRect")
        .mockReturnValue(
          DOMRect.fromRect({ x: 0, y: index * 40, width: 200, height: 40 }),
        ),
    );
    const grip = screen.getByTestId("gantt-task-reorder-t1");
    fireEvent.pointerDown(grip, { clientY: 60, pointerId: 4 });
    fireEvent.pointerMove(grip, { clientY: 180, pointerId: 4 });
    reproject();
    fireEvent.pointerUp(grip, { clientY: 180, pointerId: 4 });
    expect(onReorderTask).toHaveBeenCalledTimes(2);
    expect(onReorderTask).toHaveBeenLastCalledWith("t1", "s2", 0);

    fireEvent.pointerDown(grip, { clientY: 60, pointerId: 5 });
    fireEvent.pointerMove(grip, { clientY: 180, pointerId: 5 });
    reproject(true);
    fireEvent.pointerUp(grip, { clientY: 180, pointerId: 5 });
    expect(onReorderTask).toHaveBeenCalledTimes(2);
  });

  test("readonly keeps the surface explorable without mutation affordances", () => {
    renderView(<GanttView {...baseProps({ readonly: true })} />);
    expect(
      document.querySelectorAll(".myoxus-gantt-resize-handle"),
    ).toHaveLength(0);
    expect(
      document.querySelectorAll(".myoxus-gantt-connect-handle"),
    ).toHaveLength(0);
    // View/readonly reads Mermaid's own clean render, so the visual-only
    // dependency overlay must not be projected there.
    expect(
      document.querySelectorAll(".myoxus-gantt-dependency-hit"),
    ).toHaveLength(0);
    expect(screen.getAllByTestId(/^gantt-bar-/)).toHaveLength(3);
  });

  test("dependency strokes stay hittable while the overlay canvas does not", () => {
    const onSelectDependency = vi.fn();
    renderView(<GanttView {...baseProps({ onSelectDependency })} />);
    const hits = document.querySelectorAll(".myoxus-gantt-dependency-hit");
    expect(hits).toHaveLength(1);
    fireEvent.pointerDown(hits[0]!);
    expect(onSelectDependency).toHaveBeenCalledWith("d1");
  });
});

test("a vert marker moves its own time and deletes through the marker handle", () => {
  const onCommitMarker = vi.fn();
  const onDeleteMarker = vi.fn();
  renderView(
    <GanttView
      {...baseProps({
        markers: [
          { id: "m1", label: "Cutover", move: { enabled: true }, value: START },
        ],
        onCommitMarker,
        onDeleteMarker,
      })}
    />,
  );
  const marker = screen.getByTestId("gantt-marker-m1");
  // Arrow previews; Enter confirms. Escape must discard the pending intent.
  fireEvent.keyDown(marker, { key: "ArrowRight" });
  expect(onCommitMarker).not.toHaveBeenCalled();
  fireEvent.keyDown(marker, { key: "Escape" });
  expect(onCommitMarker).not.toHaveBeenCalled();
  fireEvent.keyDown(marker, { key: "ArrowRight" });
  expect(onCommitMarker).not.toHaveBeenCalled();
  fireEvent.keyDown(marker, { key: "Enter" });
  expect(onCommitMarker).toHaveBeenCalledTimes(1);
  expect(onCommitMarker.mock.calls[0][0]).toMatchObject({
    markerId: "m1",
    mode: "move",
    value: START + DAY,
  });
  fireEvent.keyDown(marker, { key: "Delete" });
  expect(onDeleteMarker).toHaveBeenCalledWith("m1");
});

test("a pointer drag moves the marker by the true pointer delta", () => {
  const onCommitMarker = vi.fn();
  renderView(
    <GanttView
      {...baseProps({
        markers: [
          {
            id: "m1",
            label: "Cutover",
            move: { enabled: true },
            value: START + 4 * DAY,
          },
        ],
        onCommitMarker,
      })}
    />,
  );
  const marker = screen.getByTestId("gantt-marker-m1");
  fireEvent.pointerDown(marker, { clientX: 100, pointerId: 7 });
  fireEvent.pointerMove(marker, { clientX: 200, pointerId: 7 });
  fireEvent.pointerUp(marker, { clientX: 200, pointerId: 7 });
  expect(onCommitMarker).toHaveBeenCalledTimes(1);
  const committed = onCommitMarker.mock.calls[0][0];
  expect(committed.markerId).toBe("m1");
  // A 100px drag is well under a day on this 10-day-wide 640px axis; the commit
  // must be the true delta, not the full axis span.
  expect(committed.value).toBeGreaterThan(START + 4 * DAY);
  expect(committed.value).toBeLessThan(START + 10 * DAY);
});

test("a selected dependency is keyboard reachable and deletable", () => {
  const onDeleteDependency = vi.fn();
  const onReconnectDependency = vi.fn();
  renderView(
    <GanttView {...baseProps({ onDeleteDependency, onReconnectDependency })} />,
  );
  const hit = document.querySelector(".myoxus-gantt-dependency-hit")!;
  expect(hit.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(hit, { key: "Delete" });
  expect(onDeleteDependency).toHaveBeenCalledWith("d1");
  // ArrowRight arms a target-end reconnect; the next bar click confirms it.
  fireEvent.keyDown(hit, { key: "ArrowRight" });
  fireEvent.pointerDown(screen.getByTestId("gantt-bar-t1"), {
    clientX: 100,
    pointerId: 9,
  });
  expect(onReconnectDependency).toHaveBeenCalledWith("d1", "target", "t1");
});

test("vertical drag previews and resolves its lane", () => {
  const onPreviewMove = vi.fn();
  const onCommitMove = vi.fn();
  renderView(<GanttView {...baseProps({ onCommitMove, onPreviewMove })} />);
  const bar = screen.getByTestId("gantt-bar-t1");
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('[data-myoxus-ui-role="gantt-row"]'),
  );
  rows.forEach((row, index) => {
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({
      top: 100 + index * 60,
      bottom: 160 + index * 60,
      left: 0,
      right: 640,
      x: 0,
      y: 100 + index * 60,
      width: 640,
      height: 60,
      toJSON: () => ({}),
    });
  });
  fireEvent.pointerDown(bar, { clientX: 100, clientY: 100, pointerId: 5 });
  fireEvent.pointerMove(bar, { clientX: 100, clientY: 260, pointerId: 5 });
  const preview = onPreviewMove.mock.calls.at(-1)![0];
  expect(preview).toMatchObject({
    taskId: "t1",
    pointerY: 260,
    targetLaneId: "s2",
    targetOrder: 0,
  });
  fireEvent.pointerUp(bar, { clientX: 100, clientY: 260, pointerId: 5 });
  expect(onCommitMove).toHaveBeenCalledTimes(1);
  expect(onCommitMove.mock.calls[0][0]).toEqual(preview);
  expect(preview.start).toBe(START);
  expect(preview.end).toBe(START + 3 * DAY);
});
