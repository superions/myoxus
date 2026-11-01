import { z } from "zod";

export const ReleaseTypeSchema = z.enum(["stable", "beta", "internal"]);

declare global {
  // THIS variable should be replaced during the build process
  const REPLACE_ME_BUILD_ENV: string;
  const REPLACE_ME_ELECTRON_E2E: boolean;
  const REPLACE_ME_ELECTRON_E2E_UPDATE_FEED: string | null;
}

export const envBuildType = (process.env.BUILD_TYPE || REPLACE_ME_BUILD_ENV)
  .trim()
  .toLowerCase();

export const overrideSession = process.env.BUILD_TYPE === "internal";

export const buildType = ReleaseTypeSchema.parse(envBuildType);

export const mode = process.env.NODE_ENV;
export const isDev = mode === "development";

export const electronE2e =
  typeof REPLACE_ME_ELECTRON_E2E === "boolean"
    ? REPLACE_ME_ELECTRON_E2E
    : false;
export const electronE2eUpdateFeed =
  typeof REPLACE_ME_ELECTRON_E2E_UPDATE_FEED === "string"
    ? REPLACE_ME_ELECTRON_E2E_UPDATE_FEED
    : null;
