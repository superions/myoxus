// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyDiagnostic } from "./diagnostics.js";
import type { SankeySourceDocument } from "./source-document.js";
import type { SankeyConfig } from "./config.js";

export type SankeyNode = {
  readonly id: string;
  readonly label: string;
  readonly occurrences: readonly {
    recordId: string;
    field: "source" | "target";
  }[];
};

export type SankeyLink = {
  readonly id: string;
  readonly source?: string;
  readonly target?: string;
  readonly value: number;
  readonly renderable: boolean;
};

export type SankeyModel = {
  readonly diagramType: "sankey";
  readonly version: 2;
  readonly sourceDocument: SankeySourceDocument;
  readonly nodes: readonly SankeyNode[];
  readonly links: readonly SankeyLink[];
  readonly diagnostics: readonly SankeyDiagnostic[];
  readonly ambiguous: boolean;
  readonly config: SankeyConfig;
  /** Fields explicitly owned by frontmatter or an init directive. */
  readonly configOverrides: readonly (keyof SankeyConfig)[];
  readonly title: string;
  readonly comments: readonly {
    readonly id: string;
    readonly text: string;
    readonly linkId?: string;
  }[];
};
