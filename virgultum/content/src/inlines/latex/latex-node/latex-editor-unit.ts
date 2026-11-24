import { HighlightedText } from "../../../syntax-highlighter/highlighted-text";
export class LatexEditorUnit extends HighlightedText {
  protected paint() {
    const line = this.closest("v-element");
    this.paintRuns(
      (line &&
        this.closest("latex-source-editor")?.highlightTokens$.value[
          line.lineIndex
        ]) ??
        [],
    );
  }
}
