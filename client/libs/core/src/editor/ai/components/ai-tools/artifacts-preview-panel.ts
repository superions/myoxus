import { type ReactToLit, toReactNode } from "@myoxus/lit-react";
import { WithDisposable } from "@virgultum/editor/global/lit";
import { ShadowlessElement } from "@virgultum/editor/std";
import { html, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { createElement, type ReactNode } from "react";

import type { AIChatContent } from "../ai-chat-content";
import { ArtifactPreviewView } from "./artifact-view";

function getChatPanel(target: HTMLElement) {
  return target.closest<AIChatContent>("ai-chat-content");
}

// Multiple historical artifacts share one panel. An older producer must not
// replace the selected preview when its stream changes or it disconnects.
const owners = new WeakMap<AIChatContent, HTMLElement>();

export const hasPreviewPanel = (target: HTMLElement) => !!getChatPanel(target);

export const isPreviewPanelOpen = (target: HTMLElement) => {
  const panel = getChatPanel(target);
  return !!panel?.isPreviewPanelOpen && owners.get(panel) === target;
};

interface PreviewPanelData {
  reactToLit: ReactToLit;
  title: string;
  icon: ReactNode;
  content: TemplateResult;
  controls?: ReactNode;
}

export function renderPreviewPanel(
  target: HTMLElement,
  data: PreviewPanelData,
) {
  const panel = getChatPanel(target);
  if (!panel) return;
  owners.set(panel, target);
  producerPanels.set(target, panel);
  panel.openPreviewPanel(
    html`<artifact-preview-panel .data=${data}></artifact-preview-panel>`,
  );
}

export function closePreviewPanel(target: HTMLElement) {
  const panel = getChatPanel(target);
  panel?.closePreviewPanel(true);
  if (panel) owners.delete(panel);
}

export function releasePreviewPanel(target: HTMLElement) {
  // disconnectedCallback runs after removal, when closest() can no longer find
  // the panel. The producer's retained owner is resolved at open time instead.
  const panel = producerPanels.get(target);
  producerPanels.delete(target);
  if (panel && owners.get(panel) === target) {
    owners.delete(panel);
    panel.closePreviewPanel(true);
  }
}

const producerPanels = new WeakMap<HTMLElement, AIChatContent>();

/** Thin mounting boundary for the existing conversation's TemplateResult slot. */
export class ArtifactPreviewPanel extends WithDisposable(ShadowlessElement) {
  @property({ attribute: false }) accessor data!: PreviewPanelData;

  private readonly handleClose = () => closePreviewPanel(this);

  protected override render() {
    const { reactToLit, content, ...props } = this.data;
    return reactToLit(
      createElement(
        ArtifactPreviewView,
        { ...props, close: this.handleClose },
        toReactNode(content),
      ),
      true,
    );
  }
}
