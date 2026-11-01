// SPDX-License-Identifier: AGPL-3.0-or-later

// @vitest-environment node

import { expect, it, vi } from "vitest";

const host = vi.hoisted(() => {
  let listener: ((language: string) => void) | undefined;
  return {
    I18n: {
      language: "de",
      on: vi.fn((event: string, callback: (language: string) => void) => {
        if (event === "languageChanged") listener = callback;
      }),
      t: vi.fn(
        (key: string, fallback: string, values: unknown) =>
          `${key}:${fallback}:${JSON.stringify(values)}`,
      ),
    },
    change(language: string) {
      this.I18n.language = language;
      listener?.(language);
    },
  };
});
vi.mock("@myoxus/i18n", () => ({ I18n: host.I18n }));

it("shares one account listener across editor mounts and forwards interpolation", async () => {
  const { configureEditorI18n } = await import("./editor-i18n");
  const first = configureEditorI18n();
  const second = configureEditorI18n();
  expect(host.I18n.on).toHaveBeenCalledTimes(1);
  expect(first.locale$).toBe(second.locale$);
  host.change("fr");
  expect(first.locale$.value).toBe("fr");
  expect(second.locale$.value).toBe("fr");
  configureEditorI18n();
  expect(host.I18n.on).toHaveBeenCalledTimes(1);
  first.translate({
    key: "com.myoxus.editor.slash.heading-tooltip",
    fallback: "Heading #{{number}}",
    values: { number: 2 },
  });
  expect(host.I18n.t).toHaveBeenCalledWith(
    "com.myoxus.editor.slash.heading-tooltip",
    "Heading #{{number}}",
    { number: 2 },
  );
});
