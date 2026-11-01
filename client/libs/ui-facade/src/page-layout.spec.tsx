// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import {
  PageContentRail,
  PageFrame,
  PageFrameBody,
  PageScrollViewport,
} from "./page-layout";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("page layout scroll ownership", () => {
  test("bounds the page body so the Mantine viewport owns long-content scrolling", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <PageFrame data-testid="frame">
          <PageFrameBody data-testid="body">
            <div>Subnav</div>
            <PageScrollViewport>
              <PageContentRail scroll>
                <div>Long page content</div>
              </PageContentRail>
            </PageScrollViewport>
          </PageFrameBody>
        </PageFrame>
      </MyoxusUIProvider>,
    );

    const frame = screen.getByTestId("frame");
    const body = screen.getByTestId("body");
    const scrollRoot = container.querySelector<HTMLElement>(
      '[data-myoxus-ui-role="page-scroll"]',
    );
    const viewport = scrollRoot?.querySelector<HTMLElement>(
      ".mantine-ScrollArea-viewport",
    );

    expect(getComputedStyle(frame).minHeight).toMatch(/^0(?:px|rem)?$/);
    expect(getComputedStyle(body).minHeight).toMatch(/^0(?:px|rem)?$/);
    expect(scrollRoot?.style.height).toBe("100%");
    expect(scrollRoot?.style.minHeight).toBe("0");
    expect(viewport).not.toBeNull();
  });
});
