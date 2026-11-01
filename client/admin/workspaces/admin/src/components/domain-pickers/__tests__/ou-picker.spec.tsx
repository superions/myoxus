import type { ReactElement } from "react";
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

import { OuPicker } from "../ou-picker";

function makeOptions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `ou-${i}`,
    name: `Unit ${i}`,
    slug: `unit-${i}`,
    parentBreadcrumb: i % 2 === 0 ? ["Root", `Branch ${i}`] : [],
  }));
}

function setEmpty() {
  gqlFetcherMock.mockResolvedValue({ searchOrganizationUnits: [] });
}

function setData(units: ReturnType<typeof makeOptions>) {
  gqlFetcherMock.mockResolvedValue({ searchOrganizationUnits: units });
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

describe("OuPicker", () => {
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

  test("inv_p_ar_0_02_debounce: typing 1 char fires query after 200ms debounce", async () => {
    setData(makeOptions(2));
    renderWithProvider(<OuPicker value={null} onChange={vi.fn()} />);

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "a" } });
    });

    expect(gqlFetcherMock).not.toHaveBeenCalled();

    await flushSearch();

    const afterCall = gqlFetcherMock.mock.calls.at(-1);
    if (!afterCall) throw new Error("expected OU search query");
    expect((afterCall[0] as any).variables).toEqual({
      query: "a",
      limit: 50,
    });
  });

  test("inv_p_ar_0_02_enter_selects: Enter commits the highlighted option", async () => {
    setData(makeOptions(3));
    const onChange = vi.fn();
    renderWithProvider(<OuPicker value={null} onChange={onChange} />);

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "u" } });
    });
    await flushSearch();
    act(() => {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(onChange).toHaveBeenCalledWith("ou-1");
  });

  test("inv_p_ar_0_02_escape_closes: Escape collapses the listbox", async () => {
    setData(makeOptions(2));
    renderWithProvider(<OuPicker value={null} onChange={vi.fn()} />);

    const input = screen.getByRole("combobox");
    act(() => {
      fireEvent.change(input, { target: { value: "u" } });
    });
    await flushSearch();

    expect(input.getAttribute("aria-expanded")).toBe("true");

    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(input.getAttribute("aria-expanded")).toBe("false");
  });
});
