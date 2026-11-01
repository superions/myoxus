import { type ReactElement, useState } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { tMock } = vi.hoisted(() => ({
  tMock: vi.fn((key: string) => key),
}));
vi.mock("@myoxus/i18n", async () => {
  const { createI18nMock } = await import("../../../__tests__/test-utils");
  return createI18nMock(tMock);
});

const { gqlFetcherMock } = vi.hoisted(() => ({
  gqlFetcherMock: vi.fn(),
}));
vi.mock("../../../use-query", () => ({
  gqlFetcher: (...args: unknown[]) => gqlFetcherMock(...args),
}));

import { WorkspacePicker } from "../workspace-picker";

interface ServerWorkspace {
  id: string;
  name: string;
  ownerUserId: string | null;
  ownerEmail: string | null;
  linkedOuIds: string[];
}

function makeWorkspaces(count: number): ServerWorkspace[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ws-${i}`,
    name: `Workspace ${i}`,
    ownerUserId: `user-${i}`,
    ownerEmail: `owner-${i}@example.com`,
    linkedOuIds: i % 2 === 0 ? [`ou-${i}`] : [],
  }));
}

function setEmpty() {
  gqlFetcherMock.mockResolvedValue({ admin: { adminSearchWorkspaces: [] } });
}

function setData(workspaces: ServerWorkspace[]) {
  gqlFetcherMock.mockResolvedValue({
    admin: { adminSearchWorkspaces: workspaces },
  });
}

async function flushSearch() {
  await act(async () => {
    vi.advanceTimersByTime(200);
    await Promise.resolve();
    await Promise.resolve();
  });
}

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("WorkspacePicker", () => {
  beforeEach(() => {
    gqlFetcherMock.mockReset();
    setEmpty();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    tMock.mockClear();
  });

  test("inv_p_ar_0_04_debounce: typing 1 char fires query after 200ms debounce", async () => {
    setData(makeWorkspaces(2));
    renderWithProvider(<WorkspacePicker value={null} onChange={vi.fn()} />);

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "a" } });
    });

    // Before debounce: useQuery still called with undefined (debounced
    // state has not yet updated).
    expect(gqlFetcherMock).not.toHaveBeenCalled();

    await flushSearch();

    const afterCall = gqlFetcherMock.mock.calls.at(-1);
    if (!afterCall) throw new Error("expected workspace search query");
    expect((afterCall[0] as any).variables).toEqual({
      query: "a",
      ouId: null,
      excludeUnitId: null,
      limit: 50,
    });
  });

  test("inv_p_ar_0_04_oudFilter_passthrough: ouId prop is forwarded to query variables", async () => {
    setData(makeWorkspaces(1));
    renderWithProvider(
      <WorkspacePicker value={null} onChange={vi.fn()} ouId="ou-42" />,
    );

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "team" } });
    });
    await flushSearch();

    const lastCall = gqlFetcherMock.mock.calls.at(-1);
    if (!lastCall) throw new Error("expected workspace search query");
    expect((lastCall[0] as any).variables).toEqual({
      query: "team",
      ouId: "ou-42",
      excludeUnitId: null,
      limit: 50,
    });
  });

  test("inv_p_ar_0_04_excludeUnitId_passthrough: excludeUnitId prop is forwarded to query variables", async () => {
    setData(makeWorkspaces(1));
    renderWithProvider(
      <WorkspacePicker
        value={null}
        onChange={vi.fn()}
        excludeUnitId="ou-existing"
      />,
    );

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "team" } });
    });
    await flushSearch();

    const lastCall = gqlFetcherMock.mock.calls.at(-1);
    if (!lastCall) throw new Error("expected workspace search query");
    expect((lastCall[0] as any).variables).toEqual({
      query: "team",
      ouId: null,
      excludeUnitId: "ou-existing",
      limit: 50,
    });
  });

  test("inv_p_ar_0_04_enter_selects: Enter commits the highlighted option", async () => {
    setData(makeWorkspaces(3));
    const onChange = vi.fn();
    function ControlledPicker() {
      const [value, setValue] = useState<string | null>(null);
      return (
        <WorkspacePicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    renderWithProvider(<ControlledPicker />);

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "w" } });
    });
    await flushSearch();
    fireEvent.change(input, { target: { value: "updated query" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    await flushSearch();
    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onChange).toHaveBeenCalledWith("ws-1");
    fireEvent.change(input, { target: { value: "another workspace" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  test("inv_p_ar_0_04_escape_closes: Escape collapses the listbox", async () => {
    setData(makeWorkspaces(2));
    const onOuterEscape = vi.fn();
    renderWithProvider(
      <div
        role="dialog"
        aria-label="Workspace selection"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented)
            onOuterEscape();
        }}
      >
        <WorkspacePicker value={null} onChange={vi.fn()} />
      </div>,
    );

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "w" } });
    });
    await flushSearch();

    expect(input.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(input.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOuterEscape).toHaveBeenCalledTimes(1);
  });
});
