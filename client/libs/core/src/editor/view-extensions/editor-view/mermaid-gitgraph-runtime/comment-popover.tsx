// SPDX-License-Identifier: AGPL-3.0-or-later
import { MyoxusTextInput, Stack } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type GitGraphReactHostProps,
} from "@virgultum/block-mermaid";
import {
  useGitGraphDraft,
  gitGraphDefaultAnchor,
  gitGraphDraftKey,
} from "./drafts";
import { GitGraphAnchorFields, GitGraphDraftFooter } from "./commit-popover";
export function GitGraphCommentForm({
  props,
  sourceKey,
  onClose,
}: {
  props: GitGraphReactHostProps;
  sourceKey?: string;
  onClose: () => void;
}) {
  const r = props.model.sourceDocument!.records.find(
      (r) => r.sourceKey === sourceKey,
    ),
    d = useGitGraphDraft(
      {
        text: r?.value ?? "",
        anchor: r?.anchor
          ? {
              sourceKey: r.anchor.sourceKey,
              position:
                r.anchor.position === "before"
                  ? ("before" as const)
                  : ("after" as const),
            }
          : gitGraphDefaultAnchor(props),
      },
      props,
    ),
    v = d.value;
  const save = (preview = false) => {
    const result = d.run(preview, "editGitGraphComment", [
      sourceKey ?? null,
      v.text,
      !r ||
      v.anchor.sourceKey !== r.anchor?.sourceKey ||
      v.anchor.position !==
        (r.anchor?.position === "before" ? "before" : "after")
        ? v.anchor
        : undefined,
    ]);
    if (!preview && !result.diagnostic) onClose();
  };
  return (
    <Stack onKeyDown={(e) => gitGraphDraftKey(e, () => save(), onClose)}>
      <MyoxusTextInput
        label={m.visualComments()}
        value={v.text}
        disabled={props.readonly}
        onChange={(e) => d.set("text", e)}
      />
      {
        <GitGraphAnchorFields
          allowBeforeHeader
          props={props}
          value={v.anchor}
          onChange={(a) => d.set("anchor", a)}
        />
      }
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
