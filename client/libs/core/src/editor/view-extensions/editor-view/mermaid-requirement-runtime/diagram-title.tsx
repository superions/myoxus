// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  Group,
  MyoxusTextInput,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  readRequirementDiagramTitle,
  type RequirementReactHostProps,
} from "@virgultum/block-mermaid";

/** Native title editing delegates to the same Source title owner as Page. */
export function RequirementDiagramTitleForm({
  props,
  close,
}: {
  props: RequirementReactHostProps;
  close: () => void;
}) {
  const t = useI18n(),
    basis = useRef(props.sourceBasis),
    [title, setTitle] = useState(readRequirementDiagramTitle(props.model)),
    [diagnostic, setDiagnostic] = useState<string>();
  useEffect(() => {
    if (
      props.readonly ||
      props.displayOnly ||
      basis.current !== props.sourceBasis
    )
      close();
  }, [props.readonly, props.displayOnly, props.sourceBasis, close]);
  const save = () => {
    const result = props.onTitle(title, basis.current);
    if (result.diagnostic) setDiagnostic(result.diagnostic);
    else close();
  };
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      <MyoxusTextInput
        autoFocus
        label={m.titlePlaceholder()}
        value={title}
        onChange={setTitle}
        disabled={props.readonly || props.displayOnly}
      />
      {diagnostic ? <Alert>{diagnostic}</Alert> : null}
      <Group>
        <Button
          disabled={props.readonly || props.displayOnly || !title.trim()}
          onClick={save}
        >
          {t.Save()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}
