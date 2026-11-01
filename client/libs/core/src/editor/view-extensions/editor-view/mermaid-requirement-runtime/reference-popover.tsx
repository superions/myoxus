// SPDX-License-Identifier: AGPL-3.0-or-later
import { useMemo, useState } from "react";
import { AlertTriangleIcon } from "@myoxus/icons/react";
import {
  IconButton,
  Popover,
  PopoverContent,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type RequirementReactHostProps,
} from "@virgultum/block-mermaid";
import { RequirementRelationForm } from "./relation-popover";

/** Reuse the ordinary checked relation draft; a warning never authors a dummy
 * card, silently chooses an ambiguous alias, or creates another Source owner. */
export function RequirementReferencePopover({
  props,
  relationKeys,
}: {
  props: RequirementReactHostProps;
  relationKeys: readonly string[];
}) {
  const [opened, setOpened] = useState(false),
    [key, setKey] = useState(relationKeys[0] ?? "");
  const relation = props.model.relations.find(
    (relation) => relation.sourceKey === key,
  );
  const edgeId = relation?.id,
    sourceNodeId = relation?.fromId ?? "",
    targetNodeId = relation?.toId ?? "";
  // Preview refreshes the host projection. Keep this draft identity stable
  // across that readback instead of disposing and recreating its preview.
  const proposal = useMemo(
    () => (edgeId ? { edgeId, sourceNodeId, targetNodeId } : null),
    [edgeId, sourceNodeId, targetNodeId],
  );
  return (
    <Popover
      fitViewport
      contentMeasure="reading"
      opened={opened}
      onChange={setOpened}
      trapFocus
    >
      <PopoverTarget>
        <IconButton
          aria-label={m.visualConnectionInvalidTarget()}
          tooltip={m.visualConnectionInvalidTarget()}
          icon={<AlertTriangleIcon />}
          onClick={() => setOpened(!opened)}
        />
      </PopoverTarget>
      <PopoverContent
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <Stack>
          {relationKeys.length > 1 ? (
            <Select
              label={m.selectedEdgeType()}
              comboboxProps={{ withinPortal: false }}
              value={key}
              onChange={setKey}
              data={props.model.relations
                .filter((relation) =>
                  relationKeys.includes(relation.sourceKey ?? ""),
                )
                .map((relation) => ({
                  value: relation.sourceKey!,
                  label: `${relation.from} · ${relation.kind} · ${relation.to}`,
                }))}
            />
          ) : null}
          {opened && proposal ? (
            <RequirementRelationForm
              key={key}
              props={props}
              proposal={proposal}
              close={() => setOpened(false)}
            />
          ) : null}
        </Stack>
      </PopoverContent>
    </Popover>
  );
}
