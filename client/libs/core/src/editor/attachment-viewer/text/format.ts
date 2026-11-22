// SPDX-License-Identifier: AGPL-3.0-or-later
export function textAttachmentFormat(name: string, mime: string) {
  if (
    /\.(md|markdown)$/i.test(name) ||
    /^text\/(markdown|x-markdown)$/i.test(mime)
  )
    return "markdown";
  return /\.txt$/i.test(name) || mime.toLowerCase() === "text/plain"
    ? "text"
    : null;
}
