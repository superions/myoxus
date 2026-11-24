import { createElement } from "react";
import { DiffWidget } from "./diff-widget";
import { DiffToolbar } from "./view";
import { track } from "@myoxus/track";
import { WidgetViewExtension } from "@virgultum/editor/std";

export const MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE =
  "myoxus-block-diff-widget-for-page";

export class MyoxusBlockDiffWidgetForPage extends DiffWidget {
  override connectedCallback() {
    super.connectedCallback();
    // Keep the existing viewport anchor; the shared toolbar owns its chrome.
    Object.assign(this.style, {
      position: "fixed",
      left: "50%",
      transform: "translateX(-50%)",
      bottom:
        "calc((var(--mantine-spacing-2xl) + var(--mantine-spacing-sm)) * 4 + var(--mantine-spacing-lg) + var(--mantine-spacing-xs))",
    });
  }

  private currentIndex = 0;

  _handleScroll(dir: "prev" | "next") {
    const total = this.diffService.getTotalDiffs();

    const diffWidgets = Array.from(
      this.std.host.querySelectorAll("myoxus-block-diff-widget-for-block"),
    );
    const diffs = diffWidgets.reduce<Element[]>((acc, widget) => {
      const aiDiffs = widget.querySelectorAll(".ai-block-diff");
      if (aiDiffs && aiDiffs.length > 0) {
        acc.push(...aiDiffs);
      }
      return acc;
    }, []);
    if (dir === "prev") {
      this.currentIndex = Math.max(0, this.currentIndex - 1);
    } else {
      this.currentIndex = Math.min(total - 1, this.currentIndex + 1);
    }
    this.refresh();
    diffs[this.currentIndex]?.scrollIntoView({ behavior: "smooth" });
  }

  async _handleAcceptAll() {
    track.applyModel.widget.page.acceptAll();
    await this.diffService.acceptAll(this.std.store);
  }

  _handleRejectAll() {
    track.applyModel.widget.page.rejectAll();
    this.diffService.rejectAll();
  }

  protected renderDiff() {
    const total = this.diffService.getTotalDiffs();
    if (total <= 0) {
      this.currentIndex = 0;
      return null;
    }
    this.currentIndex = Math.min(this.currentIndex, total - 1);
    return createElement(DiffToolbar, {
      current: Math.min(this.currentIndex + 1, total),
      total,
      previous: () => this._handleScroll("prev"),
      next: () => this._handleScroll("next"),
      accept: () => {
        void this._handleAcceptAll();
      },
      reject: () => this._handleRejectAll(),
    });
  }
}

export const blockDiffWidgetForPage = WidgetViewExtension(
  "myoxus:page",
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE,
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_PAGE,
);
