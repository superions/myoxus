import type { ReactElement } from "react";
/** @vitest-environment happy-dom */

import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../libs/i18n/src/resources/en.json";
const en: Record<string, string> = enJson;

vi.mock("@myoxus/i18n", () => ({
  I18n: new Proxy(
    {},
    { get: (_target, key) => () => en[String(key)] ?? String(key) },
  ),
  useI18n: () => ({
    "com.myoxus.peek-view-controls.close": () =>
      en["com.myoxus.peek-view-controls.close"],
    t: (key: string, options?: Record<string, unknown>): string => {
      let text = en[key] ?? key;
      if (options) {
        Object.entries(options).forEach(([k, v]) => {
          text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
        });
      }
      return text;
    },
  }),
}));

const presetTeam = {
  id: "p-team",
  organizationId: "o-1",
  key: "team",
  label: "Team",
  description: null,
  icon: null,
  color: null,
  isPreset: true,
  isActive: true,
  isStructural: false,
  canHaveChildren: true,
  canBeRootLevel: true,
  canBeManagerCreated: true,
  canHaveCrossUnitMembers: false,
  canOwnWorkspaces: true,
  canManageWorkspaces: true,
  isStaffUnit: false,
  requiresAdminApproval: false,
  metadata: {},
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

const customMix = {
  ...presetTeam,
  id: "c-mix",
  key: "mix-board",
  label: "Mixed Board",
  isPreset: false,
  isActive: true,
  canHaveChildren: false,
  canOwnWorkspaces: false,
};

const presetPackages = [
  ["p-kvg", "kvg.amt", "Amt"],
  ["p-kvk", "kvk.fachbereich", "Fachbereich"],
  ["p-wt", "wt.bereich", "Bereich"],
  ["p-mx", "mx.projekt", "Matrix-Projekt"],
].map(([id, key, label]) => ({
  ...presetTeam,
  id,
  key,
  label,
}));

const apiMocks = vi.hoisted(() => ({
  mutate: vi.fn(async () => undefined),
  trigger: vi.fn(async (_arg: unknown) => undefined),
  organizationMetadata: {} as Record<string, unknown>,
}));

vi.mock("./api", () => {
  const empty = { isLoading: false, mutate: apiMocks.mutate };
  const mut = { trigger: apiMocks.trigger, isMutating: false };
  return {
    useOrganizationQuery: () => ({
      ...empty,
      organization: {
        id: "o-1",
        key: "myoxus",
        name: "Myoxus",
        slug: "myoxus",
        metadata: apiMocks.organizationMetadata,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    }),
    useOrganizationUnitTypesQuery: () => ({
      ...empty,
      types: [presetTeam, ...presetPackages, customMix],
    }),
    useUpdateOrganizationMutation: () => mut,
    useUpsertOrganizationUnitTypeMutation: () => mut,
    useDeactivateOrganizationUnitTypeMutation: () => mut,
  };
});

import { UnitTypesTab } from "./unit-types-tab";

function renderWithProvider(node: ReactElement) {
  return render(<MyoxusUIProvider>{node}</MyoxusUIProvider>);
}

afterEach(() => {
  cleanup();
  apiMocks.mutate.mockClear();
  apiMocks.trigger.mockClear();
  apiMocks.organizationMetadata = {};
});

describe("UnitTypesTab", () => {
  test("selecting small municipal persists unit_type_catalog metadata", async () => {
    renderWithProvider(<UnitTypesTab />);

    fireEvent.click(screen.getByTestId("organization-unit-type-catalog-kvk"));

    await waitFor(() => expect(apiMocks.trigger).toHaveBeenCalledTimes(1));
    expect(apiMocks.trigger.mock.calls[0][0]).toMatchObject({
      input: {
        metadata: {
          unit_type_catalog: {
            schema_version: 1,
            id: "kvk",
          },
        },
      },
    });
  });
});
