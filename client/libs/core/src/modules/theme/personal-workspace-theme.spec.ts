// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  resetPersonalWorkspaceThemeMutation,
  setPersonalWorkspaceThemeMutation,
} from "@myoxus/graphql";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  inheritPersonalWorkspaceTheme,
  selectPersonalWorkspaceTheme,
} from "./personal-workspace-theme";

describe("personal workspace theme adapter", () => {
  const NativeBroadcastChannel = globalThis.BroadcastChannel;

  afterEach(() => {
    globalThis.BroadcastChannel = NativeBroadcastChannel;
  });

  test("uses the typed set/reset contracts and refreshes runtime theme CSS", async () => {
    const postMessage = vi.fn();
    const close = vi.fn();
    globalThis.BroadcastChannel = class {
      postMessage = postMessage;
      close = close;
    } as unknown as typeof BroadcastChannel;

    const gql = vi.fn(async ({ query }) => {
      if (query === setPersonalWorkspaceThemeMutation) {
        return {
          setPersonalWorkspaceTheme: {
            workspaceId: "personal-workspace",
            themeSlug: "hamburg",
            themeName: "Hamburg",
            inheritsGlobal: false,
          },
        };
      }
      return {
        resetPersonalWorkspaceTheme: {
          workspaceId: "personal-workspace",
          themeSlug: "stuttgart",
          themeName: "Stuttgart",
          inheritsGlobal: true,
        },
      };
    });

    await selectPersonalWorkspaceTheme(
      { gql } as never,
      "personal-workspace",
      "hamburg",
    );
    await inheritPersonalWorkspaceTheme({ gql } as never, "personal-workspace");

    expect(gql).toHaveBeenNthCalledWith(1, {
      query: setPersonalWorkspaceThemeMutation,
      variables: {
        input: {
          workspaceId: "personal-workspace",
          themeSlug: "hamburg",
        },
      },
    });
    expect(gql).toHaveBeenNthCalledWith(2, {
      query: resetPersonalWorkspaceThemeMutation,
      variables: { workspaceId: "personal-workspace" },
    });
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith("branding-updated");
    expect(close).toHaveBeenCalledTimes(2);
  });
});
