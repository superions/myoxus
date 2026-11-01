// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JourneyDiagnostic } from "./diagnostics.js";
import type { JourneyRange, JourneySourceDocument } from "./source-document.js";
export type MermaidJourneySection = {
  id: string;
  sourceKey: string;
  order: number;
  title: string;
  implicit: boolean;
  labelRange?: JourneyRange;
  indent: string;
  writable: boolean;
};
export type MermaidJourneyStep = {
  id: string;
  sourceKey: string;
  label: string;
  order: number;
  score: number;
  scoreLexeme: string;
  actors: string[];
  actorLexeme?: string;
  tail: string;
  sectionId: string;
  indent: string;
  labelRange: JourneyRange;
  scoreRange: JourneyRange;
  actorsRange?: JourneyRange;
  actorsInsertion: number;
  writable: boolean;
};
export type MermaidJourneyComment = {
  id: string;
  text: string;
  line: string;
  range: JourneyRange;
  indent: string;
  anchorId: string | null;
  affinity: "object" | "position";
  inline?: boolean;
};
export type MermaidJourneyModel = {
  diagramType: "journey";
  version: 1;
  sourceHash: string;
  sourceDocument: JourneySourceDocument;
  headerId: string;
  sections: MermaidJourneySection[];
  steps: MermaidJourneyStep[];
  comments: MermaidJourneyComment[];
  title: string;
  accessibilityTitle: string;
  accessibilityDescription: string;
  diagnostics: JourneyDiagnostic[];
  ambiguous: boolean;
  staleProjection?: boolean;
};
