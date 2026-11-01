// SPDX-License-Identifier: AGPL-3.0-or-later

import type { JourneyCommand } from "@virgultum/block-mermaid";
let draftKey = 0;
export type JourneyDraft = {
  key: string;
  kind: "section" | "step";
  sectionId?: string;
  afterId?: string;
  source: string;
  label?: string;
  score?: number;
  actors?: string[];
};
export function createJourneyDraft(
  kind: JourneyDraft["kind"],
  source: string,
  sectionId?: string,
  afterId?: string,
): JourneyDraft {
  return {
    key: `journey-draft-${++draftKey}`,
    kind,
    source,
    sectionId,
    afterId,
  };
}
export function journeyDraftCommand(
  draft: JourneyDraft,
  label: string,
): JourneyCommand {
  return {
    type: "add",
    kind: draft.kind,
    label,
    sectionId: draft.sectionId,
    score: draft.score,
    actors: draft.actors,
    afterId: draft.afterId,
  };
}

/** An existing label edit keeps its opening source even if a different gesture starts. */
export type JourneyRenameDraft = {
  id: string;
  kind: "section" | "step";
  label: string;
  source: string;
  conflicted?: boolean;
};
