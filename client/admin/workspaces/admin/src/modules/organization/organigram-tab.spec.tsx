/**
 * @vitest-environment happy-dom
 */
// SPDX-License-Identifier: AGPL-3.0-or-later
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>): string => {
      let text = en[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        });
      }
      return text;
    },
    language: "en",
  }),
}));

vi.mock("./unit-detail", () => ({
  UnitDetail: ({ unit }: { unit: { name: string } | null }) => (
    <aside data-testid="organigram-inspector">
      {unit?.name ?? "no selection"}
    </aside>
  ),
}));

const root = {
  id: "u-root",
  organizationId: "o-1",
  parentUnitId: null,
  unitTypeId: "t-default",
  name: "City Administration",
  slug: "city",
  description: null,
  status: "ACTIVE",
  metadata: {},
  childUnitCount: 1,
  memberCount: 3,
  workspaceCount: 2,
  createdBy: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const child = {
  ...root,
  id: "u-child",
  parentUnitId: "u-root",
  name: "Civil Office",
  slug: "civil-office",
  childUnitCount: 0,
  memberCount: 1,
  workspaceCount: 0,
};
const type = {
  id: "t-default",
  key: "team",
  label: "Team",
  isActive: true,
  isPreset: true,
};

vi.mock("./api", () => {
  const empty = { isLoading: false, mutate: vi.fn() };
  return {
    useOrganizationQuery: () => ({
      ...empty,
      organization: {
        id: "o-1",
        key: "myoxus",
        name: "Myoxus",
        slug: "myoxus",
        metadata: {},
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }),
    useOrganizationUnitsQuery: () => ({ ...empty, units: [root, child] }),
    useOrganizationUnitTypesQuery: () => ({ ...empty, types: [type] }),
  };
});

import { OrganigramTab } from "./organigram-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

afterEach(() => cleanup());

describe("OrganigramTab", () => {
  test("renders hierarchy counts and opens the right inspector on node click", () => {
    renderWithProvider(<OrganigramTab />);

    expect(
      screen.getByTestId("organization-organigram-node-u-root"),
    ).toBeTruthy();
    expect(screen.getByText(/1 child units/i)).toBeTruthy();
    expect(screen.getAllByText("Active").length).toBeGreaterThan(0);
    expect(screen.queryByText("active")).toBeNull();
    expect(screen.getByTestId("organigram-inspector").textContent).toContain(
      "City Administration",
    );

    fireEvent.click(screen.getByTestId("organization-organigram-node-u-child"));

    expect(screen.getByTestId("organigram-inspector").textContent).toContain(
      "Civil Office",
    );
  });
});
