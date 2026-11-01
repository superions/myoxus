import { expect, test } from "vitest";

import {
  bundledLanguagesInfo,
  createEditorHighlighterCore,
} from "../src/syntax-highlighter/index.js";

test("code-block instances keep custom themes and independent disposal", async () => {
  const language = bundledLanguagesInfo.find(({ id }) => id === "javascript")!;
  const first = await createEditorHighlighterCore({
    langs: [language.import],
    themes: [
      { name: "custom", settings: [{ settings: { foreground: "#123456" } }] },
    ],
  });
  const second = await createEditorHighlighterCore({
    langs: [language.import],
    themes: [
      { name: "custom", settings: [{ settings: { foreground: "#abcdef" } }] },
    ],
  });
  try {
    expect(
      first
        .codeToTokensBase("answer", { lang: "js", theme: "custom" })[0][0]
        .color?.toLowerCase(),
    ).toBe("#123456");
    first.dispose();
    expect(
      second
        .codeToTokensBase("answer", { lang: "js", theme: "custom" })[0][0]
        .color?.toLowerCase(),
    ).toBe("#abcdef");
  } finally {
    // Shiki dispose is idempotent, including after the first instance's explicit disposal.
    first.dispose();
    second.dispose();
  }
});
