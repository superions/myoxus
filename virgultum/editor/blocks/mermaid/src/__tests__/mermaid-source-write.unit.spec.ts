import { describe, expect, test } from "vitest";

import {
  resolveMermaidSourceWriteState,
  writeMermaidSourceModelState,
} from "../mermaid-source-write.js";
import { hashMermaidSource } from "../utils.js";

describe("Mermaid source write state", () => {
  test("normalizes fenced flowchart source and derives source metadata", () => {
    const state = resolveMermaidSourceWriteState(
      "```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```\n",
    );

    expect(state).toMatchObject({
      diagramType: "flowchart",
      source: "flowchart TD\n  A[Start] --> B[Done]",
      sourceHash: hashMermaidSource("flowchart TD\n  A[Start] --> B[Done]"),
    });
  });

  test("keeps unsupported source-first Mermaid", () => {
    const state = resolveMermaidSourceWriteState("info\n  showInfo");

    expect(state).toEqual({
      diagramType: "unknown",
      source: "info\n  showInfo",
      sourceHash: hashMermaidSource("info\n  showInfo"),
    });
  });

  test("keeps Timeline source outside owner GFX hashes", () => {
    const source = "timeline\n  title Releases\n  2026 : Launch";
    const state = resolveMermaidSourceWriteState(source);

    expect(state).toMatchObject({
      diagramType: "timeline",
      source,
      sourceHash: hashMermaidSource(source),
    });
  });

  test("writes model text and source metadata through one contract", () => {
    let storedSource = "old";
    let storedTitle = "Sequence";
    const model = {
      id: "mermaid-test",
      props: {
        diagramType: "sequenceDiagram",
        source: {
          get length() {
            return storedSource.length;
          },
          delete: () => {
            storedSource = "";
          },
          insert: (value: string) => {
            storedSource = value;
          },
        },
        sourceHash: "stale-source-hash",
        title: {
          get length() {
            return storedTitle.length;
          },
          delete: () => {
            storedTitle = "";
          },
          insert: (value: string) => {
            storedTitle = value;
          },
        },
      },
      store: {
        getParent: () => null,
      },
    } as never;

    const state = writeMermaidSourceModelState(
      model,
      "flowchart LR\r\n  A((Start)) --> B{Decision}",
    );
    const props = (
      model as {
        props: {
          diagramType: string;
          sourceHash: string;
        };
      }
    ).props;

    expect(storedSource).toBe(
      '---\ntitle: "Flowchart"\n---\nflowchart LR\n  A((Start)) --> B{Decision}',
    );
    expect(storedTitle).toBe("Flowchart");
    expect(props.diagramType).toBe("flowchart");
    expect(props.sourceHash).toBe(state.sourceHash);
  });
});
