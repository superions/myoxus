// SPDX-License-Identifier: AGPL-3.0-or-later
import { Alert, MyoxusText, Stack, Textarea } from "@myoxus/ui-facade";
import {
  readGitGraphConfig,
  formatGitGraphConfigValue,
  readGitGraphConfigValue,
  GITGRAPH_DEFAULT_CONFIG,
  GITGRAPH_GLOBAL_OPTIONS,
  mermaidMessages as m,
  type GitGraphReactHostProps,
} from "@virgultum/block-mermaid";
import { useGitGraphDraft } from "./drafts";
import { GitGraphDraftFooter } from "./commit-popover";
import { useState } from "react";
/** Known family fields remain direct typed controls. This deliberate secondary
 * surface edits one foreign config value without rewriting its enclosing CST. */
export function GitGraphDataForm({ props }: { props: GitGraphReactHostProps }) {
  const scopes = readGitGraphConfig(props.model.sourceDocument!).scopes;
  const fields = scopes.flatMap((s) => {
    const prefix = s.record.kind === "frontmatter" ? ["config"] : [],
      config =
        s.record.kind === "frontmatter" ? s.yaml.values.config : s.yaml.values;
    if (!config || typeof config !== "object" || Array.isArray(config))
      return [];
    return Object.entries(config).flatMap(([key, value]) =>
      key === s.path.at(-1) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
        ? Object.entries(value)
            .filter(([name]) => !Object.hasOwn(GITGRAPH_DEFAULT_CONFIG, name))
            .map(([name, value]) => ({
              key: s.record.sourceKey,
              path: [...prefix, key, name],
              value,
            }))
        : key === s.path.at(-1) || Object.hasOwn(GITGRAPH_GLOBAL_OPTIONS, key)
          ? []
          : [{ key: s.record.sourceKey, path: [...prefix, key], value }],
    );
  });
  return (
    <Stack>
      <MyoxusText>{m.pieData()}</MyoxusText>
      {fields.map((f) => (
        <GitGraphGlobalValue
          key={`${f.key}:${f.path.join(".")}`}
          props={props}
          field={f}
        />
      ))}
    </Stack>
  );
}
function GitGraphGlobalValue({
  props,
  field,
}: {
  props: GitGraphReactHostProps;
  field: { key: string; path: string[]; value: unknown };
}) {
  const initial = formatGitGraphConfigValue(field.value),
    d = useGitGraphDraft({ value: initial }, props),
    [error, setError] = useState<string>();
  const save = (preview = false) => {
    const parsed = readGitGraphConfigValue(d.value.value);
    if (!parsed.valid) {
      setError(m.classPatchRejected());
      return;
    }
    const value = parsed.value;
    d.run(preview, "editGitGraphGlobalConfig", [field.key, field.path, value]);
  };
  return (
    <Stack>
      <Textarea
        label={field.path.join(".")}
        value={d.value.value}
        disabled={props.readonly}
        onChange={(v) => {
          setError(undefined);
          d.set("value", v);
        }}
      />
      {error ? <Alert>{error}</Alert> : null}
      <GitGraphDraftFooter
        props={props}
        diagnostic={d.diagnostic}
        impact={d.feedback?.impact}
        preview={() => save(true)}
        apply={() => save()}
        cancel={props.onCloseSelection}
      />
    </Stack>
  );
}
