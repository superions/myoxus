// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  applyRuntimeThemeProjection,
  clearRuntimeThemeProjection,
} from "@myoxus/theme";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { afterEach, expect, test, vi } from "vitest";

import { RuntimeThemeSurface } from "./runtime-theme-surface";

vi.mock("@myoxus/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/i18n")>()),
  useI18n: () => new Proxy({}, { get: (_target, key) => () => String(key) }),
}));

afterEach(() => {
  cleanup();
  document.head.innerHTML = "";
  delete document.documentElement.dataset.myoxusThemeSource;
});

test("a theme outage hides the workspace and preserves its input state through recovery", () => {
  applyRuntimeThemeProjection(document, ":root {}", "api");
  render(
    <MyoxusUIProvider>
      <RuntimeThemeSurface>
        <input aria-label="Draft" defaultValue="" />
      </RuntimeThemeSurface>
    </MyoxusUIProvider>,
  );
  const draft = screen.getByRole("textbox", {
    name: "Draft",
  }) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: "Unsaved input" } });
  act(() => {
    clearRuntimeThemeProjection();
  });
  expect(screen.queryByRole("textbox", { name: "Draft" })).toBeNull();
  expect(screen.getByTestId("runtime-theme-retry")).not.toBeNull();
  act(() => {
    applyRuntimeThemeProjection(document, ":root {}", "api");
  });
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
  expect(draft.value).toBe("Unsaved input");
  expect(screen.queryByTestId("runtime-theme-retry")).toBeNull();
});
