// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef } from "react";
import { Button, Textarea, Select, Stack, MyoxusText } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  gitGraphBranchName,
  gitGraphAttribute,
  nextGitGraphExplicitCommitId,
  gitGraphReferenceRuntimeValue,
  gitGraphContextAtAnchor,
  GITGRAPH_TYPES,
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
export function GitGraphMergeForm({
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
    initial = {
      branch:
        props.model.branches.find(
          (b) =>
            b.id ===
            (record
              ? gitGraphReferenceRuntimeValue(
                  record,
                  props.model.derivedGraph?.sanitization,
                )
              : props.selected?.branch),
        )?.sourceKey ?? "",
      id: record ? (gitGraphAttribute(record, "id") ?? "") : "",
      makeExplicit: false,
      type: record ? (gitGraphAttribute(record, "type") ?? "") : "",
      tags: gitGraphTagDrafts(record),
      anchor: gitGraphDefaultAnchor(props),
    },
    d = useGitGraphDraft(initial, props),
    v = d.value,
    context = gitGraphContextAtAnchor(
      props.model,
      record ? { sourceKey: record.sourceKey, position: "before" } : v.anchor,
    );
  const idInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (v.makeExplicit && !props.readonly) idInput.current?.focus();
  }, [v.makeExplicit, props.readonly]);
  const sourceBranch = props.model.branches.find(
      (b) => b.sourceKey === v.branch,
    ),
    sourceHead = sourceBranch && context?.branchHeads.get(sourceBranch.id),
    label = (key: string | null | undefined) =>
      props.model.derivedGraph?.occurrences.find((c) => c.sourceKey === key)
        ?.sourceId || (key ? m.gitGraphGenerated() : "∅");
  const save = (preview = false) => {
    const result = sourceKey
      ? d.run(preview, "editGitGraphMerge", [
          sourceKey,
          {
            ...(v.id !== initial.id ? { id: v.id } : {}),
            ...(v.type !== initial.type
              ? { type: (v.type as "NORMAL" | "HIGHLIGHT" | "REVERSE") || null }
              : {}),
            ...(JSON.stringify(v.tags) !== JSON.stringify(initial.tags)
              ? { tags: v.tags }
              : {}),
          },
          v.branch !== initial.branch ? { sourceKey: v.branch } : undefined,
        ])
      : d.run(preview, "createGitGraphMerge", [
          v.anchor,
          { sourceKey: v.branch },
          {
            id: v.id,
            type: (v.type as "NORMAL" | "HIGHLIGHT" | "REVERSE") || null,
            tags: v.tags.map((t) => t.value),
          },
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
        label={m.sequenceBranch()}
        value={v.branch}
        disabled={props.readonly}
        data={props.model.branches
          .filter(
            (b) => b.id !== context?.branch && context?.branchHeads.get(b.id),
          )
          .map((b) => ({
            value: b.sourceKey ?? "",
            label: b.name,
            disabled: b.referenceable === false,
          }))}
        onChange={(b) => d.set("branch", b ?? "")}
      />
      <MyoxusText>
        {sourceBranch?.name} · {m.gitGraphHead()}: {label(sourceHead)} →{" "}
        {gitGraphBranchName(props.model, context?.branch)} · {m.gitGraphHead()}:{" "}
        {label(context?.head)}
      </MyoxusText>
      <Textarea
        ref={idInput}
        autosize
        label={m.sequenceId()}
        value={v.id}
        disabled={
          props.readonly ||
          (!!record &&
            !v.makeExplicit &&
            !record.attributes.some((a) => a.name === "id"))
        }
        onChange={(e) => d.set("id", e)}
      />
      {record &&
      !v.makeExplicit &&
      !record.attributes.some((a) => a.name === "id") ? (
        <Button
          disabled={props.readonly}
          onClick={() => {
            d.set("id", nextGitGraphExplicitCommitId(props.model));
            d.set("makeExplicit", true);
          }}
        >
          {m.gitGraphExplicit()}
        </Button>
      ) : null}
      <Select
        label={m.erType()}
        value={v.type}
        disabled={props.readonly}
        data={[
          { value: "", label: m.gitGraphGenerated() },
          ...GITGRAPH_TYPES.map((value) => ({ value, label: value })),
        ]}
        onChange={(type) => d.set("type", type ?? "")}
      />
      <GitGraphTags
        value={v.tags}
        onChange={(tags) => d.set("tags", tags)}
        readonly={props.readonly}
      />
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
