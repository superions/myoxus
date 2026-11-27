// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  hasDocumentReferenceSelection,
  projectDocumentReferenceSelection,
} from "@virgultum/core/adapters";
import type { NoteBlockModel } from "@virgultum/core/models";
import type { BlockModel, BlockSnapshot, Store } from "@virgultum/core/store";
import { createContext } from "react";
import { readPageContent, type PageContent } from "./plain-page-model";

export const MAX_SYNCED_DOC_DEPTH = 3;

export const SyncedDocAncestorsContext = createContext<ReadonlySet<string>>(
  new Set(),
);

export function syncedDocAncestorKey(workspaceId: string, docId: string) {
  return `${workspaceId}:${docId}`;
}

export function collectProjectedBlockIds(root: BlockSnapshot): Set<string> {
  const ids = new Set<string>();
  const stack: BlockSnapshot[] = [root];
  while (stack.length) {
    const current = stack.pop()!;
    if (
      current.flavour !== "myoxus:page" &&
      current.flavour !== "myoxus:note"
    ) {
      ids.add(current.id);
    }
    for (let i = current.children.length - 1; i >= 0; i--) {
      stack.push(current.children[i]);
    }
  }
  return ids;
}

export function collectReadableBodyBlocks(
  page: Store,
  allowedIds?: ReadonlySet<string>,
): BlockModel[] {
  const root = page.root;
  if (!root) return [];
  const result: BlockModel[] = [];
  const surfaceDiagrams: BlockModel[] = [];
  const seen = new Set<string>([root.id]);
  const visit = (parent: BlockModel) => {
    for (const child of parent.children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      if (child.flavour === "myoxus:surface") {
        for (const surfaceChild of child.children) {
          if (seen.has(surfaceChild.id)) continue;
          seen.add(surfaceChild.id);
          if (
            (surfaceChild.flavour === "myoxus:mermaid" ||
              surfaceChild.flavour === "myoxus:bpmn") &&
            (!allowedIds || allowedIds.has(surfaceChild.id))
          ) {
            surfaceDiagrams.push(surfaceChild);
          }
        }
        continue;
      }
      if (child.flavour === "myoxus:note") {
        const note = child as NoteBlockModel;
        if (note.props.hidden || note.props.displayMode === "edgeless")
          continue;
        visit(note);
        continue;
      }
      if (!allowedIds || allowedIds.has(child.id)) {
        result.push(child);
      }
      visit(child);
    }
  };
  visit(root);
  result.push(...surfaceDiagrams);
  return result;
}

export function isPageContentEmpty(content: PageContent): boolean {
  if (!content.body.length) return true;
  return content.body.every((item) => "text" in item && item.text.length === 0);
}

export type SyncedDocProjectionResult =
  | {
      status: "ok";
      selected: boolean;
      content: PageContent | null;
      fallbackLines: BlockModel[];
      empty: boolean;
    }
  | {
      status: "error";
      selected: boolean;
      reason: string;
    };

/**
 * Project a live readonly target Store into PageContent for a synced-doc embed.
 * Selected embeds (OBS-14 heading-section or block-subtree) run strictly through
 * `projectDocumentReferenceSelection` so missing, deleted, non-heading, or
 * ambiguous selections fail closed instead of widening to the full document.
 */
export function projectSyncedDocContent(
  page: Store,
  params: unknown,
  mode: string | undefined,
): SyncedDocProjectionResult {
  let selected = false;
  try {
    selected = hasDocumentReferenceSelection(params);
  } catch (error) {
    return {
      status: "error",
      selected: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let allowedIds: Set<string> | undefined;
  if (selected) {
    if (mode === "edgeless") {
      return {
        status: "error",
        selected: true,
        reason: "Selected document preview requires Page mode",
      };
    }
    if (!page.root) {
      return {
        status: "error",
        selected: true,
        reason: "Selected document target unavailable",
      };
    }
    const transformer = page.getTransformer([]);
    try {
      const snapshot = transformer.docToSnapshot(page);
      if (!snapshot) {
        return {
          status: "error",
          selected: true,
          reason: "Selected document target unavailable",
        };
      }
      const projected = projectDocumentReferenceSelection(snapshot, params);
      allowedIds = collectProjectedBlockIds(projected.blocks);
      if (!allowedIds.size) {
        return {
          status: "error",
          selected: true,
          reason: "Embedded selection target missing",
        };
      }
    } catch (error) {
      return {
        status: "error",
        selected: true,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      transformer[Symbol.dispose]();
    }
  }

  const content = readPageContent(page, "snapshot", allowedIds);
  if (content) {
    return {
      status: "ok",
      selected,
      content,
      fallbackLines: [],
      empty: isPageContentEmpty(content),
    };
  }

  // Fallback for documents containing blocks not yet covered by readPageContent:
  // still honor allowedIds strictly so unselected content is never disclosed.
  const fallbackLines = collectReadableBodyBlocks(page, allowedIds).filter(
    (block) => !!block.text?.length,
  );
  return {
    status: "ok",
    selected,
    content: null,
    fallbackLines,
    empty: fallbackLines.length === 0,
  };
}
