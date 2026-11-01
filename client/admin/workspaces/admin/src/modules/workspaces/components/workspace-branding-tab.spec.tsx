/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";
import type { ThemeProfile } from "../../theme/theme-contract";

const en: Record<string, string> = enJson;
const theme = {
  slug: "stuttgart",
  name: "Stuttgart",
  origin: "system",
  locked: true,
  isDefault: true,
  colors: {},
  typographyStyles: [],
};
const profile: ThemeProfile = {
  scope: "workspace",
  workspaceId: "ws-1",
  themeMode: "system",
  theme,
};
const loadCatalog = vi.fn();
const loadProfile = vi.fn();
const loadGlobal = vi.fn();
const save = vi.fn();
const reset = vi.fn();
const success = vi.fn();
const failure = vi.fn();
type Resource = { error?: Error; isLoading: boolean };
let catalogState: Resource & { catalog?: object; themes: (typeof theme)[] };
let profileState: Resource & { profile?: ThemeProfile };
let globalState: Resource & { profile?: ThemeProfile };

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
  }),
}));
vi.mock("@myoxus/admin/notifications", () => ({
  adminToast: {
    success: (...args: unknown[]) => success(...args),
    error: (...args: unknown[]) => failure(...args),
  },
}));
vi.mock("../../theme/theme-api", () => ({
  useThemeCatalogQuery: () => ({ ...catalogState, mutate: loadCatalog }),
  useEffectiveThemeProfileQuery: (id: string | null) =>
    id === null
      ? { ...globalState, mutate: loadGlobal }
      : { ...profileState, mutate: loadProfile },
  useSetThemeProfileMutation: () => ({
    setThemeProfile: save,
    isMutating: false,
  }),
  useResetWorkspaceThemeProfileMutation: () => ({
    resetWorkspaceThemeProfile: reset,
    isMutating: false,
  }),
}));
vi.mock("../../design/theme-gallery", () => ({
  ThemeGallery: ({
    onSelectPreset,
    onSelectMode,
    isSaving,
  }: {
    onSelectPreset: (slug: string) => void;
    onSelectMode: (mode: "dark") => void;
    isSaving: boolean;
  }) => (
    <>
      <button disabled={isSaving} onClick={() => onSelectPreset("hamburg")}>
        Select Hamburg
      </button>
      <button disabled={isSaving} onClick={() => onSelectMode("dark")}>
        Dark mode
      </button>
    </>
  ),
}));
vi.mock("../../design/tabs/colors-tab", () => ({
  ColorsTab: function ColorDraft() {
    const [draft, setDraft] = useState("server color");
    return (
      <input
        aria-label="Color draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
    );
  },
}));
vi.mock("../../typography/scoped-typography-editor", () => ({
  ScopedTypographyEditor: () => null,
}));

import { WorkspaceBrandingTab } from "./workspace-branding-tab";

function ui() {
  return (
    <MyoxusUIProvider>
      <WorkspaceBrandingTab workspaceId="ws-1" workspaceName="Alpha" />
    </MyoxusUIProvider>
  );
}

describe("WorkspaceBrandingTab resource and operation ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const read of [loadCatalog, loadProfile, loadGlobal])
      read.mockReset().mockResolvedValue(undefined);
    save.mockReset().mockResolvedValue(profile);
    reset.mockReset().mockResolvedValue({ ...profile, scope: "global" });
    catalogState = { catalog: {}, themes: [theme], isLoading: false };
    profileState = { profile, isLoading: false };
    globalState = {
      profile: { ...profile, scope: "global", workspaceId: null },
      isLoading: false,
    };
  });
  afterEach(cleanup);

  test.each(["catalog"])(
    "%s failure cannot claim inheritance or offer fallback theme writes",
    async (owner) => {
      const state =
        owner === "catalog"
          ? catalogState
          : owner === "workspace"
            ? profileState
            : globalState;
      state.error = new Error("Profile unavailable");
      if (owner === "catalog") catalogState.catalog = undefined;
      else (state as typeof profileState).profile = undefined;
      const view = render(ui());
      expect(screen.getByRole("alert").textContent).toContain(
        "Profile unavailable",
      );
      expect(
        screen.queryByText(en["admin.workspaces.branding.inherited"]),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Select Hamburg" }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(1));
      expect(loadCatalog).toHaveBeenCalledTimes(1);
      expect(loadGlobal).toHaveBeenCalledTimes(1);
      expect(save).not.toHaveBeenCalled();
      expect(reset).not.toHaveBeenCalled();
      state.error = undefined;
      catalogState.catalog = {};
      profileState.profile = profile;
      globalState.profile = { ...profile, scope: "global" };
      view.rerender(ui());
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(
        screen.getByRole("button", { name: "Select Hamburg" }),
      ).toHaveProperty("disabled", false);
    },
  );

  test("background query recovery keeps the color draft mounted and blocks stale writes", async () => {
    const view = render(ui());
    fireEvent.change(screen.getByRole("textbox", { name: "Color draft" }), {
      target: { value: "unsaved color" },
    });
    profileState.error = new Error("Read unavailable");
    view.rerender(ui());
    const draft = screen.getByRole("textbox", { name: "Color draft" });
    expect(draft).toHaveProperty("value", "unsaved color");
    expect(draft.closest("fieldset")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Select Hamburg" }));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(loadProfile).toHaveBeenCalledTimes(1));
    profileState.error = undefined;
    view.rerender(ui());
    await waitFor(() =>
      expect(draft.closest("fieldset")).toHaveProperty("disabled", false),
    );
    expect(draft).toHaveProperty("value", "unsaved color");
  });

  test("preset and reset cannot overlap while the mutation helper still reads back", async () => {
    let finish!: (value: ThemeProfile) => void;
    save.mockImplementation(
      () =>
        new Promise<ThemeProfile>((resolve) => {
          finish = resolve;
        }),
    );
    render(ui());
    fireEvent.click(screen.getByRole("button", { name: "Select Hamburg" }));
    expect(save).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      themeSlug: "hamburg",
      themeMode: "system",
    });
    expect(screen.getByTestId("workspace-branding-reset")).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Dark mode" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByTestId("workspace-branding-reset"));
    fireEvent.click(screen.getByRole("button", { name: "Select Hamburg" }));
    expect(reset).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
    expect(success).not.toHaveBeenCalled();
    finish(profile);
    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("workspace-branding-reset")).toHaveProperty(
      "disabled",
      false,
    );
  });
});
