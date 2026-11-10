// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `import-boundary-guard.unit.spec.ts` — P-VIRG-ARCH-H-01
 * unit tests for the import-boundary guard's static-analysis
 * core.
 *
 * The runtime check is a CLI; these tests exercise the
 * pure-function parts (the regex extraction + rule
 * application) so the guard cannot regress silently.
 *
 * **Pinned invariants:**
 *   1. Single-quoted and double-quoted `from "<path>"` are
 *      extracted with 1-based line numbers.
 *   2. Multi-line imports (continued on next line) are
 *      attributed to the line of the `from` keyword.
 *   3. Non-`@virgultum/` imports are ignored.
 *   4. The block rules catch `@virgultum/editor/all` and
 *      `@virgultum/editor/widgets/*` paths.
 *   5. The widget rules catch `@virgultum/editor/all` and
 *      `@virgultum/editor/widgets/*` paths.
 *   6. A clean source produces zero violations.
 *
 * The integration (walking the repo + spawning the CLI) is
 * covered by the bash wrapper test in
 * `build/scripts/test/guard-import-boundaries.sh`.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §H
 *      (P-VIRG-ARCH-H-01)
 */

import { describe, expect, test } from "vitest";

import {
  extractVirgultumImports,
  type PackageRule,
  runCheckOnSource,
} from "../import-boundary-guard.js";

describe("P-VIRG-ARCH-H-01 import-boundary guard", () => {
  describe("extractVirgultumImports", () => {
    test("extracts single-quoted from-import with line number", () => {
      const src = `import { foo } from '@virgultum/editor/all';\n`;
      const imports = Array.from(extractVirgultumImports(src, "x.ts"));
      expect(imports).toHaveLength(1);
      expect(imports[0]).toEqual({
        line: 1,
        importPath: "@virgultum/editor/all",
      });
    });

    test("extracts double-quoted from-import with line number", () => {
      const src = `import { foo } from "@virgultum/editor/widgets/x";\n`;
      const imports = Array.from(extractVirgultumImports(src, "x.ts"));
      expect(imports).toHaveLength(1);
      expect(imports[0]?.line).toBe(1);
    });

    test("ignores non-virgultum imports", () => {
      const src = [
        `import lodash from "lodash-es";`,
        `import { z } from "zod";`,
        `import * as Y from "yjs";`,
        ``,
        `import { foo } from "@virgultum/std/gfx";`,
        ``,
      ].join("\n");
      const imports = Array.from(extractVirgultumImports(src, "x.ts"));
      expect(imports).toHaveLength(1);
      expect(imports[0]?.importPath).toBe("@virgultum/std/gfx");
    });

    test("multi-line imports: line of `from` keyword wins", () => {
      const src = [
        `import {`,
        `  foo,`,
        `  bar,`,
        `} from "@virgultum/editor/all";`,
        ``,
      ].join("\n");
      const imports = Array.from(extractVirgultumImports(src, "x.ts"));
      expect(imports).toHaveLength(1);
      // The `from` keyword is on line 4 of the input.
      expect(imports[0]?.line).toBe(4);
    });

    test("imports on multiple lines", () => {
      const src = [
        `import { a } from "@virgultum/editor/all";`, // line 1
        `import { b } from "@virgultum/editor/widgets/x";`, // line 2
      ].join("\n");
      const imports = Array.from(extractVirgultumImports(src, "x.ts"));
      expect(imports).toHaveLength(2);
      expect(imports[0]?.line).toBe(1);
      expect(imports[1]?.line).toBe(2);
    });

    test('static `import "<path>"` is extracted', () => {
      const src = `import "@virgultum/editor/widgets/x";\n`;
      const imports = Array.from(extractVirgultumImports(src, "x.ts"));
      expect(imports).toHaveLength(1);
      expect(imports[0]?.importPath).toBe("@virgultum/editor/widgets/x");
    });
  });

  describe("runCheckOnSource (rule application)", () => {
    const BLOCKS_RULE: PackageRule = {
      name: "blocks",
      pathPrefix: "virgultum/editor/blocks",
      forbiddenImportPatterns: [
        {
          pattern: /@virgultum\/editor\/all\b/,
          rule: "BLOCKS-CANNOT-IMPORT-ALL",
          reason: "blocks cannot import all",
        },
        {
          pattern: /@virgultum\/editor\/widgets\//,
          rule: "BLOCKS-CANNOT-IMPORT-WIDGETS",
          reason: "blocks cannot import widgets",
        },
      ],
    };

    const WIDGETS_RULE: PackageRule = {
      name: "widgets",
      pathPrefix: "virgultum/editor/widgets",
      forbiddenImportPatterns: [
        {
          pattern: /@virgultum\/editor\/all\b/,
          rule: "WIDGETS-CANNOT-IMPORT-ALL",
          reason: "widgets cannot import all",
        },
        {
          pattern: /@virgultum\/editor\/widgets\//,
          rule: "WIDGETS-CANNOT-IMPORT-WIDGETS",
          reason: "widgets cannot import widgets",
        },
      ],
    };

    test("blocks importing editor/all is caught", () => {
      const src = `import { foo } from "@virgultum/editor/all";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/blocks/note/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("BLOCKS-CANNOT-IMPORT-ALL");
      expect(violations[0]?.line).toBe(1);
    });

    test("blocks importing a widget is caught", () => {
      const src = `import { foo } from "@virgultum/editor/widgets/drag-handle";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/blocks/note/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("BLOCKS-CANNOT-IMPORT-WIDGETS");
    });

    test("widgets importing editor/all is caught", () => {
      const src = `import { foo } from "@virgultum/editor/all";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/widgets/slash-menu/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("WIDGETS-CANNOT-IMPORT-ALL");
    });

    test("widgets importing another widget is caught", () => {
      const src = `import { foo } from "@virgultum/editor/widgets/drag-handle";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/widgets/slash-menu/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.rule).toBe("WIDGETS-CANNOT-IMPORT-WIDGETS");
    });

    test("blocks importing model is allowed (no rule matches)", () => {
      const src = `import { foo } from "@virgultum/editor/model";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/blocks/note/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(0);
    });

    test("widgets importing model is allowed", () => {
      const src = `import { foo } from "@virgultum/editor/model";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/widgets/slash-menu/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(0);
    });

    test("components/ path is outside the rule prefix and ignored", () => {
      const src = `import { foo } from "@virgultum/editor/all";\n`;
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/components/foo/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(0);
    });

    test("clean source produces zero violations", () => {
      const src = [
        `import { foo } from "@virgultum/editor/model";`,
        `import { bar } from "@virgultum/std/gfx";`,
        `import lodash from "lodash-es";`,
      ].join("\n");
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/blocks/note/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toEqual([]);
    });

    test("multiple violations in one file all reported", () => {
      const src = [
        `import { a } from "@virgultum/editor/all";`, // line 1
        `import { b } from "@virgultum/editor/widgets/x";`, // line 2
      ].join("\n");
      const violations = runCheckOnSource(
        src,
        "virgultum/editor/blocks/note/src/x.ts",
        [BLOCKS_RULE, WIDGETS_RULE],
      );
      expect(violations).toHaveLength(2);
      expect(violations[0]?.line).toBe(1);
      expect(violations[1]?.line).toBe(2);
    });
  });
});
