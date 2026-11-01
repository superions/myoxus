import { setupGlobal } from "@myoxus/env/global";
import { getBuildConfig } from "@myoxus-tools/utils/build-config";
import { Workspace } from "@myoxus-tools/utils/workspace";

const workspace = new Workspace();

globalThis.BUILD_CONFIG = {
  ...getBuildConfig(workspace.getPackage("@myoxus/web"), {
    mode: "development",
    channel: "stable",
  }),
  // Unit tests need development feature flags, but not the global debug logger.
  // Leaving debug enabled makes Vitest emit massive vite-node traces and can
  // turn rebuild gates into apparent hangs while they buffer stderr.
  debug: false,
};

if (typeof window !== "undefined") {
  window.location.search = "?prefixUrl=http://127.0.0.1:3010/";
}

setupGlobal();
