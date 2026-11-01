// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MyoxusUIProvider } from "../../provider";
import { JourneyMap, type JourneyMapProps } from "./index";

afterEach(cleanup);

describe("JourneyMap", () => {
  test("keeps source order, score, actors and pointer selection accessible", () => {
    const onSelectStep = vi.fn();
    const onMoveStep = vi.fn();
    const renderMap = (
      focusRequest?: JourneyMapProps["focusRequest"],
      readonly = false,
    ) => (
      <MyoxusUIProvider env="test">
        <div contentEditable suppressContentEditableWarning>
          <JourneyMap
            aria-label="Onboarding"
            labels={{
              addSection: "Add section",
              addStep: () => "Add step",
              actions: "Actions",
              unnamedSection: "Unnamed",
              stepCount: (count) => `${count} steps`,
              dragStep: (label) => `Move ${label}`,
              dragSection: (label) => `Move ${label}`,
              deleteSection: (label) => `Delete ${label}`,
              deleteStep: (label) => `Delete ${label}`,
              emptySection: "No steps",
              openStep: (label) => `Open ${label}`,
              movedStep: (label) => `Moved ${label}`,
              movedSection: (label) => `Moved ${label}`,
              score: (score) => `Score ${score}`,
              scoreValue: (score) => `${score}`,
              scoreAxis: "Score",
              moveTarget: (label, target, position) =>
                `${label}: ${target} ${position}`,
            }}
            onMoveStep={onMoveStep}
            readonly={readonly}
            focusRequest={focusRequest}
            onOpenStep={vi.fn()}
            onSelectSection={vi.fn()}
            onSelectStep={onSelectStep}
            sections={[
              {
                id: "discover",
                label: "Discover",
                steps: [
                  {
                    actors: ["User", "Admin"],
                    id: "open",
                    sectionId: "discover",
                    label: "Open workspace",
                    score: 5,
                  },
                  {
                    actors: ["Admin"],
                    id: "invite",
                    sectionId: "discover",
                    label: "Invite team",
                    score: 4,
                  },
                ],
              },
            ]}
          />
        </div>
      </MyoxusUIProvider>
    );
    const view = render(renderMap());

    expect(screen.getByRole("button", { name: "Score 5" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.getAllByText("Admin")).toHaveLength(2);
    const trigger = screen.getByRole("group", { name: "Invite team" });
    fireEvent.pointerDown(trigger);
    expect(onSelectStep).toHaveBeenCalledWith("invite", trigger);
    onSelectStep.mockClear();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Score 5" }));
    expect(onSelectStep).not.toHaveBeenCalled();
    expect(
      screen
        .getAllByTestId("journey-step")
        .map((el) => el.getAttribute("aria-label")),
    ).toEqual(["Open workspace", "Invite team"]);
    const handle = screen.getByRole("button", { name: "Move Invite team" });
    fireEvent.keyDown(handle, { key: " " });
    fireEvent.keyDown(handle, { key: "ArrowUp" });
    expect(
      view.container.querySelectorAll("path[stroke-dasharray]"),
    ).toHaveLength(1);
    view.rerender(renderMap({ requestId: 1, selection: { stepId: "invite" } }));
    expect(
      view.container.querySelectorAll("path[stroke-dasharray]"),
    ).toHaveLength(0);
    expect(handle.getAttribute("aria-pressed")).toBe("false");
    expect(onMoveStep).not.toHaveBeenCalled();
  });
});
