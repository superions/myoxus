// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  createMermaidPageViewportState,
  applyJourneyCommands,
  applyPacketCommand,
  parseMermaidJourneySource,
  parseMermaidPacketSource,
  mermaidMessages,
  type MermaidPageViewportProjection,
} from "@virgultum/block-mermaid";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { MermaidJourneyRuntime } from "./mermaid-journey-runtime";
import { MermaidPacketRuntime } from "./mermaid-packet-runtime";

afterEach(cleanup);

function createTestPageViewport(): MermaidPageViewportProjection {
  return {
    mode: "visual",
    onAvailabilityChange: () => undefined,
    onPositionChange: () => undefined,
    onResolvedScaleChange: () => undefined,
    onZoomChange: () => undefined,
    resolveCenterPosition: () => null,
    resolveNavigationGeometry: () => null,
    state: createMermaidPageViewportState(),
  };
}

describe("specialized Mermaid Core runtimes", () => {
  test("Journey emits exactly one semantic model change per pointer action", async () => {
    const onChange = vi.fn();
    function ReparsedJourney() {
      const [model, setModel] = useState(
        parseMermaidJourneySource(
          "journey\n  section Discover\n    Open workspace: 5: User\n",
        )!,
      );
      return (
        <MermaidJourneyRuntime
          props={{
            embedded: false,
            displayOnly: false,
            selection: undefined,
            replayed: false,
            onSelectionChange: () => undefined,
            onConsumeEscape: () => undefined,
            onOpenSource: () => undefined,
            model,
            onCommand: (command, basis) => {
              const result = applyJourneyCommands(
                model,
                Array.isArray(command) ? command : [command],
                { baseSource: basis },
              );
              if (result.changed) {
                onChange(result.model);
                setModel(
                  parseMermaidJourneySource(result.source, result.model)!,
                );
              }
              return result;
            },
            onPreviewCommand: (command, basis) =>
              applyJourneyCommands(
                model,
                Array.isArray(command) ? command : [command],
                { baseSource: basis },
              ),
            onSelectionActionChange: () => undefined,
            pageViewport: createTestPageViewport(),
            readonly: false,
          }}
        />
      );
    }
    render(
      <MyoxusUIProvider env="test">
        <ReparsedJourney />
      </MyoxusUIProvider>,
    );

    const addStep = screen
      .getAllByRole<HTMLButtonElement>("button", { name: "Add step" })
      .find((button) => !button.disabled);
    expect(addStep).toBeDefined();
    fireEvent.click(addStep!);
    expect(onChange).not.toHaveBeenCalled();
    const draft = await screen.findByRole("textbox", {
      name: "Add step: Discover",
    });
    fireEvent.change(draft, { target: { value: "Verify workspace" } });
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].steps).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /^Score: 5 \(/ }));
    const actor = await screen.findByRole("combobox", { name: "Actors" });
    actor.focus();
    fireEvent.change(actor, { target: { value: "Admin" } });
    fireEvent.keyDown(actor, { key: "Enter" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getByRole("group", { name: "Open workspace" })
        .getAttribute("data-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("group", { name: "Verify workspace" }),
    ).toBeInstanceOf(HTMLElement);
    expect(onChange.mock.calls[1][0].sourceDocument.source).toBe(
      "journey\n  section Discover\n    Open workspace: 5: User, Admin\n    Verify workspace: 3\n",
    );
    expect(onChange.mock.calls[1][0].steps[0].actors).toEqual([
      "User",
      "Admin",
    ]);
  });

  test("keeps Journey and Packet selections on the same source item after reparsing", async () => {
    function ReparsedJourney() {
      const [model, setModel] = useState(
        parseMermaidJourneySource(
          "journey\n  section Discover\n    Open workspace: 5: User\n    Invite team: 4: Admin\n",
        )!,
      );
      return (
        <MermaidJourneyRuntime
          props={{
            embedded: false,
            displayOnly: false,
            selection: undefined,
            replayed: false,
            onSelectionChange: () => undefined,
            onConsumeEscape: () => undefined,
            onOpenSource: () => undefined,
            model,
            onCommand: (command, basis) => {
              const result = applyJourneyCommands(
                model,
                Array.isArray(command) ? command : [command],
                { baseSource: basis },
              );
              if (result.changed)
                setModel(
                  parseMermaidJourneySource(result.source, result.model)!,
                );
              return result;
            },
            onPreviewCommand: (command, basis) =>
              applyJourneyCommands(
                model,
                Array.isArray(command) ? command : [command],
                { baseSource: basis },
              ),
            onSelectionActionChange: () => undefined,
            pageViewport: createTestPageViewport(),
            readonly: false,
          }}
        />
      );
    }

    const view = render(
      <MyoxusUIProvider env="test">
        <ReparsedJourney />
      </MyoxusUIProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Score: 5 \(/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Step" }), {
      target: { value: "Review workspace" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(
      screen
        .getByRole("group", { name: "Review workspace" })
        .getAttribute("data-selected"),
    ).toBe("true");
    view.unmount();
    cleanup();

    const packetChanges = vi.fn();
    function ReparsedPacket() {
      const [model, setModel] = useState(
        parseMermaidPacketSource('packet\n  0-3: "Version"\n  4-7: "Flags"\n')!,
      );
      return (
        <MermaidPacketRuntime
          props={{
            model,
            embedded: false,
            displayOnly: false,
            replayed: false,
            onSelectionChange: () => undefined,
            onConsumeEscape: () => undefined,
            onOpenSource: () => undefined,
            onPreviewCommand: (command, baseSource) =>
              applyPacketCommand(model, command, { baseSource }),
            onCommand: (command, baseSource) => {
              const result = applyPacketCommand(model, command, { baseSource });
              if (result.changed) {
                packetChanges(result);
                setModel(result.model);
              }
              return result;
            },
            onSelectionActionChange: () => undefined,
            pageViewport: createTestPageViewport(),
            readonly: false,
          }}
        />
      );
    }

    render(
      <MyoxusUIProvider env="test">
        <ReparsedPacket />
      </MyoxusUIProvider>,
    );
    const packetField = screen.getByRole("button", {
      name: mermaidMessages.packetFieldLabel("Version", "0", "3", "4"),
    });
    fireEvent.click(packetField);
    fireEvent.keyDown(packetField, { key: "Enter" });
    const packetLabel = await screen.findByRole<HTMLInputElement>("textbox", {
      name: mermaidMessages.timelineLabel(),
    });
    expect(packetLabel.value).toBe("Version");
    fireEvent.change(packetLabel, {
      target: { value: "Header" },
    });
    expect(
      screen.getByRole<HTMLInputElement>("textbox", {
        name: mermaidMessages.timelineLabel(),
      }).value,
    ).toBe("Header");
    expect(
      screen.getByLabelText<HTMLInputElement>(
        mermaidMessages.selectedPacketStartBit(),
      ).value,
    ).toBe("0");
    expect(packetChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(packetChanges).toHaveBeenCalledOnce();
    expect(packetChanges.mock.calls[0][0].source).toBe(
      'packet\n  0-3: "Header"\n  4-7: "Flags"\n',
    );
    expect(
      screen
        .getByRole("button", {
          name: mermaidMessages.packetFieldLabel("Header", "0", "3", "4"),
          pressed: true,
        })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", {
        name: mermaidMessages.packetFieldLabel("Header", "0", "3", "4"),
        pressed: true,
      }),
    ).toBe(document.activeElement);
  });

  test("Packet retains proportional readonly geometry and cancels active drafts on rights or Source changes", async () => {
    let model = parseMermaidPacketSource(
      'packet\n  0-3: "Version"\n  4-11: "Length"\n',
    )!;
    let readonly = true;
    const onChange = vi.fn();
    const body = () => (
      <MyoxusUIProvider env="test">
        <MermaidPacketRuntime
          props={{
            model,
            embedded: false,
            displayOnly: false,
            replayed: false,
            onSelectionChange: () => undefined,
            onConsumeEscape: () => undefined,
            onOpenSource: () => undefined,
            onPreviewCommand: (command, baseSource) =>
              applyPacketCommand(model, command, { baseSource, readonly }),
            onCommand: (command, baseSource) => {
              onChange(command);
              return applyPacketCommand(model, command, {
                baseSource,
                readonly,
              });
            },
            onSelectionActionChange: () => undefined,
            pageViewport: createTestPageViewport(),
            readonly,
          }}
        />
      </MyoxusUIProvider>
    );
    const view = render(body());
    const fields = view.container.querySelectorAll<HTMLElement>(
      '[data-myoxus-ui-role="packet-bit-field-shell"]',
    );
    expect(fields[0].style.getPropertyValue("--packet-grid-width")).toBe("4");
    expect(fields[1].style.getPropertyValue("--packet-grid-width")).toBe("8");
    const readonlyField = screen.getByRole("button", {
      name: mermaidMessages.packetFieldLabel("Version", "0", "3", "4"),
    });
    fireEvent.doubleClick(readonlyField);
    fireEvent.keyDown(readonlyField, { key: "Enter" });
    fireEvent.keyDown(readonlyField, { key: "Delete" });
    fireEvent.keyDown(readonlyField, { key: "ArrowRight", altKey: true });
    expect(
      screen.queryByRole("textbox", { name: mermaidMessages.timelineLabel() }),
    ).toBeNull();
    const add = () =>
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Add field",
      });
    expect(add().disabled).toBe(true);
    fireEvent.click(add());
    expect(onChange).not.toHaveBeenCalled();
    readonly = false;
    view.rerender(body());
    fireEvent.click(add());
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: mermaidMessages.timelineLabel(),
      }),
      { target: { value: "Never commit" } },
    );
    readonly = true;
    view.rerender(body());
    expect(
      screen.queryByRole("textbox", {
        name: mermaidMessages.timelineLabel(),
      }),
    ).toBeNull();
    expect(add().disabled).toBe(true);
    readonly = false;
    view.rerender(body());
    fireEvent.click(add());
    fireEvent.change(
      await screen.findByRole("textbox", {
        name: mermaidMessages.timelineLabel(),
      }),
      { target: { value: "Stale draft" } },
    );
    const externalSource = model.sourceDocument.source.replace(
      '"Version"',
      '"External version"',
    );
    model = parseMermaidPacketSource(externalSource, model)!;
    view.rerender(body());
    expect(
      screen.queryByRole("textbox", {
        name: mermaidMessages.timelineLabel(),
      }),
    ).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/source.*changed/i);
    expect(add().disabled).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(model.sourceDocument.source).toBe(externalSource);
    model = parseMermaidPacketSource(
      'packet\n  0-3: "Version"\n  8-15: "Length"\n',
    )!;
    view.rerender(body());
    expect(
      view.container.querySelectorAll(
        '[data-myoxus-ui-role="packet-bit-field"]',
      ),
    ).toHaveLength(0);
    expect(add().disabled).toBe(true);
    expect(
      screen
        .getAllByRole("alert")
        .map((x) => x.textContent)
        .join(" "),
    ).toMatch(/expected contiguous bit 4, found 8/i);
    expect(onChange).not.toHaveBeenCalled();
  });
});

