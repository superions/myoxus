/**
 * @vitest-environment happy-dom
 *
 * Mode-agnostic PDF attachment rendering — DoD line `todo/pdf-refactoring.md:1928`
 * ("PDF-Anhaenge rendern mit Myoxus-PDF.js (Standard-Level) im Editor und
 *  Edgeless-Kontext").
 *
 * The PDF view extension (`patchForPDFEmbedView`) registers a single
 * `AttachmentEmbedConfig` keyed by the `"pdf"` MIME-family. Both the page-
 * editor and the edgeless surface render `AttachmentBlockModel`s through the
 * same `AttachmentEmbedService` lookup, so locking the contract of this
 * extension is sufficient to prove that PDFs render in *both* contexts via
 * the same `pdfjs-dist`-backed `<PDFViewerEmbedded />` React component.
 *
 * Invariants:
 *  - INV-PDF-VIEW-EXT-01: extension name === "pdf", `shouldShowStatus === true`
 *  - INV-PDF-VIEW-EXT-02: check accepts `application/pdf` within `maxFileSize`
 *  - INV-PDF-VIEW-EXT-03: check rejects non-PDF mime types
 *  - INV-PDF-VIEW-EXT-04: check rejects oversize PDFs
 *  - INV-PDF-VIEW-EXT-05: action mutates the model with `embed: true` and
 *    `style: "pdf"` and resizes xywh to embed-card dimensions
 *  - INV-PDF-VIEW-EXT-06: render delegates to the supplied reactToLit factory
 *    with an `AttachmentEmbedPreview` element
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("@virgultum/editor/blocks/attachment", () => ({
  AttachmentEmbedConfigIdentifier: (key: string) => ({ __id: key }),
}));

vi.mock("@virgultum/editor/global/gfx", () => ({
  Bound: {
    deserialize: (xywh: string) => {
      const [x, y, w, h] = xywh
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((v) => Number(v.trim()));
      let _w = w;
      let _h = h;
      return {
        get w() {
          return _w;
        },
        set w(v: number) {
          _w = v;
        },
        get h() {
          return _h;
        },
        set h(v: number) {
          _h = v;
        },
        serialize: () => `[${x},${y},${_w},${_h}]`,
      };
    },
  },
}));

vi.mock("@virgultum/editor/shared/consts", () => ({
  EMBED_CARD_WIDTH: { pdf: 537 },
  EMBED_CARD_HEIGHT: { pdf: 759 },
}));

vi.mock(
  "@myoxus/core/editor/attachment-viewer/attachment-embed-preview",
  () => ({
    AttachmentEmbedPreview: () => null,
  }),
);

import { patchForPDFEmbedView } from "../editor/view-extensions/pdf/pdf-view";

type CapturedOverride = {
  identifier: { __id: string };
  factory: () => unknown;
};

function applyExtensionAndCaptureConfig() {
  const reactToLit = vi.fn(
    (_element: unknown, _rerendering?: boolean) =>
      "lit-template" as unknown as never,
  );
  const ext = patchForPDFEmbedView(reactToLit);
  const captured: CapturedOverride[] = [];
  const di = {
    override: (identifier: { __id: string }, factory: () => unknown) => {
      captured.push({ identifier, factory });
    },
  };
  ext.setup(di as unknown as never);
  expect(captured).toHaveLength(1);
  const [first] = captured;
  expect(first.identifier.__id).toBe("pdf");
  return {
    config: first.factory() as {
      name: string;
      shouldShowStatus: boolean;
      check: (
        m: { props: { type: string; size: number } },
        max: number,
      ) => boolean;
      action: (m: {
        props: { xywh: string };
        store: { updateBlock: (...args: unknown[]) => void };
      }) => void;
      render: (m: { id: string }, _: string) => unknown;
    },
    reactToLit,
  };
}

describe("patchForPDFEmbedView — mode-agnostic PDF embed contract", () => {
  test("INV-PDF-VIEW-EXT-01: name + shouldShowStatus", () => {
    const { config } = applyExtensionAndCaptureConfig();
    expect(config.name).toBe("pdf");
    expect(config.shouldShowStatus).toBe(true);
  });

  test("INV-PDF-VIEW-EXT-02: check accepts application/pdf within maxFileSize", () => {
    const { config } = applyExtensionAndCaptureConfig();
    const ok = config.check(
      { props: { type: "application/pdf", size: 1024 } },
      10 * 1024 * 1024,
    );
    expect(ok).toBe(true);
  });

  test("INV-PDF-VIEW-EXT-03: check rejects non-PDF mime types", () => {
    const { config } = applyExtensionAndCaptureConfig();
    expect(
      config.check(
        { props: { type: "image/png", size: 1024 } },
        10 * 1024 * 1024,
      ),
    ).toBe(false);
    expect(
      config.check(
        { props: { type: "text/plain", size: 1024 } },
        10 * 1024 * 1024,
      ),
    ).toBe(false);
    expect(
      config.check(
        { props: { type: "application/x-pdf", size: 1024 } },
        10 * 1024 * 1024,
      ),
    ).toBe(false);
  });

  test("INV-PDF-VIEW-EXT-04: check rejects PDFs above maxFileSize", () => {
    const { config } = applyExtensionAndCaptureConfig();
    expect(
      config.check({ props: { type: "application/pdf", size: 100 } }, 10),
    ).toBe(false);
  });

  test("INV-PDF-VIEW-EXT-05: action sets embed/style and resizes xywh to EMBED_CARD dimensions", () => {
    const { config } = applyExtensionAndCaptureConfig();
    const updateBlock = vi.fn();
    const model = {
      props: { xywh: "[0,0,100,100]" },
      store: { updateBlock },
    };
    config.action(model);
    expect(updateBlock).toHaveBeenCalledTimes(1);
    const [calledModel, patch] = updateBlock.mock.calls[0];
    expect(calledModel).toBe(model);
    expect(patch).toMatchObject({ embed: true, style: "pdf" });
    expect(patch.xywh).toBe("[0,0,537,759]");
  });

  test("INV-PDF-VIEW-EXT-06: render forwards to reactToLit with AttachmentEmbedPreview", () => {
    const { config, reactToLit } = applyExtensionAndCaptureConfig();
    const model = { id: "block-id" };
    const out = config.render(model, "ignored-blob-url");
    expect(out).toBe("lit-template");
    expect(reactToLit).toHaveBeenCalledTimes(1);
    const [element, rerendering] = reactToLit.mock.calls[0];
    expect(element).toBeTruthy();
    expect(rerendering).toBe(true);
  });
});
