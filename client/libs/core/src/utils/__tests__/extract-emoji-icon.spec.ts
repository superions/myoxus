import { expect, test } from "vitest";

import { extractEmojiIcon } from "../extract-emoji-icon";

test.each([
  "👨🏻‍❤️‍💋‍👨🏻",
  "👩🏽‍🚀",
  "🇩🇪",
  "👍🏿",
  "🏳️‍🌈",
  "❤️",
  "©️",
  "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
])("preserves the full leading cluster %s and the exact remainder", (emoji) => {
  const rest = "🇫🇷 e\u0301 中文";
  expect(extractEmojiIcon(emoji + rest)).toEqual({ emoji, rest });
});

test.each(["", "text 👋", " 👋", "1️⃣ title", "e\u0301", "क्ष"])(
  "retains the existing leading-emoji recognition for %j",
  (text) => {
    expect(extractEmojiIcon(text)).toEqual({ emoji: null, rest: text });
  },
);

test("extract-emoji-icon", () => {
  expect(extractEmojiIcon("👨🏻‍❤️‍💋‍👨🏻123")).toEqual({
    emoji: "👨🏻‍❤️‍💋‍👨🏻",
    rest: "123",
  });

  expect(extractEmojiIcon("❤️123")).toEqual({
    emoji: "❤️",
    rest: "123",
  });

  expect(extractEmojiIcon("➡️456")).toEqual({
    emoji: "➡️",
    rest: "456",
  });

  expect(extractEmojiIcon("✈️789")).toEqual({
    emoji: "✈️",
    rest: "789",
  });

  expect(extractEmojiIcon("plain text")).toEqual({
    emoji: null,
    rest: "plain text",
  });
});
