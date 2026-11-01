import { ToolIcon } from "@myoxus/icons/lit";
import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { isImageProxyURL } from "@virgultum/shared/adapters";
import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { createElement } from "react";

import { ToolResultCardView } from "./tool-result-card-view";

export interface ToolResult {
  title: string | TemplateResult<1>;
  icon?: string | TemplateResult<1>;
  content?: string;
  href?: string;
  onClick?: () => void;
}

export class ToolResultCard extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;
  @property({ attribute: false }) accessor name = "Tool result";
  @property({ attribute: false }) accessor icon: TemplateResult<1> = ToolIcon();
  @property({ attribute: false }) accessor footerIcons: (
    TemplateResult<1> | string
  )[] = [];
  @property({ attribute: false }) accessor results: ToolResult[] = [];

  private buildUrl(imageUrl: string) {
    const proxy = BUILD_CONFIG.imageProxyUrl;
    return imageUrl.startsWith(proxy) || isImageProxyURL(imageUrl)
      ? imageUrl
      : `${proxy}?url=${encodeURIComponent(imageUrl)}`;
  }

  protected override render() {
    if (!this.reactToLit) return html`${this.name}`;
    return this.reactToLit(
      createElement(ToolResultCardView, {
        name: this.name,
        icon: toReactNode(this.icon),
        footerIcons: this.footerIcons.map((icon) =>
          typeof icon === "string"
            ? { url: this.buildUrl(icon) }
            : { icon: toReactNode(icon) },
        ),
        results: this.results.map((result) => ({
          ...result,
          title: toReactNode(result.title),
          icon:
            typeof result.icon === "string"
              ? undefined
              : toReactNode(result.icon),
          image:
            typeof result.icon === "string"
              ? this.buildUrl(result.icon)
              : undefined,
        })),
      }),
      true,
    );
  }
}
