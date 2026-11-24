import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import { installEditorStyles } from "@virgultum/core/runtime";
import type { CommentId, CommentProvider } from "@virgultum/core/services";
import { cssVar } from "@virgultum/core/theme";

const commentStyles = `
    inline-comment {
      display: inline;
    }

    inline-comment.unresolved {
      background-color: ${cssVar("backgroundProcessingColor")};
      border-bottom: 2px solid ${cssVar("primaryColor")};
    }

    inline-comment.highlighted {
      background-color: ${cssVar("backgroundProcessingColor")};
    }
`;
export class InlineComment extends NativeViewElement {
  commentIds: string[] = [];
  provider?: CommentProvider;
  private index = 0;
  private lifecycle?: DisposableGroup;

  get unresolved() {
    return this.classList.contains("unresolved");
  }
  set unresolved(value: boolean) {
    this.classList.toggle("unresolved", value);
  }

  connectedCallback() {
    installEditorStyles(this, commentStyles);
    const provider = this.provider;
    if (!provider) return;
    const life = (this.lifecycle = new DisposableGroup());
    life.addFromEvent(this, "click", () => {
      if (!this.unresolved || !this.commentIds.length) return;
      provider.highlightComment(
        this.commentIds[this.index % this.commentIds.length],
      );
      this.index = (this.index + 1) % this.commentIds.length;
    });
    life.add(
      provider.onCommentHighlighted((id: CommentId | null) => {
        this.classList.toggle(
          "highlighted",
          id !== null && this.commentIds.includes(id),
        );
      }),
    );
  }
  disconnectedCallback() {
    this.lifecycle?.dispose();
  }
}
