/**
 * @vitest-environment happy-dom
 */

import { cleanup, render, screen } from "@testing-library/react";
import { createMermaidBlockInsertProps } from "@virgultum/block-mermaid";
import {
  MermaidBlockSchemaExtension,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/model";
import { type Store, Text } from "@virgultum/store";
import {
  createAutoIncrementIdGenerator,
  TestWorkspace,
} from "@virgultum/store/test";
import { afterEach, describe, expect, test, vi } from "vitest";

const nativeExport = vi.hoisted(() => ({
  render: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@virgultum/block-mermaid", async (original) => ({
  ...(await original<typeof import("@virgultum/block-mermaid")>()),
  renderMermaidSvg: nativeExport.render,
}));
vi.mock("@virgultum/editor/widgets/linked-doc", async (original) => ({
  ...(await original<typeof import("@virgultum/editor/widgets/linked-doc")>()),
  download: nativeExport.download,
}));

vi.mock("@myoxus/ui-facade", () => ({
  MenuItem: ({
    children,
    disabled,
    "data-testid": dataTestId,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <div data-testid={dataTestId} data-disabled={disabled ? "true" : undefined}>
      {children}
    </div>
  ),
  MenuSeparator: () => <hr />,
  MenuSub: ({ items }: { items: React.ReactNode }) => (
    <div data-testid="menu-sub-items">{items}</div>
  ),
}));

vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      header: { docOptions: { export: () => {} } },
      sharePanel: { $: { export: () => {} } },
    },
  },
}));

import { __test__ as exportHookTest } from "../components/hooks/myoxus/use-export-page";
import { ExportMenuItems } from "../components/page-list/operation-menu-items/export";

function createMermaidExportTestStore(): Store {
  const workspace = new TestWorkspace({
    id: "mermaid-kanban-export-test",
    idGenerator: createAutoIncrementIdGenerator(),
  });
  workspace.meta.initialize();
  const doc = workspace.createDoc("doc0");
  doc.load();
  return doc.getStore({
    extensions: [
      RootBlockSchemaExtension,
      NoteBlockSchemaExtension,
      MermaidBlockSchemaExtension,
    ],
  });
}

function insertKanbanDiagram(store: Store) {
  const rootId = store.addBlock("myoxus:page", {
    title: new Text("Mermaid Kanban export"),
  });
  const noteId = store.addBlock("myoxus:note", {}, rootId);
  store.addBlock(
    "myoxus:mermaid",
    createMermaidBlockInsertProps({
      source:
        "kanban\n  todo[To Do]\n    spec[Write spec]\n  done[Done]\n    ship[Ship]\n",
      title: "Imported Kanban",
    }),
    noteId,
  );
}

describe("Mermaid export contract", () => {
  afterEach(() => cleanup());

  test("exposes Mermaid-specific export formats only for Mermaid diagram docs", () => {
    render(
      <ExportMenuItems exportHandler={() => {}} isMermaidDiagram={false} />,
    );
    expect(screen.queryByTestId("export-to-mermaid-source")).toBeNull();
    cleanup();

    render(<ExportMenuItems exportHandler={() => {}} isMermaidDiagram />);

    expect(screen.getByTestId("export-to-mermaid-source")).toBeTruthy();
    expect(screen.getByTestId("export-to-mermaid-markdown")).toBeTruthy();
    expect(screen.getByTestId("export-to-mermaid-svg")).toBeTruthy();
    expect(screen.getByTestId("export-to-mermaid-png")).toBeTruthy();
  });

  test("serializes Mermaid Markdown export as a fenced Mermaid block", () => {
    expect(exportHookTest.mermaidMarkdownFence("flowchart TD\nA-->B\n")).toBe(
      "```mermaid\nflowchart TD\nA-->B\n```\n",
    );
  });

  test("normalizes unsafe filesystem characters in Mermaid export filenames", () => {
    expect(exportHookTest.normalizeExportFileName('A/B:C*"D<>|')).toBe(
      "A_B_C__D___",
    );
  });

  test("serializes Mermaid Kanban diagram docs as Mermaid source", () => {
    const store = createMermaidExportTestStore();
    insertKanbanDiagram(store);

    expect(exportHookTest.getFirstMermaidSource(store)).toBe(
      '---\ntitle: "Imported Kanban"\n---\nkanban\n  todo[To Do]\n    spec[Write spec]\n  done[Done]\n    ship[Ship]\n',
    );
  });

  test("downloads native SVG with its font asset and resolved inherited typography", async () => {
    const fontStyle = document.createElement("style");
    const face =
      '@font-face { font-family: ExportFixture; src: url("/api/fonts/export-fixture.ttf"); font-weight: 100 900; }';
    fontStyle.textContent = face + face;
    document.head.append(fontStyle);
    const oldFonts = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), {
            headers: { "content-type": "font/ttf" },
          }),
      ),
    );
    nativeExport.render.mockResolvedValue({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40" style="font-family: ExportFixture; font-size: 14px"><text x="2" y="20">Native ID</text></svg>',
    });
    const store = createMermaidExportTestStore();
    insertKanbanDiagram(store);
    nativeExport.download.mockClear();
    const source = exportHookTest.getFirstMermaidSource(store);
    try {
      await exportHookTest.exportMermaidDoc(store, "mermaid-svg");
      const [blob, name] = nativeExport.download.mock.calls[0]!;
      const svg = await (blob as Blob).text();
      expect(name).toBe("Untitled.svg");
      expect(svg).toContain("data:font/ttf;base64,AQID");
      expect(svg.match(/@font-face/g)).toHaveLength(1);
      const root = new DOMParser().parseFromString(
        svg,
        "image/svg+xml",
      ).documentElement;
      expect(root.getAttribute("viewBox")).toBe("0 0 100 40");
      expect(root.querySelector("text")?.getAttribute("style")).toContain(
        "font-family: ExportFixture",
      );
      expect(exportHookTest.getFirstMermaidSource(store)).toBe(source);
    } finally {
      fontStyle.remove();
      if (oldFonts) Object.defineProperty(document, "fonts", oldFonts);
      else Reflect.deleteProperty(document, "fonts");
      vi.unstubAllGlobals();
      store.workspace.dispose();
    }
  });
});
