import type { Signal } from "@preact/signals-core";
import type { ReactToLit } from "@myoxus/lit-react";
import { SignalWatcher, WithDisposable } from "@virgultum/editor/global/lit";
import type { ColorScheme } from "@virgultum/editor/model";
import { type BlockStdScope, ShadowlessElement } from "@virgultum/editor/std";
import { html, type PropertyValues, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { createElement, type ReactNode } from "react";

import { ArtifactSkeleton } from "../ai-artifact-skeleton";
import { ArtifactCardView } from "./artifact-view";
import {
  hasPreviewPanel,
  isPreviewPanelOpen,
  releasePreviewPanel,
  renderPreviewPanel,
} from "./artifacts-preview-panel";

/** The producer owns data and renderer lifetime; its existing portal owns native presentation. */
export abstract class ArtifactTool<
  TData extends { type: "tool-result" | "tool-call" },
> extends SignalWatcher(WithDisposable(ShadowlessElement)) {
  @property({ attribute: false }) accessor reactToLit: ReactToLit | undefined;

  @property({ attribute: false }) accessor data!: TData;
  @property({ attribute: false }) accessor std: BlockStdScope | undefined;
  @property({ attribute: false }) accessor theme!: Signal<ColorScheme>;
  @property({ attribute: false }) accessor independentMode: boolean | undefined;

  protected abstract getCardMeta(): { title: string };
  protected abstract getIcon(): ReactNode;

  /** Authored Markdown, highlighted code and sandboxed HTML remain at their renderer owners. */
  protected abstract getPreviewContent(): TemplateResult<1>;

  protected getPreviewControls(): ReactNode {
    return undefined;
  }

  // A late portal binding still gets the first automatic opening. Once opened,
  // stream updates only refresh the selected, still-open panel, never reopen it.
  private initialPreviewPending = true;

  private readonly openOrUpdatePreviewPanel = () => {
    if (!this.reactToLit || !this.isConnected || !hasPreviewPanel(this)) return;
    this.initialPreviewPending = false;
    const error = this.getErrorTemplate();
    const content = error
      ? html`${error}`
      : this.isLoading()
        ? this.reactToLit(
            createElement(ArtifactSkeleton, { icon: this.getIcon() }),
            true,
          )
        : this.getPreviewContent();
    renderPreviewPanel(this, {
      reactToLit: this.reactToLit,
      title: this.getCardMeta().title,
      icon: this.getIcon(),
      content,
      controls: this.getPreviewControls(),
    });
  };

  protected isLoading(): boolean {
    return this.data.type !== "tool-result";
  }

  protected refreshPreviewPanel() {
    if (isPreviewPanelOpen(this)) this.openOrUpdatePreviewPanel();
  }

  protected getErrorTemplate(): TemplateResult | string | null {
    return null;
  }

  protected renderCard() {
    const { title } = this.getCardMeta();
    return this.reactToLit
      ? this.reactToLit(
          createElement(ArtifactCardView, {
            title,
            icon: this.getIcon(),
            loading: this.isLoading(),
            open: hasPreviewPanel(this)
              ? this.openOrUpdatePreviewPanel
              : undefined,
          }),
          true,
        )
      : title;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.initialPreviewPending = true;
    this.openOrUpdatePreviewPanel();
  }

  override disconnectedCallback() {
    releasePreviewPanel(this);
    super.disconnectedCallback();
  }

  override render() {
    // Keep the policy subscription while closed too: a later pointer-open must
    // still react when this store becomes readonly, without reopening on change.
    void this.std?.store.readonly$.value;
    return this.getErrorTemplate() ?? this.renderCard();
  }

  override updated(changed: PropertyValues<this>) {
    super.updated(changed);
    if (this.initialPreviewPending) {
      this.openOrUpdatePreviewPanel();
    } else {
      // Scope/action bindings may change without data. SignalWatcher policy
      // updates also arrive with no changed properties; refresh only this owner.
      this.refreshPreviewPanel();
    }
  }
}
