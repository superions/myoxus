import { myoxusTextStyles } from "@virgultum/core/styles";
import { inlineChild } from "@virgultum/core/runtime/inline";
import { HighlightedText } from "../../../syntax-highlighter/highlighted-text";

export class MyoxusCodeUnit extends HighlightedText {
  protected paint() {
    const block = this.closest("myoxus-code");
    const { attributes } = this.delta;
    if (attributes?.link && block) {
      inlineChild(this, "myoxus-link", { std: block.std, delta: this.delta });
      return;
    }
    const styles = attributes ? myoxusTextStyles(attributes) : {};
    if (attributes?.code)
      Object.assign(styles, {
        "font-size": "calc(var(--myoxus-font-base) - 3px)",
        padding: "0px 4px 2px",
      });
    const line = this.closest("v-element");
    const tokens = line && block?.highlightTokens$.value[line.lineIndex];
    const runs = [];
    if (line && tokens) {
      for (const token of tokens) {
        const start = Math.max(0, line.startOffset - token.offset);
        const end = Math.min(
          token.content.length,
          line.endOffset - token.offset,
        );
        if (end > start)
          runs.push({
            content: token.content.slice(start, end),
            color: token.color,
          });
      }
    }
    this.paintRuns(runs, styles);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "myoxus-code-unit": MyoxusCodeUnit;
  }
}
