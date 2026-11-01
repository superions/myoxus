// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Contract tests for replacing DOM CustomEvents with `MyoxusHostService` and
 * (`globalThis.currentEditor` debug hook removed, `Proxy`
 * replaced with explicit `MyoxusEditorContainer` adapter).
 *
 * The tests pin source-level invariants so a future regression
 * (e.g. someone re-introducing a DOM CustomEvent listener for
 * `myoxus-event-block-*` or re-assigning
 * `globalThis.currentEditor`) is caught by the Core suite.
 *
 * Runtime session dispatch and persistence are covered by the BPMN block/Core
 * session suite; these source guards do not replace its behavioral assertions.
 *
 * @see docs/dev/virgultum/architecture.md §B
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const repoRoot = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

describe("host-service migration contract", () => {
  describe("B-02: DOM CustomEvents replaced by MyoxusHostService", () => {
    test("event block no longer dispatches host-bound myoxus-event-block-*", () => {
      const eventBlock = readRepoFile(
        "virgultum/editor/blocks/event/src/event-block.ts",
      );
      const eventSlashMenu = readRepoFile(
        "virgultum/editor/blocks/event/src/slash-menu.ts",
      );

      for (const source of [eventBlock, eventSlashMenu]) {
        expect(source).not.toMatch(
          /new CustomEvent\(\s*["']myoxus-event-block-/,
        );
        expect(source).not.toMatch(
          /dispatchEvent\(\s*new CustomEvent\(\s*["']myoxus-event-block-/,
        );
      }
    });

    test("bpmn block no longer dispatches host-bound myoxus-bpmn-block-* (host side)", () => {
      const bpmnBlock = readRepoFile(
        "virgultum/editor/blocks/bpmn/src/bpmn-block.ts",
      );
      const bpmnSlashMenu = readRepoFile(
        "virgultum/editor/blocks/bpmn/src/slash-menu.ts",
      );

      // Block/menu entry points use the shared session dispatcher, never the
      // removed DOM host-event transport.
      for (const source of [bpmnBlock, bpmnSlashMenu]) {
        expect(source).not.toMatch(
          /dispatchEvent\(\s*new CustomEvent\(\s*["']myoxus-bpmn-block-open-requested/,
        );
        expect(source).not.toMatch(
          /dispatchEvent\(\s*new CustomEvent\(\s*["']myoxus-bpmn-block-action-requested/,
        );
        expect(source).not.toMatch(
          /dispatchEvent\(\s*new CustomEvent\(\s*["']myoxus-bpmn-block-insert-requested/,
        );
      }
    });

    test("event block and BPMN session dispatcher consume MyoxusHostServiceIdentifier", () => {
      const eventBlock = readRepoFile(
        "virgultum/editor/blocks/event/src/event-block.ts",
      );
      const bpmnBlock = readRepoFile(
        "virgultum/editor/blocks/bpmn/src/session-request.ts",
      );

      for (const source of [eventBlock, bpmnBlock]) {
        expect(source).toContain("MyoxusHostServiceIdentifier");
        expect(source).toContain("hasCapability");
      }
    });

    test("virgultum-editor.tsx removed the 4 host-bound addEventListener calls", () => {
      const source = readRepoFile(
        "client/libs/core/src/editor/virgultum/doc-editor/virgultum-editor.tsx",
      );

      expect(source).not.toMatch(
        /addEventListener\(\s*["']myoxus-event-block-insert/,
      );
      expect(source).not.toMatch(
        /addEventListener\(\s*["']myoxus-event-block-click/,
      );
      expect(source).not.toMatch(
        /addEventListener\(\s*["']myoxus-event-block-request/,
      );
      expect(source).not.toMatch(
        /addEventListener\(\s*["']myoxus-event-block-delete-requested/,
      );
    });
  });

  describe("B-03: globalThis.currentEditor removed, Proxy replaced with explicit adapter", () => {
    test("virgultum-editor.tsx no longer assigns globalThis.currentEditor", () => {
      const source = readRepoFile(
        "client/libs/core/src/editor/virgultum/doc-editor/virgultum-editor.tsx",
      );

      expect(source).not.toMatch(/globalThis\.currentEditor\s*=/);
      expect(source).not.toMatch(/window\.currentEditor\s*=/);
    });

    test("page-detail-editor.tsx no longer declares the var currentEditor global", () => {
      const source = readRepoFile(
        "client/libs/core/src/components/page-detail-editor.tsx",
      );

      expect(source).not.toMatch(/declare\s+global/);
      expect(source).not.toMatch(/\bvar\s+currentEditor\b/);
    });

    test("MyoxusEditorContainer adapter is explicit (no Proxy fallback)", () => {
      const source = readRepoFile(
        "client/libs/core/src/editor/virgultum/doc-editor/virgultum-editor.tsx",
      );

      // Block both the removed historical proxy and a renamed replacement;
      // B-03 requires an explicit object adapter rather than proxy delegation.
      expect(source).not.toMatch(/affineEditorContainerProxy/);
      expect(source).not.toMatch(/myoxusEditorContainerProxy/);
      expect(source).not.toMatch(/new Proxy\(\s*api/);
      // The container variable was renamed to
      // `myoxusEditorContainer` to make the type-vs-proxy
      // distinction visible at the call-site.
      expect(source).toMatch(/myoxusEditorContainer\b/);
    });

    test("MyoxusEditorContainer adapter keeps editor refs live via property descriptors", () => {
      const source = readRepoFile(
        "client/libs/core/src/editor/virgultum/doc-editor/virgultum-editor.tsx",
      );

      // `std`, `host`, `origin` and `updateComplete` depend on Lit refs that are
      // populated after the React render. `Object.assign` would eagerly evaluate
      // getters and permanently freeze these fields as undefined, causing the
      // editor bootstrap to crash before the document surface is rendered.
      expect(source).not.toMatch(
        /const adapter:\s*MyoxusEditorContainer\s*=\s*Object\.assign/,
      );
      expect(source).not.toMatch(/Object\.assign\(\s*Object\.create\(null\)/);
      expect(source).toContain("Object.defineProperties(adapter");
      expect(source).toMatch(/std:\s*\{\s*[\s\S]*?get\(\)\s*\{/);
      expect(source).toMatch(/host:\s*\{\s*[\s\S]*?get\(\)\s*\{/);
      expect(source).toMatch(/updateComplete:\s*\{\s*[\s\S]*?get\(\)\s*\{/);
    });
  });

  describe("B-01: MyoxusHostService surface is the single boundary", () => {
    test("shared services barrel re-exports the host module", () => {
      const source = readRepoFile(
        "virgultum/editor/shared/src/services/index.ts",
      );

      expect(source).toContain('export * from "./host"');
    });

    test("host module exports the identifier, the extension, and the null binding", () => {
      const hostIndex = readRepoFile(
        "virgultum/editor/shared/src/services/host/index.ts",
      );

      expect(hostIndex).toContain("./types");
      expect(hostIndex).toContain("./myoxus-host-service");
      expect(hostIndex).toContain("./myoxus-host-extension");
    });
  });

  describe("B-FIND-02: MyoxusEditorContainer.origin is honest (HTMLDivElement | null)", () => {
    test("adapter type declares origin as HTMLDivElement | null (no double cast)", () => {
      const source = readRepoFile(
        "client/libs/core/src/editor/virgultum/doc-editor/virgultum-editor.tsx",
      );

      // The legacy type `origin: HTMLDivElement;` (non-null)
      // forced a `as unknown as HTMLDivElement` cast on
      // `rootRef.current`, which silently lied when the React
      // ref had not yet attached. B-FIND-02 widens the
      // adapter surface to `HTMLDivElement | null` and drops
      // the cast.
      expect(source).toMatch(/origin:\s*HTMLDivElement\s*\|\s*null/);
      expect(source).not.toMatch(
        /return\s+rootRef\.current\s+as\s+unknown\s+as\s+HTMLDivElement/,
      );
    });

    test("use-export-page no longer double-casts the adapter origin", () => {
      const source = readRepoFile(
        "client/libs/core/src/components/hooks/myoxus/use-export-page.ts",
      );

      // The consumer used `(editorContainer as any).origin` to
      // bypass the legacy type lie. With the new honest
      // contract the cast is gone.
      expect(source).not.toMatch(
        /\(editorContainer\s+as\s+any\)\.origin\s+as\s+MyoxusEditorContainer/,
      );
    });
  });
});
