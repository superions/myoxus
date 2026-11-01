/**
 * @vitest-environment happy-dom
 */

import { describe, expect, test, vi } from "vitest";
import {
  createMermaidBlockInsertProps,
  getMermaidBlockSource,
} from "@virgultum/block-mermaid";
import {
  MermaidBlockSchemaExtension,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from "@virgultum/model";
import { Text } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { MarkdownTransformer } from "@virgultum/editor/widgets/linked-doc";

import {
  importMermaidFilesToDocs,
  normalizeMermaidImportMarkdown,
} from "./mermaid-import";

describe("Mermaid import normalisation", () => {
  test("retains standalone Kanban bytes in the imported source and removes a failed import", async () => {
    const source =
      '---\r\ntitle: "Imported"\r\n---\r\nKANBAN\r\n  todo[Same]\r\n    %% object comment\r\n    ["Same"]@{retained: "foreign"}  \r\n';
    const workspace = new TestWorkspace({ id: "kanban-import-fidelity" });
    workspace.meta.initialize();
    const doc = workspace.createDoc("imported");
    doc.load();
    const store = doc.getStore({
      id: "imported",
      extensions: [
        RootBlockSchemaExtension,
        NoteBlockSchemaExtension,
        MermaidBlockSchemaExtension,
      ],
    });
    const root = store.addBlock("myoxus:page", { title: new Text("Imported") });
    const note = store.addBlock("myoxus:note", {}, root);
    const block = store.addBlock(
      "myoxus:mermaid",
      createMermaidBlockInsertProps({
        source: source.replaceAll("\r\n", "\n").trimEnd(),
      }),
      note,
    );
    const importer = vi
      .spyOn(MarkdownTransformer, "importMarkdownToDoc")
      .mockResolvedValue({ docId: doc.id } as never);
    const file = { name: "retained.mmd", text: async () => source } as File;
    try {
      expect(
        await importMermaidFilesToDocs({
          collection: workspace,
          files: [file],
        }),
      ).toEqual([doc.id]);
      expect(getMermaidBlockSource(store.getBlock(block)!.model.props)).toBe(
        source,
      );
      store.deleteBlock(store.getBlock(block)!.model);
      await expect(
        importMermaidFilesToDocs({ collection: workspace, files: [file] }),
      ).rejects.toThrow("requires one source block");
      expect(workspace.getDoc(doc.id)).toBeNull();
    } finally {
      importer.mockRestore();
      workspace.dispose();
    }
  });
  test("wraps .mmd files as Mermaid fences for the shared MarkdownTransformer path", () => {
    expect(
      normalizeMermaidImportMarkdown(
        "flow.mmd",
        "flowchart TD\r\n  A --> B\r\n",
      ),
    ).toBe("```mermaid\nflowchart TD\n  A --> B\n```\n");
  });

  test("preserves Markdown documents that already contain Mermaid fences", () => {
    const markdown = "# Diagram\n\n```mermaid\nflowchart TD\n  A --> B\n```\n";

    expect(normalizeMermaidImportMarkdown("diagram.md", markdown)).toBe(
      markdown,
    );
  });

  test("does not create nested fences when a Mermaid file already contains one", () => {
    expect(
      normalizeMermaidImportMarkdown(
        "flow.mmd",
        "```mermaid\nflowchart TD\n  A --> B\n```\n",
      ),
    ).toBe("```mermaid\nflowchart TD\n  A --> B\n```\n");
  });

  test("wraps unfenced Mermaid source even when pasted through a markdown file", () => {
    expect(
      normalizeMermaidImportMarkdown(
        "diagram.md",
        "sequenceDiagram\nA->>B: Hi",
      ),
    ).toBe("```mermaid\nsequenceDiagram\nA->>B: Hi\n```\n");
  });

  test("wraps all Mermaid 11 diagram families when imported as unfenced markdown text", () => {
    const sources = [
      'C4Context\n  Person(user, "User")\n',
      "architecture-beta\n  group api(icon)[API]\n",
      "block-beta\n  A --> B\n",
      "classDiagram\n  class Foo\n",
      "classDiagram-v2\n  class Foo\n",
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n",
      "flowchart TD\n  A --> B\n",
      "flowchart-elk TD\n  A --> B\n",
      "graph TD\n  A --> B\n",
      "gantt\n  dateFormat YYYY-MM-DD\n  section Work\n  Task :a1, 2026-01-01, 1d\n",
      'gitGraph\n  commit id:"A"\n',
      "info\nshowInfo\n",
      "journey\n  section Use\n    Start: 5: User\n",
      "kanban\n  todo[To Do]\n    t1[Task]\n",
      "mindmap\n  root((Root))\n    Child\n",
      'packet\n  0-3: "Version"\n',
      'pie\n  "A" : 1\n',
      "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  Item : [0.2, 0.8]\n",
      "radar-beta\n  axis Speed, Quality\n  curve A {3,4}\n",
      "requirementDiagram\n  requirement req1 {\n    id: 1\n  }\n",
      "sankey\n  A, B, 1\n",
      "sequenceDiagram\n  Alice->>Bob: Hi\n",
      "stateDiagram\n  [*] --> A\n",
      "stateDiagram-v2\n  [*] --> A\n",
      "timeline\n  2026 : Launch\n",
      'treemap-beta\n"Root"\n  "A": 1\n',
      'xychart-beta\ntitle "Sales"\nx-axis [jan, feb]\ny-axis "Revenue" 0 --> 10\nbar [1, 2]\n',
    ];

    for (const source of sources) {
      expect(normalizeMermaidImportMarkdown("diagram.md", source)).toBe(
        `\`\`\`mermaid\n${source.trimEnd()}\n\`\`\`\n`,
      );
    }
  });

  test("does not classify ordinary Markdown as Mermaid source", () => {
    const markdown = "# Notes\n\nThis is not a diagram.\n";

    expect(normalizeMermaidImportMarkdown("notes.md", markdown)).toBe(markdown);
  });
});
