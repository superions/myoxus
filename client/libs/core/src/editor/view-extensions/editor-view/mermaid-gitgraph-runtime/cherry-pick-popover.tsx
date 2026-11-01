// SPDX-License-Identifier: AGPL-3.0-or-later
import { Checkbox, MyoxusText, Select, Stack } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  gitGraphBranchName,
  gitGraphAttributeRuntimeValue,
  gitGraphContextAtAnchor,
  type GitGraphReactHostProps,
} from "@virgultum/block-mermaid";
import {
  useGitGraphDraft,
  gitGraphDefaultAnchor,
  gitGraphDraftKey,
} from "./drafts";
import {
  GitGraphAnchorFields,
  gitGraphTagDrafts,
  GitGraphAttributeOccurrences,
  GitGraphTags,
  GitGraphDraftFooter,
} from "./commit-popover";
export function GitGraphCherryPickForm({
  props,
  sourceKey,
  onClose,
}: {
  props: GitGraphReactHostProps;
  sourceKey?: string;
  onClose: () => void;
}) {
  const record = sourceKey
      ? props.model.sourceDocument!.records.find(
          (r) => r.sourceKey === sourceKey,
        )
      : null,
    occurrences = props.model.derivedGraph?.occurrences ?? [],
    source = record
      ? occurrences.find(
          (c) =>
            c.sourceKey ===
            props.model.derivedGraph?.contexts
              .find((ctx) => ctx.sourceKey === record.sourceKey)
              ?.commitIds.get(
                gitGraphAttributeRuntimeValue(
                  record,
                  "id",
                  props.model.derivedGraph?.sanitization,
                ),
              ),
        )
      : null;
  const d = useGitGraphDraft(
      {
        source: source?.sourceKey ?? props.selected?.sourceKey ?? "",
        parent: record
          ? (occurrences.find(
              (c) =>
                c.sourceKey ===
                props.model.derivedGraph?.contexts
                  .find((ctx) => ctx.sourceKey === record.sourceKey)
                  ?.commitIds.get(
                    gitGraphAttributeRuntimeValue(
                      record,
                      "parent",
                      props.model.derivedGraph?.sanitization,
                    ),
                  ),
            )?.sourceKey ?? "")
          : "",
        makeExplicit: false,
        tags: gitGraphTagDrafts(record),
        anchor: gitGraphDefaultAnchor(props),
      },
      props,
    ),
    v = d.value,
    selected = occurrences.find((c) => c.sourceKey === v.source),
    context = gitGraphContextAtAnchor(
      props.model,
      record ? { sourceKey: record.sourceKey, position: "before" } : v.anchor,
    ),
    parents =
      selected?.parentReferences
        .map((id) =>
          occurrences.find((c) => c.sourceKey === context?.commitIds.get(id)),
        )
        .filter((c) => !!c) ?? [];
  const save = (preview = false) => {
    const parent = occurrences.find((c) => c.sourceKey === v.parent);
    const result = sourceKey
      ? d.run(preview, "editGitGraphCherryPick", [
          sourceKey,
          selected?.sourceKey ?? "",
          parent?.sourceKey ?? null,
          v.tags,
          v.makeExplicit,
        ])
      : d.run(preview, "cherryPickGitGraphOccurrence", [
          v.anchor,
          v.source,
          v.parent || null,
          v.tags.map((t) => t.value),
          v.makeExplicit,
        ]);
    if (!preview && !result.diagnostic) onClose();
  };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      {!record ? (
        <GitGraphAnchorFields
          props={props}
          value={v.anchor}
          onChange={(a) => d.set("anchor", a)}
        />
      ) : null}
      <Select
        label={m.sequenceId()}
        value={v.source}
        disabled={props.readonly}
        data={occurrences
          .filter(
            (c) =>
              c.kind !== "cherry-pick" &&
              context?.commitIds.get(c.runtimeId) === c.sourceKey,
          )
          .map((c) => ({
            value: c.sourceKey,
            label: `${c.sourceId || c.kind} · ${gitGraphBranchName(props.model, c.branchId)}`,
          }))}
        onChange={(source) => d.set("source", source ?? "")}
      />
      {selected?.kind === "merge" || v.parent ? (
        <Select
          label={m.gitGraphHead()}
          value={v.parent}
          disabled={props.readonly}
          data={parents.map((c) => ({
            value: c.sourceKey,
            label: c.sourceId || c.kind,
          }))}
          onChange={(parent) => d.set("parent", parent ?? "")}
        />
      ) : null}
      <Checkbox
        checked={v.makeExplicit}
        label={m.gitGraphExplicit()}
        disabled={props.readonly}
        onChange={(e) => d.set("makeExplicit", e.target.checked)}
      />
      <GitGraphTags
        value={v.tags}
        onChange={(tags) => d.set("tags", tags)}
        readonly={props.readonly}
      />
      <MyoxusText>{m.gitGraphAutoTag()}</MyoxusText>
      <MyoxusText>
        {m.gitGraphGenerated()} ·{" "}
        {occurrences.find((c) => c.sourceKey === sourceKey)?.message}
      </MyoxusText>
      {record ? (
        <GitGraphAttributeOccurrences
          props={props}
          record={record}
          onClose={onClose}
        />
      ) : null}
      <GitGraphDraftFooter
        props={props}
        diagnostic={d.diagnostic}
        impact={d.feedback?.impact}
        preview={() => save(true)}
        apply={() => save()}
        cancel={onClose}
      />
    </Stack>
  );
}
