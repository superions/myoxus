// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  MyoxusText,
  MyoxusTextInput,
  NumberInput,
  Stack,
} from "@myoxus/ui-facade";
import { useI18n } from "@myoxus/i18n";
import {
  mermaidMessages as messages,
  sourceValuesEqual,
  readKanbanConfig,
  type MermaidKanbanReactHostProps,
  type KanbanCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { MermaidDataValue } from "../mermaid-data-value";
import { kanbanTicketHref } from "./projection";
export function KanbanConfigPopover({
  props,
  kind,
  onClose,
}: {
  props: MermaidKanbanReactHostProps;
  kind: "appearance" | "tickets" | "data";
  onClose: () => void;
}) {
  const t = useI18n();
  const readonly = props.readonly || props.model.ambiguous;
  const [basis] = useState(props.model.sourceDocument.source);
  const config = readKanbanConfig(props.model.sourceDocument);
  const [initial] = useState(config.effective);
  const [draft, setDraft] = useState(config.effective);
  const [notice, setNotice] = useState(false);
  const commands: KanbanCommand[] = [
    ...new Set([...Object.keys(initial), ...Object.keys(draft)]),
  ]
    .filter((field) => !sourceValuesEqual(draft[field], initial[field]))
    .map((field) => ({ type: "config", field, value: draft[field] }));
  const tickets = String(draft.ticketBaseUrl ?? "");
  const unsafe = tickets && !kanbanTicketHref(tickets, "TICKET");
  return (
    <Stack>
      {notice ? <Alert>{messages.ganttDiagnosticConflict()}</Alert> : null}
      {kind === "appearance" ? (
        readonly ? (
          <MyoxusText>{String(draft.sectionWidth)}</MyoxusText>
        ) : (
          <NumberInput
            label={t["com.myoxus.database.view.column-width"]()}
            min={1}
            value={Number(draft.sectionWidth)}
            onChange={(value) => setDraft({ ...draft, sectionWidth: value })}
          />
        )
      ) : null}
      {kind === "tickets" ? (
        readonly ? (
          <MyoxusText>{tickets}</MyoxusText>
        ) : (
          <MyoxusTextInput
            label={messages.kanbanTicketBaseUrl()}
            value={tickets}
            onChange={(ticketBaseUrl) => setDraft({ ...draft, ticketBaseUrl })}
          />
        )
      ) : null}
      {kind === "data" ? (
        <>
          <MyoxusText>{messages.kanbanRawNoop()}</MyoxusText>
          <MermaidDataValue
            label={messages.treemapData()}
            value={draft}
            readonly={readonly}
            onChange={(value) => {
              if (value && typeof value === "object" && !Array.isArray(value))
                setDraft(value as Record<string, unknown>);
            }}
          />
          {props.model.columns.map((column) => (
            <Group key={column.id}>
              <MyoxusText>{column.label}</MyoxusText>
              <MyoxusText>
                {
                  props.model.cards.filter(
                    (card) => card.columnId === column.id,
                  ).length
                }
              </MyoxusText>
            </Group>
          ))}
        </>
      ) : null}
      {unsafe ? <Alert>{messages.kanbanUnsafeTicket()}</Alert> : null}
      <Group>
        <Button variant="plain" onClick={onClose}>
          {messages.cancel()}
        </Button>
        {!readonly ? (
          <Button
            disabled={Boolean(unsafe)}
            onClick={() => {
              const result = props.onCommand(commands, basis);
              if (result.changed || result.reason === "no-change") onClose();
              else setNotice(true);
            }}
          >
            {messages.architectureApply()}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}
