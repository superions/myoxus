// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { CSSProperties } from "react";
import { afterEach, describe, expect, test } from "vitest";

import { CountBadge, EmptyState, Label, MetricStack, StatusDot } from "./index";
import { MyoxusUIProvider } from "./provider";

afterEach(() => {
  cleanup();
});

describe("Facade form label and status primitives", () => {
  test("Label supports semantic HTML label binding and an optional left section", () => {
    render(
      <MyoxusUIProvider>
        <Label
          htmlFor="target"
          leftSection={<span data-testid="label-icon" />}
          data-myoxus-ui-role="admin-field-label"
        >
          Name
        </Label>
      </MyoxusUIProvider>,
    );

    const label = screen.getByText("Name") as HTMLLabelElement;
    expect(label.tagName).toBe("LABEL");
    expect(label.htmlFor).toBe("target");
    expect(label.dataset.myoxusUiRole).toBe("admin-field-label");
    expect(screen.getByTestId("label-icon")).toBeDefined();
  });

  test("StatusDot exposes color CSS variables for semantic adapters", () => {
    render(
      <MyoxusUIProvider>
        <StatusDot
          label="ready"
          data-testid="status"
          data-myoxus-ui-role="admin-status-dot"
          data-admin-tone="mint"
          style={
            {
              "--myoxus-ui-status-dot-color": "var(--admin-tone-fg)",
              "--myoxus-ui-status-dot-dot-color": "var(--admin-tone-dot)",
              "--myoxus-ui-status-dot-label-color": "var(--admin-tone-fg)",
            } as CSSProperties
          }
        />
      </MyoxusUIProvider>,
    );

    const status = screen.getByTestId("status");
    expect(status.dataset.myoxusUiRole).toBe("admin-status-dot");
    expect(status.dataset.adminTone).toBe("mint");
    expect(
      status.style.getPropertyValue("--myoxus-ui-status-dot-dot-color"),
    ).toBe("var(--admin-tone-dot)");
    expect(screen.getByText("ready")).toBeDefined();
  });

  test("CountBadge keeps label and count visibly separated", () => {
    render(
      <MyoxusUIProvider>
        <CountBadge
          label="Waiting"
          count={12}
          data-testid="count-badge"
          tone="neutral"
        />
      </MyoxusUIProvider>,
    );

    const badge = screen.getByTestId("count-badge");
    expect(badge.textContent).toContain("Waiting 12");
    expect(badge.getAttribute("aria-label")).toBe("Waiting: 12");
    expect(
      badge.querySelector("[data-myoxus-ui-role='count-badge-value']")
        ?.textContent,
    ).toBe("12");
  });

  test("MetricStack renders semantic dt/dd pairs with adapter tone metadata", () => {
    render(
      <MyoxusUIProvider>
        <MetricStack
          data-myoxus-ui-role="admin-shoulder-stat"
          rows={[
            {
              label: "Scope",
              value: "global",
              "data-admin-tone": "sky",
              valueClassName: "metric-value",
              toneColor: "var(--admin-tone-fg)",
            },
          ]}
        />
      </MyoxusUIProvider>,
    );

    expect(screen.getByText("Scope").tagName).toBe("DT");
    const value = screen.getByText("global");
    expect(value.tagName).toBe("DD");
    expect(value.dataset.adminTone).toBe("sky");
    expect(value.className).toContain("metric-value");
  });

  test("EmptyState renders title, description and cta through one facade role", () => {
    render(
      <MyoxusUIProvider>
        <EmptyState
          title="Nothing here"
          description="Adjust filters"
          cta={<button type="button">Reset</button>}
          data-myoxus-ui-role="admin-empty-state"
        />
      </MyoxusUIProvider>,
    );

    const root = screen
      .getByText("Nothing here")
      .closest("[data-myoxus-ui-role='admin-empty-state']");
    expect(root).not.toBeNull();
    expect(screen.getByText("Adjust filters")).toBeDefined();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDefined();
  });

  test("EmptyState owns illustrated and absolute-centered empty chrome", () => {
    render(
      <MyoxusUIProvider>
        <EmptyState
          absoluteCenter
          aria-live="polite"
          media={<span data-testid="empty-media" />}
          title="No documents"
          description="Create the first one"
          data-testid="empty-state"
          data-empty-state-scope="docs"
        />
      </MyoxusUIProvider>,
    );

    const root = screen.getByTestId("empty-state");
    expect(root.dataset.myoxusUiRole).toBe("empty-state");
    expect(root.dataset.emptyStateScope).toBe("docs");
    expect(root.getAttribute("aria-live")).toBe("polite");
    expect(root.style.position).toBe("absolute");
    expect(root.style.transform).toBe("translate(-50%, -50%)");
    expect(
      root.querySelector("[data-myoxus-ui-role='empty-state-media']"),
    ).not.toBeNull();
    expect(screen.getByTestId("empty-media")).toBeDefined();
  });
});
