import { describe, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { MermaidInlineShapeTextEditorController } from "../mermaid-inline-shape-text-editor.js";

function createViewport() {
  const viewport = document.createElement("div");
  const editorLayer = document.createElement("div");
  editorLayer.className = "myoxus-mermaid-inline-shape-editor-layer";
  viewport.append(editorLayer);
  return viewport;
}

describe("Mermaid inline shape text editor", () => {
  test("keeps semantic drafts local while lifecycle disposal cancels the host commit", () => {
    const viewport = createViewport();
    document.body.append(viewport);
    const documentState = new Y.Doc();
    const text = documentState.getText("node-label");
    text.insert(0, "Memory Access");
    const metadata = new Map<string, unknown>([
      ["mermaidNodeLabel", "Memory Access"],
      ["mermaidNodeDisplayLabel", "Memory Access"],
    ]);
    const staleModel = {
      fontFamily: "Inter",
      fontSize: 24,
      fontStyle: "normal",
      fontWeight: "400",
      padding: [10, 20],
      text: new Y.Text(),
      textAlign: "center",
      textDisplay: true,
      xywh: "[0,0,160,48]",
    };
    const model = {
      fontFamily: "Inter",
      fontSize: 24,
      fontStyle: "normal",
      fontWeight: "400",
      mermaidNodeDisplayLabel: "Memory Access",
      mermaidNodeLabel: "Memory Access",
      padding: [10, 20],
      props: {
        mermaidNodeDisplayLabel: "Memory Access",
        mermaidNodeLabel: "Memory Access",
      },
      text,
      textAlign: "center",
      textDisplay: true,
      xywh: "[0,0,160,48]",
      yMap: {
        get: (key: string) => metadata.get(key),
        set: (key: string, value: unknown) => metadata.set(key, value),
      },
    };
    const scheduleProjectionOwnerSourceSync = vi.fn();
    const commitValue = vi.fn(() => true);
    const controller = new MermaidInlineShapeTextEditorController({
      getViewportElement: () => viewport,
      scheduleProjectionOwnerSourceSync,
      toViewPoint: (x, y) => ({ left: x, top: y }),
    });

    controller.start({
      commitValue,
      model: staleModel as never,
      resolveModel: () => model as never,
    });
    const input = viewport.querySelector<HTMLInputElement>(
      ".myoxus-mermaid-inline-node-editor",
    );
    expect(input).not.toBeNull();
    if (!input) return;
    expect(input.style.fontSize).toBe("24px");
    expect(input.style.height).toBe("48px");
    expect(model.textDisplay).toBe(false);

    input.value = "Memory bus";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(model.text.toString()).toBe("Memory Access");
    expect(metadata.get("mermaidNodeLabel")).toBe("Memory Access");
    expect(metadata.get("mermaidNodeDisplayLabel")).toBe("Memory Access");
    expect(scheduleProjectionOwnerSourceSync).not.toHaveBeenCalled();

    controller.dispose();
    expect(model.textDisplay).toBe(true);
    expect(commitValue).not.toHaveBeenCalled();
    expect(scheduleProjectionOwnerSourceSync).not.toHaveBeenCalled();
    viewport.remove();
    documentState.destroy();
  });

  test("waits for a live viewport projection before mounting an editor", () => {
    const viewport = createViewport();
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 180 },
      clientWidth: { configurable: true, value: 320 },
    });
    document.body.append(viewport);
    const documentState = new Y.Doc();
    const text = documentState.getText("group-label");
    text.insert(0, "Group 1");
    const model = {
      fontFamily: "Inter",
      fontSize: 24,
      fontStyle: "normal",
      fontWeight: "400",
      padding: [10, 20],
      text,
      textAlign: "center",
      textDisplay: true,
      xywh: "[5000,-4000,240,80]",
    };
    let projectionReady = false;
    const controller = new MermaidInlineShapeTextEditorController({
      getViewportElement: () => viewport,
      scheduleProjectionOwnerSourceSync: vi.fn(),
      toViewPoint: (x, y) =>
        projectionReady
          ? { left: x - 4900, top: y + 4050 }
          : { left: x, top: y },
    });

    controller.start({ commitValue: vi.fn(), model: model as never });
    expect(
      viewport.querySelector(".myoxus-mermaid-inline-node-editor"),
    ).toBeNull();

    projectionReady = true;
    controller.start({ commitValue: vi.fn(), model: model as never });
    const input = viewport.querySelector<HTMLInputElement>(
      ".myoxus-mermaid-inline-node-editor",
    );
    expect(input).not.toBeNull();
    expect(input?.style.left).toBe("100px");
    expect(input?.style.top).toBe("50px");

    controller.dispose();
    viewport.remove();
    documentState.destroy();
  });

  test("gives semantic commits the original GFX value as their history baseline", () => {
    const viewport = createViewport();
    viewport.tabIndex = 0;
    document.body.append(viewport);
    const documentState = new Y.Doc();
    const text = documentState.getText("node-label-history");
    text.insert(0, "Decision\nQA");
    const metadata = new Map<string, unknown>([
      ["mermaidNodeLabel", "Decision\nQA"],
      ["mermaidNodeDisplayLabel", "Decision\nQA"],
    ]);
    const model = {
      fontFamily: "Inter",
      fontSize: 24,
      fontStyle: "normal",
      fontWeight: "400",
      mermaidNodeDisplayLabel: "Decision\nQA",
      mermaidNodeLabel: "Decision\nQA",
      padding: [10, 20],
      props: {
        mermaidNodeDisplayLabel: "Decision\nQA",
        mermaidNodeLabel: "Decision\nQA",
      },
      text,
      textAlign: "center",
      textDisplay: true,
      xywh: "[0,0,180,108]",
      labelProjection: {
        box: { x: 20, y: 18, width: 140, height: 72 },
        lineHeight: 36,
        runs: [{ text: "Decision\nQA", bold: false, italic: false }],
      },
      yMap: {
        get: (key: string) => metadata.get(key),
        set: (key: string, value: unknown) => metadata.set(key, value),
      },
    };
    const scheduleProjectionOwnerSourceSync = vi.fn();
    const observedBaselines: Array<{ label: unknown; text: string }> = [];
    const commitValue = vi.fn((value: string) => {
      observedBaselines.push({
        label: metadata.get("mermaidNodeLabel"),
        text: model.text.toString(),
      });
      model.text.delete(0, model.text.length);
      model.text.insert(0, value);
      metadata.set("mermaidNodeLabel", value);
      metadata.set("mermaidNodeDisplayLabel", value);
      return true;
    });
    const controller = new MermaidInlineShapeTextEditorController({
      getViewportElement: () => viewport,
      scheduleProjectionOwnerSourceSync,
      toViewPoint: (x, y) => ({ left: x, top: y }),
    });

    controller.start({ commitValue, model: model as never });
    const input = viewport.querySelector<HTMLTextAreaElement>(
      ".myoxus-mermaid-inline-node-editor",
    );
    expect(input).not.toBeNull();
    if (!input) return;
    expect(input.style.width).toBe("140px");
    expect(input.style.height).toBe("72px");
    const outerPaste = vi.fn();
    viewport.addEventListener("paste", outerPaste);
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    input.dispatchEvent(paste);
    expect(outerPaste).not.toHaveBeenCalled();
    expect(paste.defaultPrevented).toBe(false);

    input.value = "Decision QA\nReady";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );

    expect(commitValue).toHaveBeenCalledOnce();
    expect(commitValue).toHaveBeenCalledWith("Decision QA\nReady");
    expect(observedBaselines).toEqual([
      { label: "Decision\nQA", text: "Decision\nQA" },
    ]);
    expect(model.text.toString()).toBe("Decision QA\nReady");
    expect(metadata.get("mermaidNodeLabel")).toBe("Decision QA\nReady");
    expect(scheduleProjectionOwnerSourceSync).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(viewport);

    viewport.remove();
    documentState.destroy();
  });
});
