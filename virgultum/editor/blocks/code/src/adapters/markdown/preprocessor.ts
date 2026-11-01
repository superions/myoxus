import {
  type MarkdownAdapterPreprocessor,
  MarkdownPreprocessorExtension,
  getMarkdownCodeRanges,
  getMarkdownFootnoteRanges,
  findAnnotationSyntaxSpans,
} from "@virgultum/shared/adapters";
import { isValidUrl } from "@virgultum/shared/utils";

const codePreprocessor: MarkdownAdapterPreprocessor = {
  name: "code",
  levels: ["slice"],
  preprocess: (content) => {
    const literalRanges = [
      ...getMarkdownCodeRanges(content),
      ...getMarkdownFootnoteRanges(content),
      ...findAnnotationSyntaxSpans(content)
        .filter((span) => span.standalone)
        .map((span) => ({ start: span.index, end: span.index + span.length })),
    ].sort((a, b) => a.start - b.start);
    let offset = 0;
    let boundary = 0;
    const lines = content
      .split("\n")
      .map((line) => {
        const start = offset;
        offset += line.length + 1;
        // Native parser boundaries win over paste-only whitespace/URL cleanup.
        while (literalRanges[boundary]?.end <= start) boundary++;
        if (literalRanges[boundary]?.start < offset) return line;
        if (line.trimStart().startsWith("-")) {
          return line;
        }
        let trimmedLine = line.trimStart();
        trimmedLine = trimmedLine.trimEnd();
        if (
          !trimmedLine.startsWith("<") &&
          !trimmedLine.endsWith(">") &&
          !trimmedLine.includes(" ")
        ) {
          // check if it is a url link and wrap it with the angle brackets
          // sometimes the url includes emphasis `_` that will break URL parsing
          //
          // eg. /MuawcBMT1Mzvoar09-_66?mode=page&blockIds=rL2_GXbtLU2SsJVfCSmh_
          // https://www.markdownguide.org/basic-syntax/#urls-and-email-addresses
          const valid = isValidUrl(trimmedLine);
          if (valid) {
            return `<${trimmedLine}>`;
          }
        }

        return line.replace(/^ /, "&#x20;");
      })
      .join("\n");

    return lines;
  },
};

export const CodeMarkdownPreprocessorExtension =
  MarkdownPreprocessorExtension(codePreprocessor);
