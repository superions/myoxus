import { glob } from "node:fs/promises";
import { resolve } from "node:path";

/** Source inventory for cleanup; generated resources and build output never
 * establish live translation-key usage. Return absolute paths for file reads. */
export async function findTranslationSources(root: string): Promise<string[]> {
  const paths = await Array.fromAsync(
    glob(["client/**/*.{js,jsx,ts,tsx}", "virgultum/**/*.{js,jsx,ts,tsx}"], {
      cwd: root,
      exclude: [
        "**/node_modules/**",
        "client/libs/i18n/src/resources/**",
        "client/libs/i18n/src/i18n.gen.ts",
        "**/dist/**",
        "**/lib/**",
      ],
    }),
  );
  return paths.map((path) => resolve(root, path));
}
