// SPDX-License-Identifier: AGPL-3.0-or-later
import { Stack, MyoxusText, Button } from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type BlockReactHostProps,
} from "@virgultum/block-mermaid";
export function BlockAccessibilityForm({
  props,
  onClose,
}: {
  props: BlockReactHostProps;
  onClose: () => void;
}) {
  return (
    <Stack>
      <MyoxusText>{m.blockAccessibilityHelp()}</MyoxusText>
      <MyoxusText>
        {m.architectureAccessibilityTitle()}:{" "}
        {props.visualModel.accessibilityTitle}
      </MyoxusText>
      <MyoxusText>
        {m.architectureAccessibilityDescription()}:{" "}
        {props.visualModel.accessibilityDescription}
      </MyoxusText>
      <Button onClick={onClose}>{m.cancel()}</Button>
    </Stack>
  );
}
