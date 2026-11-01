/**
 * Shared test utilities for admin frontend tests.
 *
 * Provides reusable mock factories so individual test files stay DRY.
 */
import { fireEvent, within } from "@testing-library/react";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// i18n mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a standard i18n mock that satisfies the full interface expected by
 * createI18nWrapper (t, exists, language, changeLanguage).
 *
 * Mock factories run before static imports. Resolve this helper inside the
 * async factory and keep shared spy references in `vi.hoisted`:
 * ```ts
 * const { tMock } = vi.hoisted(() => ({
 *   tMock: vi.fn((key: string) => key),
 * }));
 * vi.mock('@myoxus/i18n', async () => {
 *   const { createI18nMock } = await import('../__tests__/test-utils');
 *   return createI18nMock(tMock);
 * });
 * ```
 */
export function createI18nMock(tFn?: ReturnType<typeof vi.fn>) {
  const t = tFn ?? vi.fn((key: string) => key);
  return {
    useI18n: () => ({
      t,
      exists: (_key: string) => true,
      language: "en",
      changeLanguage: () => Promise.resolve(),
    }),
    Trans: ({ children }: any) => children,
  };
}

// ---------------------------------------------------------------------------
// useAppConfig mock factory
// ---------------------------------------------------------------------------

/**
 * Creates a mock return value for useAppConfig with sensible defaults.
 * Override individual fields via the `overrides` parameter.
 */
export function createAppConfigMock(overrides: Record<string, unknown> = {}) {
  return {
    appConfig: {},
    patchedAppConfig: {},
    update: vi.fn(),
    saveGroup: vi.fn().mockResolvedValue(undefined),
    resetGroup: vi.fn(),
    isGroupDirty: vi.fn().mockReturnValue(false),
    isGroupSaving: vi.fn().mockReturnValue(false),
    getGroupVersion: vi.fn().mockReturnValue(0),
    ...overrides,
  };
}

/**
 * Resolves the listbox owned by one Mantine Select control.
 *
 * Mantine keeps Select dropdowns mounted for stable overlay behavior. Tests
 * must therefore follow the control's ARIA ownership instead of scanning all
 * hidden options in the document, where other Selects may expose equal labels.
 */
export function openMantineSelectListbox(select: HTMLElement): HTMLElement {
  const combobox = select.matches('[role="combobox"]')
    ? select
    : select.querySelector<HTMLElement>('[role="combobox"]');
  if (!combobox) {
    throw new Error("Mantine Select does not expose a combobox control");
  }

  fireEvent.click(combobox);
  const listboxId = combobox?.getAttribute("aria-controls");
  const listbox = listboxId ? document.getElementById(listboxId) : null;

  if (!listbox) {
    throw new Error("Mantine Select does not expose its owned listbox");
  }

  return listbox;
}

/** Selects one option from the listbox owned by the supplied Select control. */
export function selectMantineOption(
  select: HTMLElement,
  option: string | RegExp,
): void {
  fireEvent.click(
    within(openMantineSelectListbox(select)).getByRole("option", {
      name: option,
      hidden: true,
    }),
  );
}
