/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { clearBrandIdentityCache } from "@myoxus/ui-facade";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const useServerConfigMock = vi.fn();

vi.mock("../common", () => ({
  useServerConfig: () => useServerConfigMock(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("./form", () => ({
  Form: () => <h1>Setup Form</h1>,
}));

import { Setup } from "./index";

describe("Setup", () => {
  beforeEach(() => {
    useServerConfigMock.mockReset();
    clearBrandIdentityCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 404 })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearBrandIdentityCache();
  });

  test("renders setup form while server is not initialized", () => {
    useServerConfigMock.mockReturnValue({ initialized: false });

    render(
      <MyoxusUIProvider>
        <MemoryRouter initialEntries={["/adminfrontend/setup"]}>
          <Routes>
            <Route path="/adminfrontend/setup" element={<Setup />} />
          </Routes>
        </MemoryRouter>
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Setup Form")).toBeTruthy();
  });
});
