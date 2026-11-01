// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { MetricCard, MetricValue, MonoText, StatCell, StatGrid } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("Facade metric primitives", () => {
  test("MetricCard exposes semantic metric roles without route CSS", () => {
    render(
      <MyoxusUIProvider>
        <MetricCard label="Requests" value="42/s" hint="rolling window" />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Requests").dataset.myoxusUiRole).toBe(
      "metric-label",
    );
    expect(screen.getByText("42/s").dataset.myoxusUiRole).toBe("metric-value");
    expect(screen.getByText("rolling window").dataset.myoxusUiRole).toBe(
      "metric-hint",
    );
  });

  test("StatGrid and StatCell provide reusable live-stat chrome", () => {
    render(
      <MyoxusUIProvider>
        <StatGrid data-testid="stats">
          <StatCell label="Buffered" value="7" hint="pending" />
        </StatGrid>
        <MetricValue>standalone</MetricValue>
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("stats").dataset.myoxusUiRole).toBe("stat-grid");
    expect(screen.getByText("Buffered").dataset.myoxusUiRole).toBe(
      "stat-label",
    );
    expect(screen.getByText("7").dataset.myoxusUiRole).toBe("metric-value");
    expect(screen.getByText("pending").dataset.myoxusUiRole).toBe("stat-hint");
    expect(screen.getByText("standalone").dataset.myoxusUiRole).toBe(
      "metric-value",
    );
  });

  test("StatCell can render compact values for dense settings surfaces", () => {
    render(
      <MyoxusUIProvider>
        <StatCell label="Members" value="2" density="compact" />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("2").dataset.myoxusUiRole).toBe(
      "metric-value:compact",
    );
  });

  test("MonoText owns inline technical identifier typography", () => {
    render(
      <MyoxusUIProvider>
        <MonoText>template:abc</MonoText>
      </MyoxusUIProvider>,
    );

    const mono = screen.getByText("template:abc");
    expect(mono.dataset.myoxusUiRole).toBe("mono-text");
    expect(mono.getAttribute("style") ?? "").toContain(
      "--myoxus-typography-monospace-family",
    );
  });
});
