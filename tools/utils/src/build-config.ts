import type { Package } from "@myoxus-tools/utils/workspace";

import { PackageToDistribution } from "./distribution";
import { PUBLIC_PROJECT_URLS } from "./public-urls";

export interface BuildFlags {
  channel: "stable" | "beta" | "internal";
  mode: "development" | "production";
}

export function getBuildConfig(
  pkg: Package,
  buildFlags: BuildFlags,
): BUILD_CONFIG_TYPE {
  const distribution = PackageToDistribution.get(pkg.name);

  if (!distribution) {
    throw new Error(`Distribution for ${pkg.name} is not found`);
  }

  // Web/Admin/mobile identity is owned by the root workspace manifest. The
  // independently releasable desktop train is owned by Electron's manifest.
  const clientVersion =
    distribution === "desktop"
      ? pkg.workspace.getPackage("@myoxus/electron").packageJson.version
      : pkg.workspace.version;
  if (typeof clientVersion !== "string" || !clientVersion) {
    throw new Error(`Product version for ${distribution} is not declared`);
  }
  const projectUrl = PUBLIC_PROJECT_URLS.repository;
  const releasesUrl = PUBLIC_PROJECT_URLS.releases;
  const issuesUrl = PUBLIC_PROJECT_URLS.issues;
  const docsUrl = PUBLIC_PROJECT_URLS.documentation;
  const websiteUrl = projectUrl;
  const blogUrl = PUBLIC_PROJECT_URLS.downloads;
  const communityUrl = issuesUrl;
  const contactUrl = issuesUrl;
  const buildPreset: Record<BuildFlags["channel"], BUILD_CONFIG_TYPE> = {
    get stable() {
      return {
        debug: buildFlags.mode === "development",
        distribution,
        isDesktopEdition: (
          ["web", "desktop", "admin"] as BUILD_CONFIG_TYPE["distribution"][]
        ).includes(distribution),
        isMobileEdition: (
          ["mobile", "ios", "android"] as BUILD_CONFIG_TYPE["distribution"][]
        ).includes(distribution),
        isElectron: distribution === "desktop",
        isWeb: distribution === "web",
        isMobileWeb: distribution === "mobile",
        isIOS: distribution === "ios",
        isAndroid: distribution === "android",
        isNative:
          distribution === "desktop" ||
          distribution === "ios" ||
          distribution === "android",
        isAdmin: distribution === "admin",

        appBuildType: "stable" as const,
        appVersion: clientVersion,
        editorVersion: clientVersion,
        githubUrl: projectUrl,
        websiteUrl,
        docsUrl,
        blogUrl,
        communityUrl,
        contactUrl,
        licenseUrl: PUBLIC_PROJECT_URLS.license,
        securityUrl: PUBLIC_PROJECT_URLS.security,
        operatorGuideUrl: PUBLIC_PROJECT_URLS.operatorGuide,
        upgradeGuideUrl: PUBLIC_PROJECT_URLS.upgradeGuide,
        releaseNotesUrl: releasesUrl,
        changelogUrl: releasesUrl,
        downloadUrl: PUBLIC_PROJECT_URLS.downloads,
        pricingUrl: docsUrl,

        requestLicenseUrl: issuesUrl,
        imageProxyUrl: "/api/worker/image-proxy",
        linkPreviewUrl: "/api/worker/link-preview",
        SENTRY_DSN: process.env.SENTRY_DSN ?? "",
      };
    },
    get beta() {
      return {
        ...this.stable,
        appBuildType: "beta" as const,
        changelogUrl: releasesUrl,
      };
    },
    get internal() {
      return {
        ...this.stable,
        appBuildType: "internal" as const,
        changelogUrl: releasesUrl,
      };
    },
  };

  const currentBuild = buildFlags.channel;

  if (!(currentBuild in buildPreset)) {
    throw new Error(`BUILD_TYPE ${currentBuild} is not supported`);
  }

  const currentBuildPreset = buildPreset[currentBuild];

  const environmentPreset = {
    changelogUrl: process.env.CHANGELOG_URL ?? currentBuildPreset.changelogUrl,
  };

  return {
    ...currentBuildPreset,
    // environment preset will overwrite current build preset
    // this environment variable is for debug proposes only
    // do not put them into CI
    ...(process.env.CI ? {} : environmentPreset),
  };
}