const chartDelivery = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./mermaid-chart-runtime/load", () => ({
  loadMermaidChartRenderer: chartDelivery.load,
}));
import {
  DeferredMermaidChart,
  type MermaidChartRequest,
} from "./deferred-mermaid-chart";
import { act } from "@testing-library/react";

// These fixtures exercise transport/lifetime only; existing family tests and
// the served chart journey own the actual chart model, controls and geometry.
const chartRequest = (title: string) =>
  ({
    kind: "pie",
    props: { model: { title } },
  }) as unknown as MermaidChartRequest;

test("deferred chart delivery retains updated props and recovers through retry", async () => {
  const pending = Promise.withResolvers<unknown>();
  const renderer = vi.fn((request: MermaidChartRequest) => (
    <span data-testid="delivered-chart">{request.props.model.title}</span>
  ));
  chartDelivery.load
    .mockReset()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(renderer);
  const first = chartRequest("First");
  const updated = chartRequest("Updated while pending");
  const view = render(
    <MyoxusUIProvider>
      <DeferredMermaidChart {...first} />
    </MyoxusUIProvider>,
  );
  expect(screen.getByRole("status")).not.toBeNull();
  expect(renderer).not.toHaveBeenCalled();
  view.rerender(
    <MyoxusUIProvider>
      <DeferredMermaidChart {...updated} />
    </MyoxusUIProvider>,
  );
  await act(async () =>
    pending.reject(new Error("Deferred asset unavailable")),
  );
  await screen.findByRole("alert");
  expect(renderer).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("Updated while pending");
  expect(renderer).toHaveBeenLastCalledWith(updated);
  expect(chartDelivery.load).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});
