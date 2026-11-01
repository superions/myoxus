// SPDX-License-Identifier: AGPL-3.0-or-later

/** Only delimiter escapes have meaning inside an otherwise literal body. */
export function decodeAnnotationBody(value: string): string {
  let body = "";
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\" && value[index + 1] === "%") index++;
    body += value[index];
  }
  return body.replace(/\r\n?/g, "\n");
}

export function serializeAnnotationBody(body: string): string {
  // Keep a literal closing pair from terminating the surrounding logical span.
  return `%%${body.replaceAll("%", "\\%")}%%`;
}

/** Escape ordinary prose so copying/exporting cannot create a new annotation. */
export function escapeAnnotationDelimiters(text: string): string {
  return text.replaceAll("%%", "\\%\\%");
}
