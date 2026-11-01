/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { Scroller } from "./components";

afterEach(cleanup);

describe("PDF virtualized scroller", () => {
  test("keeps Virtuoso sizing, scrolling and its ref on one facade viewport", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <Scroller data-testid="pdf-scroller" style={{ height: "100%" }} />
      </MyoxusUIProvider>,
    );

    const scroller = screen.getByTestId("pdf-scroller");
    expect(scroller.getAttribute("data-myoxus-ui-role")).toBe(
      "virtualized-scroll-viewport",
    );
    expect(scroller.style.height).toBe("100%");
    expect(
      container.querySelector('[data-myoxus-ui-role="settings-scroll-root"]'),
    ).toBeNull();
  });
});
