// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

const activeBrandingFiles = [
  "client/libs/core/src/modules/open-in-app/views/open-in-app-page.tsx",
  "client/libs/core/src/modules/app-sidebar/views/open-in-app-card/open-in-app-card.tsx",
  "client/libs/core/src/desktop/dialogs/setting/general-setting/about/index.tsx",
  "client/libs/core/src/utils/channel.ts",
  "client/apps/electron-renderer/src/popup/recording/index.tsx",
];

const deletedOpenInAppCssFiles = [
  "client/libs/core/src/desktop/pages/open-app/open-app.css",
  "client/libs/core/src/desktop/pages/open-app/open-app.styles.ts",
  "client/libs/core/src/modules/open-in-app/views/open-in-app-page.css",
  "client/libs/core/src/modules/open-in-app/views/open-in-app-page.styles.ts",
];

const deletedChannelIconAssets = [
  "client/libs/core/public/imgs/app-icon-stable.ico",
  "client/libs/core/public/imgs/app-icon-beta.ico",
  "client/libs/core/public/imgs/app-icon-internal.ico",
  "client/libs/core/public/imgs/app-icon-canary.ico",
  "client/apps/electron/resources/web-static/imgs/app-icon-stable.ico",
  "client/apps/electron/resources/web-static/imgs/app-icon-beta.ico",
  "client/apps/electron/resources/web-static/imgs/app-icon-internal.ico",
  "client/apps/electron/resources/web-static/imgs/app-icon-canary.ico",
  "client/web/static/imgs/app-icon-stable.ico",
  "client/web/static/imgs/app-icon-beta.ico",
  "client/web/static/imgs/app-icon-internal.ico",
  "client/web/static/imgs/app-icon-canary.ico",
  "client/admin/static/imgs/app-icon-stable.ico",
  "client/admin/static/imgs/app-icon-beta.ico",
  "client/admin/static/imgs/app-icon-internal.ico",
  "client/admin/static/imgs/app-icon-canary.ico",
];

const generatedChannelIconAssets = [
  "client/web/workspaces/web/dist/imgs/app-icon-stable.ico",
  "client/web/workspaces/web/dist/imgs/app-icon-beta.ico",
  "client/web/workspaces/web/dist/imgs/app-icon-internal.ico",
  "client/web/workspaces/web/dist/imgs/app-icon-canary.ico",
];

const generatedAffineLogoAssets = [
  "client/apps/electron/resources/web-static/assets/AFFiNE.57e53ebe.svg",
  "client/apps/electron/resources/web-static/assets/AFFiNE.c8e1713f.svg",
  "client/apps/electron/resources/web-static/assets/AFFiNE AI.88c1a626.svg",
  "client/apps/electron/resources/web-static/assets/AFFiNE AI.d73f7c59.svg",
];

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

function sha256(path: string): string {
  return createHash("sha256")
    .update(readFileSync(join(repoRoot, path)))
    .digest("hex");
}

describe("open-in-app branding contract", () => {
  test("uses runtime Myoxus branding instead of static channel app icons", () => {
    for (const file of deletedOpenInAppCssFiles) {
      expect(
        statSync(join(repoRoot, file), { throwIfNoEntry: false }),
        file,
      ).toBeUndefined();
    }

    for (const file of activeBrandingFiles) {
      const source = readRepoFile(file);
      expect(source, file).not.toContain("appIconMap");
      expect(source, file).not.toContain("affineLogo");
      expect(source, file).not.toContain("/imgs/app-icon-");
    }

    expect(
      readRepoFile(
        "client/libs/core/src/modules/open-in-app/views/open-in-app-page.tsx",
      ),
    ).toContain("MyoxusOtherPageLayout");
    const openInAppPage = readRepoFile(
      "client/libs/core/src/modules/open-in-app/views/open-in-app-page.tsx",
    );
    expect(openInAppPage).toContain("OtherPageHeroProductMark");
    expect(openInAppPage).toContain("InlineActionButton");
    expect(openInAppPage).toContain("InlineLink");
    expect(openInAppPage).not.toContain("BrandAssetImage");
    expect(openInAppPage).not.toContain("MyoxusIcon");
    expect(openInAppPage).not.toContain("Logo1Icon");
    expect(openInAppPage).not.toContain("./open-in-app-page.styles");
    expect(openInAppPage).not.toContain("styles.");
    expect(openInAppPage).not.toContain("<button");
    expect(openInAppPage).not.toMatch(/\b\d+px\b/);
    expect(openInAppPage).not.toMatch(/\b(?:width|height)=\{[0-9]/);
    expect(
      readRepoFile(
        "client/libs/core/src/modules/app-sidebar/views/open-in-app-card/open-in-app-card.tsx",
      ),
    ).toContain("SidebarPromoProductMark");
    const facadeSource = readRepoFile(
      "client/libs/ui-facade/src/auth-layout.tsx",
    );
    const sidebarSource = readRepoFile(
      "client/libs/ui-facade/src/shell/sidebar-identity.tsx",
    );
    expect(sidebarSource).toContain("function SidebarPromoProductMark");
    expect(sidebarSource).toContain("function useDocumentHasDialog");
    expect(sidebarSource).toContain("hideOnDialog = true");
    expect(sidebarSource).toContain(
      'zIndex: `calc(${cssVar("zIndexModal")} - 1)`',
    );
    expect(facadeSource).toContain("function OtherPageHeroProductMark");
    expect(facadeSource).toContain("BrandAssetImage");
    expect(
      readRepoFile(
        "client/libs/core/src/modules/app-sidebar/views/open-in-app-card/open-in-app-card.tsx",
      ),
    ).not.toContain("Logo1Icon");
    expect(sidebarSource).toContain("product-mark.svg");
    expect(
      readRepoFile(
        "client/libs/core/src/modules/app-sidebar/views/open-in-app-card/open-in-app-card.tsx",
      ),
    ).not.toContain("MyoxusIcon");
  });

  test("does not ship stale static channel icon assets", () => {
    for (const file of deletedChannelIconAssets) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false);
    }
  });

  test("generated static outputs do not keep stale AFFiNE channel branding", () => {
    const fallbackHash = sha256("client/libs/core/public/favicon.ico");

    for (const file of generatedChannelIconAssets) {
      if (!existsSync(join(repoRoot, file))) continue;
      expect(sha256(file), file).toBe(fallbackHash);
    }

    for (const file of generatedAffineLogoAssets) {
      expect(existsSync(join(repoRoot, file)), file).toBe(false);
    }
  });
});
