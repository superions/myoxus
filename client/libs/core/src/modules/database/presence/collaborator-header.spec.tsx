// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29B-D: focused component tests for the database collaboration
// surface (collaborator header, presence dot).
//
// The conflict modal's rendering is fully covered by its wire-format
// helpers (`types.spec.ts`) and the underlying `DatabasePresenceService`
// + invariant handlers; testing the Mantine portal here would only
// duplicate Mantine's own behaviour without exercising the contract.
//
// @vitest-environment happy-dom

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DatabaseCollaboratorHeader,
  DatabasePresenceDot,
  DatabasePresenceIndicator,
} from "./collaborator-header";
import type { DatabasePresenceRecord } from "./service";

function makeRecord(
  overrides: Partial<DatabasePresenceRecord> = {},
): DatabasePresenceRecord {
  return {
    socketId: overrides.socketId ?? "s1",
    userId: overrides.userId ?? "u1",
    displayName: overrides.displayName ?? "Alice",
    viewId: overrides.viewId ?? null,
    rowId: overrides.rowId ?? null,
    fieldId: overrides.fieldId ?? null,
    dragging: overrides.dragging ?? false,
    lastActiveAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("DatabasePresenceDot", () => {
  test("projects the collaborator identity through the Facade avatar", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <DatabasePresenceDot
          record={makeRecord({ displayName: "Alice Smith" })}
        />
      </MyoxusUIProvider>,
    );
    const node = container.querySelector(
      "[data-myoxus-ui-role='database-presence-avatar']",
    ) as HTMLElement | null;
    expect(node).not.toBeNull();
    expect(node?.getAttribute("data-myoxus-ui-role")).toBe(
      "database-presence-avatar",
    );
  });

  test("marks dragging records with a data-dragging flag", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <DatabasePresenceDot record={makeRecord({ dragging: true })} />
      </MyoxusUIProvider>,
    );
    const dots = container.querySelectorAll(
      "[data-myoxus-database-presence-dot='true']",
    );
    expect(dots.length).toBeGreaterThan(0);
    expect(dots[0].getAttribute("data-dragging")).toBe("true");
  });
});

describe("DatabasePresenceIndicator", () => {
  test("keeps the focus boundary active before any remote user targets it", () => {
    const onFocusCapture = vi.fn();
    const { container } = render(
      <MyoxusUIProvider>
        <DatabasePresenceIndicator records={[]} onFocusCapture={onFocusCapture}>
          <button type="button">Edit cell</button>
        </DatabasePresenceIndicator>
      </MyoxusUIProvider>,
    );
    const target = container.querySelector(
      "[data-myoxus-database-presence-indicator='true']",
    );
    expect(target).not.toBeNull();
    fireEvent.focus(container.querySelector("button")!);
    expect(onFocusCapture).toHaveBeenCalledTimes(1);
  });

  test("does not remount an active editor when the first remote focus arrives", () => {
    const { rerender } = render(
      <MyoxusUIProvider>
        <DatabasePresenceIndicator records={[]}>
          <input aria-label="Cell draft" defaultValue="Initial" />
        </DatabasePresenceIndicator>
      </MyoxusUIProvider>,
    );
    const draft = document.querySelector(
      "input[aria-label='Cell draft']",
    ) as HTMLInputElement;
    fireEvent.change(draft, { target: { value: "Retained draft" } });

    rerender(
      <MyoxusUIProvider>
        <DatabasePresenceIndicator records={[makeRecord()]}>
          <input aria-label="Cell draft" defaultValue="Initial" />
        </DatabasePresenceIndicator>
      </MyoxusUIProvider>,
    );

    const afterPresence = document.querySelector(
      "input[aria-label='Cell draft']",
    ) as HTMLInputElement;
    expect(afterPresence).toBe(draft);
    expect(afterPresence.value).toBe("Retained draft");
  });

  test("renders one avatar per focused record", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <DatabasePresenceIndicator
          records={[
            makeRecord({ socketId: "a" }),
            makeRecord({ socketId: "b", userId: "u2", displayName: "Bob" }),
          ]}
        />
      </MyoxusUIProvider>,
    );
    const dots = container.querySelectorAll(
      "[data-myoxus-database-presence-dot='true']",
    );
    expect(dots.length).toBe(2);
    expect(container.textContent).toContain("A");
    expect(container.textContent).toContain("B");
  });
});

describe("DatabaseCollaboratorHeader", () => {
  const labels = {
    label: "Collaborators",
    onlyYouLabel: "Only you",
    oneCollaboratorLabel: (name: string) => `${name} is here`,
    manyCollaboratorsLabel: (count: number) => `${count} collaborators online`,
    moreLabel: (count: number) => `${count} more`,
    recordMetaLabel: (record: DatabasePresenceRecord) =>
      `${record.viewId ?? "Table"} · 12:00 AM`,
  };

  test("hides the local user from the list", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <DatabaseCollaboratorHeader
          records={[
            makeRecord({ socketId: "me" }),
            makeRecord({ socketId: "them", userId: "u2", displayName: "Bob" }),
          ]}
          localSocketId="me"
          {...labels}
        />
      </MyoxusUIProvider>,
    );
    expect(container.textContent).not.toContain("Alice is here");
    expect(container.textContent).toContain("Bob is here");
    expect(container.textContent).toContain("Table · 12:00 AM");
  });

  test("renders the empty-state copy when nobody else is here", () => {
    const { container } = render(
      <MyoxusUIProvider>
        <DatabaseCollaboratorHeader
          records={[makeRecord({ socketId: "me" })]}
          localSocketId="me"
          {...labels}
        />
      </MyoxusUIProvider>,
    );
    // The header renders a MyoxusText "Only you" — search the rendered
    // tree for that exact string.
    const allText = container.querySelectorAll("[class]");
    let found = false;
    allText.forEach((node) => {
      if (node.textContent === "Only you") found = true;
    });
    expect(found).toBe(true);
    expect(container.textContent).toContain("Table · 12:00 AM");
  });

  test("collapses overflow avatars into a +N badge", () => {
    const records = Array.from({ length: 7 }, (_, index) =>
      makeRecord({
        socketId: `s${index}`,
        userId: `u${index}`,
        displayName: `User ${index}`,
      }),
    );
    const { container } = render(
      <MyoxusUIProvider>
        <DatabaseCollaboratorHeader
          records={records}
          maxAvatars={3}
          {...labels}
        />
      </MyoxusUIProvider>,
    );
    const dots = container.querySelectorAll(
      "[data-myoxus-database-presence-dot='true']",
    );
    expect(dots.length).toBe(3); // only first 3 rendered
    const badges = Array.from(container.querySelectorAll("[aria-label]")).find(
      (node) => node.getAttribute("aria-label")?.endsWith("more"),
    );
    expect(badges).not.toBeUndefined();
  });
});
