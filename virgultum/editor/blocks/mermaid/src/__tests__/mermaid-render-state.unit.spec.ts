import { describe, expect, test, vi } from "vitest";
import { MermaidHostSource } from "../mermaid-host-source.js";
import { renderMermaidSvg } from "../renderer.js";

vi.mock("../renderer.js", async (original) => ({
  ...(await original<typeof import("../renderer.js")>()),
  renderMermaidSvg: vi.fn(),
}));

import {
  MERMAID_RENDER_DEBOUNCE_MS,
  resolveMermaidStaticRenderDecision,
  shouldScheduleMermaidDisplayPreview,
} from "../mermaid-render-state.js";

describe("Mermaid render state decisions", () => {
  test("invalidates output immediately and rejects an older async Gantt render", async () => {
    vi.useFakeTimers();
    let finishOld!: (value: { svg: string }) => void;
    const old = new Promise<{ svg: string }>((resolve) => {
      finishOld = resolve;
    });
    vi.mocked(renderMermaidSvg)
      .mockImplementationOnce(() => old as ReturnType<typeof renderMermaidSvg>)
      .mockResolvedValueOnce({ svg: "current" } as Awaited<
        ReturnType<typeof renderMermaidSvg>
      >);
    const model = {
      props: {
        source: "gantt\n dateFormat YYYY-MM-DD\n A : 2026-01-01, 1d\n",
        title: "",
      },
    };
    const host = Object.assign(Object.create(MermaidHostSource.prototype), {
      _renderGeneration: 0,
      _renderState: "finish",
      _svg: "previous",
      _lastValidSvg: "previous",
      _getDisplayMode: () => "display",
      _getShellMode: () => "view",
      _getMermaidVisualModelForEditing: () => null,
      requestUpdate: vi.fn(),
    });
    Object.defineProperties(host, {
      model: { value: model },
      blockId: { value: "generation-test" },
    });
    try {
      host._scheduleRender();
      expect(host._renderState).toBe("loading");
      await vi.advanceTimersByTimeAsync(MERMAID_RENDER_DEBOUNCE_MS);
      model.props.source = model.props.source.replace(" A :", " B :");
      host._scheduleRender();
      await vi.advanceTimersByTimeAsync(MERMAID_RENDER_DEBOUNCE_MS);
      expect(host._svg).toBe("current");
      finishOld({ svg: "stale" });
      await Promise.resolve();
      await Promise.resolve();
      expect(host._svg).toBe("current");
      expect(host._lastValidSvg).toBe("current");
      expect(host._renderState).toBe("finish");
    } finally {
      vi.useRealTimers();
      vi.mocked(renderMermaidSvg).mockReset();
    }
  });
  test("renders static preview only for display mode or non-GFX edit diagrams", () => {
    expect(
      resolveMermaidStaticRenderDecision({
        displayMode: "edit",
        isGfxDiagramType: true,
        source: "flowchart TD\n  A --> B",
      }),
    ).toBe("skip-gfx-edit");
    expect(
      resolveMermaidStaticRenderDecision({
        displayMode: "display",
        isGfxDiagramType: true,
        source: "flowchart TD\n  A --> B",
      }),
    ).toBe("skip-gfx-edit");
    expect(
      resolveMermaidStaticRenderDecision({
        displayMode: "edit",
        isGfxDiagramType: false,
        source: "sequenceDiagram\n  A->>B: hi",
      }),
    ).toBe("render");
    expect(
      resolveMermaidStaticRenderDecision({
        displayMode: "display",
        isGfxDiagramType: false,
        source: "",
      }),
    ).toBe("empty");
  });

  test("schedules display preview only when source exists and preview is empty", () => {
    expect(
      shouldScheduleMermaidDisplayPreview({
        renderState: "empty",
        source: "flowchart TD\n  A --> B",
      }),
    ).toBe(true);
    expect(
      shouldScheduleMermaidDisplayPreview({
        renderState: "finish",
        source: "flowchart TD\n  A --> B",
      }),
    ).toBe(false);
    expect(
      shouldScheduleMermaidDisplayPreview({
        renderState: "empty",
        source: "   ",
      }),
    ).toBe(false);
    expect(MERMAID_RENDER_DEBOUNCE_MS).toBe(120);
  });
});
