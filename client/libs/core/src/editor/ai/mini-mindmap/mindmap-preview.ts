// SPDX-License-Identifier: MIT
import { WithDisposable } from "@virgultum/editor/global/lit";
import type { EditorHost } from "@virgultum/editor/std";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  MermaidFamilyReactHostIdentifier,
  mermaidMindmapRendererToken,
  MindmapDesign,
  prepareMindmapTree,
  readMermaidSourceLimit,
  mermaidMessages as m,
  type PreparedMindmapTree,
} from "@virgultum/block-mermaid";
import { markdownToMindmap } from "./markdown.js";
export { markdownToMindmap } from "./markdown.js";

/** AI state remains a local candidate. Confirmed document writes belong to the
 * existing response/insert consumers, never to rendering or streaming. */
export class MiniMindmapPreview extends WithDisposable(LitElement) {
  @property({ attribute: false }) accessor answer = "";
  @property({ attribute: false }) accessor ctx!: {
    get(): Record<string, unknown>;
    set(data: Record<string, unknown>): void;
  };
  @property({ attribute: false }) accessor height = 400;
  @property({ attribute: false }) accessor host!: EditorHost;
  @property({ attribute: false }) accessor mindmapStyle:
    MindmapDesign | undefined;
  @property({ attribute: false }) accessor templateShow = true;
  @state() private accessor _limit: number | null = null;
  @state() private accessor _design = MindmapDesign.FOUR;
  private _candidate: PreparedMindmapTree | null = null;
  private _error: string | null = null;
  override connectedCallback() {
    super.connectedCallback();
    readMermaidSourceLimit()
      .then((limit) => {
        if (this.isConnected) this._limit = limit;
      })
      .catch(() => {
        if (this.isConnected) {
          this._error = m.errorTitle();
          this.requestUpdate();
        }
      });
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("mindmapStyle") && this.mindmapStyle !== undefined)
      this._design = this.mindmapStyle;
    if (!this.host || this._limit === null) return;
    if (
      changed.has("answer") ||
      changed.has("host") ||
      changed.has("_limit") ||
      changed.has("_design") ||
      changed.has("mindmapStyle")
    ) {
      this._candidate = null;
      this._error = null;
      try {
        if (this.answer.length > this._limit) throw new Error("source-limit");
        const node = markdownToMindmap(
          this.answer,
          this.host.store,
          this.host.std.store.provider,
        );
        if (!node) throw new Error("mindmap-tree");
        this._candidate = prepareMindmapTree(node, this._limit, this._design);
        this.ctx?.set({ node, style: this._design });
      } catch {
        this.ctx?.set({ node: null });
        this._error = m.visualMutationSourceRejected("mindmap");
      }
    }
  }
  override render() {
    if (this._error)
      return (
        this.host?.std
          .getOptional(MermaidFamilyReactHostIdentifier)
          ?.renderShellNotice({
            title: m.errorTitle(),
            message: this._error,
            tone: "error",
          }) ?? nothing
      );
    if (!this._candidate) return html`${m.loading()}`;
    return this.host.std
      .get(MermaidFamilyReactHostIdentifier)
      .renderFamilyEditor(mermaidMindmapRendererToken, {
        surface: "preview",
        host: this.host,
        model: this._candidate.model,
        design: this._design,
        height: this.height,
        showDesigns: this.templateShow,
        onDesignChange: (design) => {
          this._design = design;
        },
      });
  }
}
