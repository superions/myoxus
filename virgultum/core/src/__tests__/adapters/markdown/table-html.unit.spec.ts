// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { parseMarkdownTableHtml } from "../../../adapters/markdown/table-html";

test("table admission rejects oversized, excessively nested and unsafe source before sanitizer removal", () => {
  const table = (cell: string) =>
    `<table><tbody><tr><td>${cell}</td></tr></tbody></table>`;
  expect(
    parseMarkdownTableHtml(
      table("<em>".repeat(100) + "Body" + "</em>".repeat(100)),
    ),
  ).not.toBeNull();
  expect(
    parseMarkdownTableHtml(
      table("<em>".repeat(101) + "Body" + "</em>".repeat(101)),
    ),
  ).toBeNull();
  expect(parseMarkdownTableHtml(table("ä".repeat(4 * 1024 * 1024)))).toBeNull();
  for (const cell of [
    '<a href="java&#x73;cript:alert(1)">Body</a>',
    '<a href="https:\\evil.test">Body</a>',
    '<strong onclick="alert(1)">Body</strong>',
  ])
    expect(parseMarkdownTableHtml(table(cell))).toBeNull();
});
