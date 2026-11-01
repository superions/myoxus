import { describe, expect, it, vi } from "vitest";

import { resolveLazyRouteModule } from "../lazy";
import { FACTORIES, RELATIVE_ROUTES, ROUTES } from "../routes";

describe("PATH_FACTORIES", () => {
  it("should generate correct paths", () => {
    expect(
      FACTORIES.admin.organization.unit({
        id: "unit-123",
      }),
    ).toBe("/adminfrontend/organization/units/unit-123");
    expect(FACTORIES.admin.organization.organigram()).toBe(
      "/adminfrontend/organization/organigram",
    );
    expect(FACTORIES.admin.system()).toBe("/adminfrontend/system");
  });

  it("does not expose deleted admin top-level routes", () => {
    const adminRoutes = ROUTES.admin as Record<string, unknown>;
    const relativeAdminRoutes = RELATIVE_ROUTES.admin as Record<
      string,
      unknown
    >;
    const adminFactories = FACTORIES.admin as unknown as Record<
      string,
      unknown
    >;

    for (const legacy of [
      "accounts",
      "teams",
      "about",
      "settings",
      "logging",
      "orphanedWorkspaces",
    ]) {
      expect(adminRoutes[legacy]).toBeUndefined();
      expect(relativeAdminRoutes[legacy]).toBeUndefined();
      expect(adminFactories[legacy]).toBeUndefined();
    }
  });
});

describe("lazy route module resolution", () => {
  it("prefers the explicit Component route export without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Component = () => null;
    const Helper = () => null;

    expect(resolveLazyRouteModule({ Helper, Component })).toEqual({
      default: Component,
    });
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
