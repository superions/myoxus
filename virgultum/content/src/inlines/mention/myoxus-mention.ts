import { cssVar } from "@myoxus/theme";
import { computed, effect, signal, untracked } from "@preact/signals-core";
import { UserProvider } from "@virgultum/core/services";
import type { MyoxusTextAttributes } from "@virgultum/core/types";
import {
  type BlockStdScope,
  NativeViewElement,
  installEditorStyles,
} from "@virgultum/core/runtime";
import {
  ZERO_WIDTH_FOR_EMBED_NODE,
  ZERO_WIDTH_FOR_EMPTY_LINE,
} from "@virgultum/core/runtime/inline";
import type { DeltaInsert } from "@virgultum/core/store";

const styles = `
    .myoxus-mention {
      color: ${cssVar("textPrimaryColor")};
      font-feature-settings:
        "liga" off,
        "clig" off;
      /* Client/baseMedium */
      font-family: Inter;
      font-size: var(--myoxus-font-size-base);
      font-style: normal;
      font-weight: 500;
      line-height: 24px; /* 160% */
      padding: 0 4px;
      border-radius: 4px;
      user-select: none;
    }
    .myoxus-mention:hover {
      background: var(--myoxus-hover-color);
    }
    .myoxus-mention[data-selected="true"] {
      background: var(--myoxus-hover-color);
    }
    .myoxus-mention[data-type="default"] {
      color: ${cssVar("textPrimaryColor")};
    }
    .myoxus-mention[data-type="removed"] {
      color: ${cssVar("textDisableColor")};
    }
    .myoxus-mention[data-type="error"] {
      color: ${cssVar("textDisableColor")};
    }
    .myoxus-mention[data-type="loading"] {
      color: ${cssVar("placeholderColor")};
      background: ${cssVar("backgroundTertiaryColor")};
    }
    .myoxus-mention-dots {
      display: inline-block;
    }
    .myoxus-mention-dot {
      display: inline-block;
      opacity: 0;
      animation: myoxus-mention-pulse 1.2s infinite;
    }
    .myoxus-mention-dots > .myoxus-mention-dot:nth-child(2) {
      animation-delay: 0.4s;
    }
    .myoxus-mention-dots > .myoxus-mention-dot:nth-child(3) {
      animation-delay: 0.8s;
    }
    @keyframes myoxus-mention-pulse {
      0% {
        opacity: 0;
      }
      33.333% {
        opacity: 1;
      }
      66.666% {
        opacity: 1;
      }
      100% {
        opacity: 0;
      }
    }
`;

export class MyoxusMention extends NativeViewElement {
  std!: BlockStdScope;
  private readonly deltaState = signal<DeltaInsert<MyoxusTextAttributes>>({
    insert: ZERO_WIDTH_FOR_EMPTY_LINE,
  });
  private readonly selectedState = signal(false);
  private release?: () => void;

  get delta() {
    return this.deltaState.value;
  }

  set delta(value: DeltaInsert<MyoxusTextAttributes>) {
    this.deltaState.value = value;
  }

  get selected() {
    return this.selectedState.value;
  }

  set selected(value: boolean) {
    this.selectedState.value = value;
  }

  connectedCallback() {
    const doc = this.ownerDocument;
    installEditorStyles(this, styles);
    const label = doc.createElement("span");
    label.className = "myoxus-mention";
    const name = doc.createTextNode("");
    const dots = doc.createElement("span");
    dots.className = "myoxus-mention-dots";
    for (let i = 0; i < 3; i++) {
      const dot = doc.createElement("span");
      dot.className = "myoxus-mention-dot";
      dot.textContent = ".";
      dots.append(dot);
    }
    const marker = doc.createElement("v-text");
    marker.str = ZERO_WIDTH_FOR_EMBED_NODE;
    label.append(name, marker);
    this.replaceChildren(label);
    const provider = this.std.getOptional(UserProvider);
    const member = computed(() => this.delta.attributes?.mention?.member);
    const stopLookup = effect(() => {
      const id = member.value;
      if (id && provider) untracked(() => provider.revalidateUserInfo(id));
    });
    const stopPaint = effect(() => {
      const id = member.value;
      const user = id && provider ? provider.userInfo$(id).value : null;
      const loading =
        !user && id && provider ? provider.isLoading$(id).value : false;
      label.dataset.selected = String(this.selected);
      if (loading) {
        label.dataset.type = "loading";
        name.data = "@loading";
        if (!dots.parentNode) marker.before(dots);
        return;
      }
      dots.remove();
      label.dataset.type = user?.removed
        ? "removed"
        : user
          ? "default"
          : "error";
      name.data = user?.removed
        ? "@Inactive Member"
        : user
          ? `@${user.name ?? "Unknown"}`
          : "@Unknown Member";
    });
    this.release = () => {
      stopLookup();
      stopPaint();
    };
  }

  disconnectedCallback() {
    this.release?.();
    this.release = undefined;
  }
}
