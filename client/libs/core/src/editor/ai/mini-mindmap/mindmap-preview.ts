// SPDX-License-Identifier: MIT
import { signal } from "@preact/signals-core";
import {
  MermaidFamilyReactHostIdentifier,
  type MermaidViewBinding,
  mermaidMessages as m,
  mermaidMindmapRendererToken,
  MindmapDesign,
  type PreparedMindmapTree,
  prepareMindmapTree,
  readMermaidSourceLimit,
} from "@virgultum/block-mermaid";
import { DisposableGroup } from "@virgultum/core/primitives/disposable";
import { NativeViewElement } from "@virgultum/core/primitives/env";
import type { EditorHost } from "@virgultum/editor/std";
import type { ReactNode } from "react";

import { markdownToMindmap } from "./markdown.js";
export { markdownToMindmap } from "./markdown.js";

/** AI state remains a local candidate. Confirmed document writes belong to the
 * existing response/insert consumers, never to rendering or streaming. */
export class MiniMindmapPreview extends NativeViewElement {
  disposables = new DisposableGroup();

  private _answer = "";
  private _ctx!: {
    get(): Record<string, unknown>;
    set(data: Record<string, unknown>): void;
  };
  private _height = 400;
  private _host!: EditorHost;
  private _mindmapStyle: MindmapDesign | undefined;
  private _templateShow = true;
  private _limit: number | null = null;
  private _design = MindmapDesign.FOUR;
  private _candidate: PreparedMindmapTree | null = null;
  private _error: string | null = null;

  private _mountHost: HTMLDivElement | null = null;
  private _unmount: (() => void) | null = null;
  private _mountedHost: EditorHost | null = null;
  private readonly _view$ = signal<ReactNode>(null);

  get answer(): string {
    return this._answer;
  }
  set answer(value: string) {
    if (this._answer === value) return;
    this._answer = value;
    this._recompute();
  }

  get ctx() {
    return this._ctx;
  }
  set ctx(value: {
    get(): Record<string, unknown>;
    set(data: Record<string, unknown>): void;
  }) {
    this._ctx = value;
  }

  get height(): number {
    return this._height;
  }
  set height(value: number) {
    if (this._height === value) return;
    this._height = value;
    this._renderView();
  }

  get host(): EditorHost {
    return this._host;
  }
  set host(value: EditorHost) {
    const changed = this._host !== value;
    this._host = value;
    if (changed && this.isConnected) {
      this._bindHost();
      this._recompute();
    }
  }

  get mindmapStyle(): MindmapDesign | undefined {
    return this._mindmapStyle;
  }
  set mindmapStyle(value: MindmapDesign | undefined) {
    if (this._mindmapStyle === value) return;
    this._mindmapStyle = value;
    if (value !== undefined) {
      this._design = value;
    }
    this._recompute();
  }

  get templateShow(): boolean {
    return this._templateShow;
  }
  set templateShow(value: boolean) {
    if (this._templateShow === value) return;
    this._templateShow = value;
    this._renderView();
  }

  private _recompute() {
    if (!this._host || this._limit === null) {
      this._renderView();
      return;
    }
    this._candidate = null;
    this._error = null;
    try {
      if (this._answer.length > this._limit) throw new Error("source-limit");
      const node = markdownToMindmap(
        this._answer,
        this._host.store,
        this._host.std.store.provider,
      );
      if (!node) throw new Error("mindmap-tree");
      this._candidate = prepareMindmapTree(node, this._limit, this._design);
      this._ctx?.set({ node, style: this._design });
    } catch {
      this._ctx?.set({ node: null });
      this._error = m.visualMutationSourceRejected("mindmap");
    }
    this._renderView();
  }

  private _renderView() {
    const mermaidHost = this._host?.std.getOptional(
      MermaidFamilyReactHostIdentifier,
    );
    if (!mermaidHost) {
      this._view$.value = null;
      return;
    }
    if (this._error) {
      this._view$.value = mermaidHost.renderShellNotice({
        title: m.errorTitle(),
        message: this._error,
        tone: "error",
      });
      return;
    }
    if (!this._candidate) {
      this._view$.value = m.loading();
      return;
    }
    this._view$.value = mermaidHost.renderFamilyEditor(
      mermaidMindmapRendererToken,
      {
        surface: "preview",
        host: this._host,
        model: this._candidate.model,
        design: this._design,
        height: this._height,
        showDesigns: this._templateShow,
        onDesignChange: (design) => {
          this._design = design;
          this._recompute();
        },
      },
    );
  }

  private _bindHost() {
    if (!this._host || !this._mountHost) return;
    if (this._mountedHost === this._host) return;
    this._unmount?.();
    this._unmount = null;
    this._mountedHost = this._host;
    const mermaidHost = this._host.std.getOptional(
      MermaidFamilyReactHostIdentifier,
    );
    if (mermaidHost) {
      const binding: MermaidViewBinding = {
        subscribe: (notify) => this._view$.subscribe(notify),
        getSnapshot: () => this._view$.value,
      };
      this._unmount = mermaidHost.mount(this._mountHost, binding);
    }
  }

  connectedCallback() {
    if (this.disposables.disposed) {
      this.disposables = new DisposableGroup();
    }
    if (!this._mountHost) {
      this._mountHost = this.ownerDocument.createElement("div");
      this._mountHost.style.display = "contents";
      this.replaceChildren(this._mountHost);
    }
    this._bindHost();
    this._renderView();

    readMermaidSourceLimit()
      .then((limit) => {
        if (this.isConnected) {
          this._limit = limit;
          this._recompute();
        }
      })
      .catch(() => {
        if (this.isConnected) {
          this._error = m.errorTitle();
          this._renderView();
        }
      });
  }

  disconnectedCallback() {
    this._unmount?.();
    this._unmount = null;
    this._mountedHost = null;
    this.disposables.dispose();
  }
}
