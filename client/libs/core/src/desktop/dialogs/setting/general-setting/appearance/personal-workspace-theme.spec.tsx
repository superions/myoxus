// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  profile: { value: { workspaceType: "Shared" } as { workspaceType: string } },
  graphqlService: { gql: vi.fn() },
  load: vi.fn(),
  select: vi.fn(),
  inherit: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("@myoxus/core/modules/server", () => ({
  GraphQLService: class GraphQLService {},
}));

vi.mock("@myoxus/core/components/hooks/use-workspace-info", () => ({
  useWorkspaceInfo: () => mocks.profile.value,
}));

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class WorkspaceService {},
}));

vi.mock("@myoxus/core/modules/theme", () => ({
  loadPersonalWorkspaceTheme: mocks.load,
  selectPersonalWorkspaceTheme: mocks.select,
  inheritPersonalWorkspaceTheme: mocks.inherit,
}));

vi.mock("@myoxus/infra", () => ({
  useService: (Service: { name: string }) =>
    Service.name === "GraphQLService"
      ? mocks.graphqlService
      : {
          workspace: {
            id: "personal-workspace",
            meta: {
              id: "personal-workspace",
              flavour: "myoxus-cloud",
            },
          },
        },
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () =>
    new Proxy(
      {},
      {
        get: (_target, key: string) => () => key,
      },
    ),
}));

vi.mock("../../primitives", () => ({
  FormSelect: ({
    data,
    disabled,
    error: _error,
    loading: _loading,
    onChange,
    value,
    ...props
  }: {
    data: Array<{ label: string; value: string }>;
    disabled?: boolean;
    error?: ReactNode;
    loading?: boolean;
    onChange: (value: string) => void;
    value?: string;
    [key: string]: unknown;
  }) => (
    <select
      {...props}
      disabled={disabled}
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value)}
    >
      {data.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  SettingsField: ({
    children,
    "data-testid": testId,
  }: {
    children: ReactNode;
    "data-testid"?: string;
  }) => <div data-testid={testId}>{children}</div>,
  notify: { error: mocks.notifyError },
}));

import { PersonalWorkspaceThemeSettings } from "./personal-workspace-theme";

const themeState = {
  personalWorkspaceThemeCatalog: [
    { slug: "stuttgart", name: "Stuttgart", isDefault: true },
    { slug: "hamburg", name: "Hamburg", isDefault: false },
  ],
  personalWorkspaceThemeSelection: {
    workspaceId: "personal-workspace",
    themeSlug: "stuttgart",
    themeName: "Stuttgart",
    inheritsGlobal: true,
  },
};

describe("PersonalWorkspaceThemeSettings", () => {
  beforeEach(() => {
    mocks.profile.value = { workspaceType: "Shared" };
    mocks.load.mockReset().mockResolvedValue(themeState);
    mocks.select.mockReset().mockResolvedValue({
      ...themeState.personalWorkspaceThemeSelection,
      themeSlug: "hamburg",
      themeName: "Hamburg",
      inheritsGlobal: false,
    });
    mocks.inherit.mockReset();
    mocks.notifyError.mockReset();
  });

  test.each(["Shared", "Team", "UserOwned"])(
    "does not expose or query the theme selector in a %s workspace",
    (workspaceType) => {
      mocks.profile.value = { workspaceType };
      render(<PersonalWorkspaceThemeSettings />);

      expect(
        screen.queryByTestId("personal-workspace-theme-setting"),
      ).toBeNull();
      expect(mocks.load).not.toHaveBeenCalled();
    },
  );

  test("loads and changes the theme in the canonical personal workspace", async () => {
    mocks.profile.value = { workspaceType: "Personal" };
    render(<PersonalWorkspaceThemeSettings />);

    const select = await screen.findByTestId("personal-workspace-theme-select");
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith(
        mocks.graphqlService,
        "personal-workspace",
      ),
    );

    fireEvent.change(select, { target: { value: "hamburg" } });
    await waitFor(() =>
      expect(mocks.select).toHaveBeenCalledWith(
        mocks.graphqlService,
        "personal-workspace",
        "hamburg",
      ),
    );
  });
});
