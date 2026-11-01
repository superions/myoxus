import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import {
  orderedGitGraphBranches,
  gitGraphBinding,
  type GitGraphReactHostProps,
  type GitGraphAction,
  type MermaidGfxObjectEditIntent,
} from "@virgultum/block-mermaid";
/** Root controls have their own transient lifetime; semantic selection, Source
 * and history still belong to the single Mermaid owner. */
export function useGitGraphSelection(
  input: GitGraphReactHostProps,
): GitGraphReactHostProps {
  const [parent, setParent] = useState<GitGraphAction | null>(null),
    [intent, setIntent] = useState<MermaidGfxObjectEditIntent | null>(null),
    latest = useRef(input);
  latest.current = input;
  useEffect(() => {
    latest.current.onCancelPreview();
    setParent(null);
    setIntent(null);
  }, [input.sourceBasis, input.readonly, input.selected?.sourceKey]);
  const { subscribeEditIntent } = input;
  useEffect(
    () =>
      subscribeEditIntent?.((next) => {
        setParent(next.action === "delete" ? "deleteSelection" : null);
        setIntent(
          next.action === "select" || next.action === "delete" ? null : next,
        );
      }),
    [subscribeEditIntent],
  );
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => {
      const localControl =
        event.target instanceof Element
          ? event.target.closest(
              'input,textarea,select,button,[role="combobox"],[role="dialog"],[contenteditable="true"]',
            )
          : null;
      // GFX focus proxies are the owning diagram objects, not form controls.
      // Their arrows, Enter and Delete must reach the same semantic intents.
      if (
        localControl &&
        !localControl.matches(".myoxus-mermaid-gfx-object-focus-proxy")
      )
        return;
      // The scoped GFX proxy selects and reveals its own carrier before opening
      // Enter. Capturing it here would edit the previous semantic selection.
      if (
        event.key === "Enter" &&
        localControl?.matches(".myoxus-mermaid-gfx-object-focus-proxy")
      )
        return;
      const current = latest.current;
      const focusedKey = localControl?.getAttribute("data-mermaid-edit-key");
      const focusedObject = focusedKey
        ? (current.visualModel.nodes.find((node) => node.id === focusedKey) ??
          current.visualModel.edges.find((edge) => edge.id === focusedKey))
        : undefined;
      const focused = focusedObject && gitGraphBinding(focusedObject);
      if ((!current.selected && !focused) || current.displayOnly) return;
      const focusTarget = current.resolveReturnFocusTarget(),
        owner =
          current.surface === "editor"
            ? focusTarget?.closest(".myoxus-mermaid-gfx-viewport")
            : focusTarget;
      // Hidden Page/Edgeless hosts and other Mermaid owners may stay mounted.
      // A global keyboard listener must consume only its own active scope.
      if (!owner || !event.composedPath().includes(owner)) return;
      if (
        [
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      ) {
        const p = latest.current,
          selected = focused ?? p.selected!;
        const records = p.model.sourceDocument!.records.filter((r) =>
            ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
              r.kind,
            ),
          ),
          occurrence = p.model.derivedGraph?.occurrences.find(
            (c) => c.sourceKey === selected.sourceKey,
          ),
          branch =
            selected.branch ??
            occurrence?.branchId ??
            p.model.derivedGraph?.contexts.find(
              (c) => c.sourceKey === selected.sourceKey,
            )?.branch,
          index = records.findIndex((r) => r.sourceKey === selected.sourceKey);
        let key: string | undefined;
        let role: "origin" | "head" | undefined;
        if (event.key === "Home" || event.key === "End") {
          // Origins and heads are branch carriers, including an empty branch.
          // Selecting its first/last commit loses the actual branch boundary.
          key = p.model.branches.find((b) => b.id === branch)?.sourceKey;
          role = event.key === "Home" ? "origin" : "head";
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          const branches = orderedGitGraphBranches(p.model),
            lane = branches.findIndex((b) => b.id === branch),
            next = branches[lane + (event.key === "ArrowUp" ? -1 : 1)];
          if (next) {
            const commits =
              p.model.derivedGraph?.occurrences.filter(
                (c) => c.branchId === next.id,
              ) ?? [];
            key = commits.reduce<typeof occurrence>(
              (nearest, c) =>
                !nearest ||
                Math.abs(c.order - (occurrence?.order ?? 0)) <
                  Math.abs(nearest.order - (occurrence?.order ?? 0))
                  ? c
                  : nearest,
              undefined,
            )?.sourceKey;
            // Main is owned by the header; every branch already carries its
            // occurrence key, including empty and sanitized branch names.
            key ??= next.sourceKey;
          }
        } else
          key =
            records[index + (event.key === "ArrowLeft" ? -1 : 1)]?.sourceKey;
        if (key) {
          event.preventDefault();
          event.stopImmediatePropagation();
          p.onCancelPreview();
          p.selectSourceKey(key, role);
        }
        return;
      }
      if (event.key === "Escape") {
        if (
          !(input.surface === "controls"
            ? intent || parent
            : latest.current.intent || latest.current.parentIntent)
        )
          return;
        consumeMyoxusEditorEscape(event);
        event.preventDefault();
        latest.current.onCancelPreview();
        if (input.surface === "controls") {
          setParent(null);
          setIntent(null);
        } else latest.current.onCloseSelection();
        return;
      }
      if (!current.readonly && current.selected && event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const intent = {
          kind: current.selected.kind,
          id: current.selected.visualKey,
        };
        if (input.surface === "controls") setIntent(intent);
        else latest.current.onEditIntent(intent);
      }
      if (
        !current.readonly &&
        current.selected?.role !== "relationship" &&
        !current.selectionProblem &&
        ["Delete", "Backspace"].includes(event.key)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (input.surface === "controls") setParent("deleteSelection");
        else latest.current.onParentIntent("deleteSelection");
      }
    };
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [
    input.surface,
    input.readonly,
    input.displayOnly,
    input.selected,
    input.selectionProblem,
    intent,
    parent,
  ]);
  return input.surface !== "controls"
    ? input
    : {
        ...input,
        parentIntent: parent,
        intent,
        onParentIntent: (next) => {
          input.onCancelPreview();
          setIntent(null);
          setParent(next);
        },
        onEditIntent: (next) => {
          input.onCancelPreview();
          setParent(null);
          setIntent(next);
        },
        onCloseSelection: () => {
          input.onCancelPreview();
          setParent(null);
          setIntent(null);
          input.resolveReturnFocusTarget()?.focus({ preventScroll: true });
        },
      };
}
