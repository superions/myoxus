// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const noreply = /^(?:[1-9][0-9]*\+)?([a-z0-9]+(?:-[a-z0-9]+)*)@users\.noreply\.github\.com$/;
const importHeader = /^Imported-from: https:\/\/github\.com\/superions\/myoxus\/pull\/([1-9][0-9]*)\nGitHub-Head: [0-9a-f]{40}\nPublic-GitHub-Authors:([^\n]*)$/;
export const intakeCommitter = "github-intake@myoxus.invalid";

export function publicEmails(values) {
  return [...new Set(values.map((value) => value.trim().toLowerCase()))]
    .filter((email) => {
      const match = email.match(noreply);
      return match && match[1].length <= 39;
    })
    .sort();
}

function snapshotTrailers(log) {
  const fields = log.split("\0");
  const seen = new Set();
  const emails = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== intakeCommitter) continue;
    // The importer owns the first paragraph after the title. The remaining
    // paragraphs may contain arbitrary text copied from the GitHub commits.
    const header = fields[i + 1].split("\n\n", 2)[1]?.match(importHeader);
    if (!header || seen.has(header[1])) continue;
    seen.add(header[1]);
    emails.push(...header[2].split(","));
  }
  return publicEmails(emails).map(
    (email) => `Co-authored-by: ${email.match(noreply)[1]} <${email}>`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const trailers = snapshotTrailers(readFileSync(0, "utf8"));
  if (trailers.length) process.stdout.write(`\n${trailers.join("\n")}\n`);
}
