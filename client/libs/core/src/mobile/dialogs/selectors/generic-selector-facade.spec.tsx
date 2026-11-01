// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const navigationGesture = vi.hoisted(() => ({
  enabled$: { value: false },
  setEnabled: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    ({
      "com.myoxus.m.selector.confirm-default": () => "Apply",
      "com.myoxus.m.selector.info-added": ({
        count,
        type,
      }: {
        count: string;
        type: string;
      }) => `Added ${count} ${type}`,
      "com.myoxus.m.selector.info-removed": ({
        count,
        type,
      }: {
        count: string;
        type: string;
      }) => `Removed ${count} ${type}`,
      "com.myoxus.m.selector.info-total": ({ total }: { total: string }) =>
        `Total ${total}`,
      "com.myoxus.m.selector.title": ({ type }: { type: string }) =>
        `Select ${type}`,
    }) as never,
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => navigationGesture,
}));

import { GenericSelector } from "./generic-selector";

function renderWithProvider(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

function renderSelector(onConfirm = vi.fn()) {
  renderWithProvider(
    <GenericSelector
      confirmText="Apply"
      data={[
        { id: "alpha", icon: <span>A</span>, label: "Alpha" },
        { id: "beta", icon: <span>B</span>, label: "Beta" },
      ]}
      initial={["alpha"]}
      onConfirm={onConfirm}
      title="Select documents"
      typeName="document"
    />,
  );
  return onConfirm;
}

describe("GenericSelector facade migration", () => {
  beforeEach(() => {
    navigationGesture.enabled$.value = false;
    navigationGesture.setEnabled.mockReset();
  });

  afterEach(() => cleanup());

  test("renders mobile selector chrome through facade roles", () => {
    renderSelector();

    expect(
      document.querySelector('[data-myoxus-ui-role="mobile-selector-root"]'),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-selector-scroll-area"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector('[data-myoxus-ui-role="mobile-selector-list"]'),
    ).toBeTruthy();
    expect(
      document.querySelectorAll(
        '[data-myoxus-ui-role="mobile-selector-list-item"]',
      ),
    ).toHaveLength(2);
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-selector-touch-rail"]',
      ),
    ).toBeTruthy();
    expect(
      document.querySelector(
        '[data-myoxus-ui-role="mobile-selector-footer-actions"]',
      ),
    ).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("keeps row and checkbox selection functional without double toggles", () => {
    const onConfirm = renderSelector();

    fireEvent.click(screen.getAllByRole("checkbox")[1]);
    expect(screen.getByText("Added 1 document")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onConfirm).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  test("keeps deleted local selector CSS blocked by source contract", () => {
    const repoRoot = process.cwd();
    const sourcePath =
      "client/libs/core/src/mobile/dialogs/selectors/generic-selector.tsx";
    const source = readFileSync(join(repoRoot, sourcePath), "utf8");

    for (const deletedPath of [
      "client/libs/core/src/mobile/dialogs/selectors/generic.css",
      "client/libs/core/src/mobile/dialogs/selectors/generic.styles.ts",
    ]) {
      expect(existsSync(join(repoRoot, deletedPath)), deletedPath).toBe(false);
    }

    expect(source).toContain("MobileSelectorRoot");
    expect(source).toContain("MobileSelectorScrollArea");
    expect(source).toContain("MobileSelectorScrollViewport");
    expect(source).toContain("MobileSelectorTouchRail");
    expect(source).not.toContain("./generic.styles");
    expect(source).not.toContain("className={styles");
    expect(source).not.toContain("styles.");
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/[0-9]+px/);
  });
});
