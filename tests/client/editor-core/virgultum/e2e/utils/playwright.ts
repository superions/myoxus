import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { test as baseTest } from "@playwright/test";
import {
  DEFAULT_THEME,
  defaultCssVariablesResolver,
  mergeMantineTheme,
} from "@mantine/core";

import { myoxusMantineDensity } from "../../../../../../client/libs/ui-facade/src/theme-density";

import { scope } from "./multiple-editor.js";

const istanbulTempDir = process.env.ISTANBUL_TEMP_DIR
  ? path.resolve(process.env.ISTANBUL_TEMP_DIR)
  : path.join(process.cwd(), ".nyc_output");

function generateUUID() {
  return crypto.randomUUID();
}

const enableCoverage = !!process.env.CI || !!process.env.COVERAGE;
// Base Mantine CSS uses different defaults from the actual Facade provider.
// Project only its shared density, without mounting React or replacing branding.
const densityVariables = defaultCssVariablesResolver(
  mergeMantineTheme(DEFAULT_THEME, myoxusMantineDensity),
).variables;
const densityCss = `:root {${Object.entries(densityVariables)
  .filter(
    ([key]) =>
      key.startsWith("--mantine-spacing-") ||
      key.startsWith("--mantine-radius-"),
  )
  .map(([key, value]) => `${key}: ${value};`)
  .join("\n")}}`;
export const scoped = (stringsArray: TemplateStringsArray) => {
  return `${scope ?? ""}${stringsArray.join()}`;
};
export const test = baseTest.extend<{}>({
  page: async ({ page }, use) => {
    // The isolated renderer has no Facade shell. Reuse its real base stylesheet
    // so editor insets and outside-column controls resolve Mantine spacing;
    // this is not a client-authored theme or a replacement for server branding.
    await page.addInitScript(
      (css) => {
        document.addEventListener(
          "DOMContentLoaded",
          () => {
            const style = document.createElement("style");
            // The renderer's 1280px sample canvas is not a browser viewport.
            // Bound Page's real scroll owner just as the consuming app does.
            style.textContent = `${css}\n.myoxus-page-viewport { height: 100vh; }`;
            document.head.append(style);
          },
          { once: true },
        );
      },
      fs.readFileSync(
        new URL(import.meta.resolve("@mantine/core/styles.css")),
        "utf8",
      ) + densityCss,
    );
    await use(page);
  },
  context: async ({ context }, use) => {
    if (enableCoverage) {
      await context.addInitScript(() =>
        window.addEventListener("beforeunload", () =>
          // @ts-expect-error
          window.collectIstanbulCoverage(JSON.stringify(window.__coverage__)),
        ),
      );

      await fs.promises.mkdir(istanbulTempDir, { recursive: true });
      await context.exposeFunction(
        "collectIstanbulCoverage",
        (coverageJSON?: string) => {
          if (coverageJSON)
            fs.writeFileSync(
              path.join(
                istanbulTempDir,
                `playwright_coverage_${generateUUID()}.json`,
              ),
              coverageJSON,
            );
        },
      );
    }
    await use(context);
    if (enableCoverage) {
      for (const page of context.pages()) {
        await page.evaluate(() =>
          // @ts-expect-error
          window.collectIstanbulCoverage(JSON.stringify(window.__coverage__)),
        );
      }
    }
  },
});
