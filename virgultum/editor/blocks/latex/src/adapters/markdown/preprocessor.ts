import {
  getMarkdownCodeRanges,
  type MarkdownAdapterPreprocessor,
  MarkdownPreprocessorExtension,
} from "@virgultum/shared/adapters";

function normalizeBracketMath(text: string): string {
  return text.replace(
    /\\\[([\s\S]*?[^\\])\\\]|\\\((.*?)\\\)/g,
    (
      match,
      display: string | undefined,
      inline: string | undefined,
      offset: number,
      source: string,
    ) => {
      // An escaped opening backslash is literal prose, not a legacy math delimiter.
      if ((source.slice(0, offset).match(/\\+$/)?.[0].length ?? 0) % 2)
        return match;
      if (display !== undefined) return "$$\n" + display + "\n$$";
      if (inline !== undefined) return "$" + inline + "$";
      return match;
    },
  );
}

const latexPreprocessor: MarkdownAdapterPreprocessor = {
  name: "latex",
  levels: ["block", "slice", "doc"],
  preprocess: (content) => {
    // Reuse parser-owned literal boundaries, including tilde/long fences and
    // multi-backtick spans. Numeric formulas and macro bytes must not be rewritten.
    let cursor = 0;
    let result = "";
    for (const range of getMarkdownCodeRanges(content)) {
      if (range.start < cursor) continue;
      result += normalizeBracketMath(content.slice(cursor, range.start));
      result += content.slice(range.start, range.end);
      cursor = range.end;
    }
    return result + normalizeBracketMath(content.slice(cursor));
  },
};

export const LatexMarkdownPreprocessorExtension =
  MarkdownPreprocessorExtension(latexPreprocessor);
