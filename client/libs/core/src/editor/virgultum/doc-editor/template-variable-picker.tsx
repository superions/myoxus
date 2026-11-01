// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { isTemplateInputName } from "../../../modules/template-doc/services/template-inputs";
import { Modal } from "@myoxus/ui-facade";
import {
  templateVariableGroupMessages,
  templateVariableGroupOrder,
  templateVariableLabel,
} from "@virgultum/components/context-menu";
import {
  editorMessage,
  resolveEditorMessage,
  type MyoxusTemplateVariableRequest,
} from "@virgultum/shared/services";
import { useCallback, useMemo, useRef, useState } from "react";

import { templateVariableCapabilities } from "../../../modules/doc/services/template-variables";
import { CMDK } from "../../../modules/quicksearch/views/cmdk";

/** Web and Electron share the existing searchable, keyboard-operated Facade list. */
export function TemplateVariablePicker({
  request,
  onClosed,
}: {
  request: MyoxusTemplateVariableRequest;
  onClosed: () => void;
}) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const selectedToken = useRef<string | null>(null);
  const label = resolveEditorMessage(templateVariableLabel, request.i18n);
  const groups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return templateVariableGroupOrder
      .map((group) => ({
        group: {
          id: group,
          label: resolveEditorMessage(
            templateVariableGroupMessages[group],
            request.i18n,
          ),
        },
        items: templateVariableCapabilities
          .filter((entry) => entry.group === group)
          .map((entry) => ({
            id: entry.name,
            source: "template-variable",
            label: {
              title: `${resolveEditorMessage(entry.label, request.i18n)} · {{${entry.name}}}`,
              subTitle: `${resolveEditorMessage(entry.source, request.i18n)} · ${resolveEditorMessage(entry.availability, request.i18n)}`,
            },
          }))
          .filter((entry) =>
            `${entry.label.title} ${entry.label.subTitle}`
              .toLocaleLowerCase()
              .includes(search),
          ),
      }))
      .filter((group) => group.items.length > 0);
  }, [query, request.i18n]);

  return (
    <Modal
      open={open}
      title={label}
      onOpenChange={setOpen}
      closeButtonOptions={{
        "aria-label": resolveEditorMessage(
          editorMessage("Cancel", "Cancel"),
          request.i18n,
        ),
      }}
      contentOptions={{
        "data-testid": "template-variable-menu",
        // Editor shortcuts must not consume the key that committed a choice.
        onKeyDown: (event) => event.stopPropagation(),
      }}
      onExitTransitionEnd={() => {
        // Commit only after the dialog releases focus and its Enter event has
        // finished. Restoring an inline selection earlier lets the editor
        // consume that same key as a second edit.
        if (selectedToken.current && request.canWrite()) {
          request.insert(selectedToken.current);
        }
        onClosed();
        request.onClose();
      }}
    >
      <CMDK
        wrapLabels
        query={query}
        onQueryChange={setQuery}
        placeholder={resolveEditorMessage(
          editorMessage(
            "com.myoxus.template-input.search",
            "Search variables or type input.name",
          ),
          request.i18n,
        )}
        groups={
          isTemplateInputName(query.trim())
            ? [
                ...groups,
                {
                  group: {
                    id: "custom-input",
                    label: t["com.myoxus.template-input.custom-name"](),
                  },
                  items: [
                    {
                      id: query.trim(),
                      source: "template-variable",
                      label: {
                        title: `{{${query.trim()}}}`,
                        subTitle: t["com.myoxus.template-input.insert"](),
                      },
                    },
                  ],
                },
              ]
            : groups
        }
        onSubmit={(item) => {
          selectedToken.current = `{{${item.id}}}`;
          setOpen(false);
        }}
      />
    </Modal>
  );
}

export function useTemplateVariablePicker() {
  const [request, setRequest] = useState<MyoxusTemplateVariableRequest | null>(
    null,
  );
  const openTemplateVariablePicker = useCallback(
    (next: MyoxusTemplateVariableRequest) => {
      if (next.canWrite()) setRequest(next);
    },
    [],
  );
  return {
    openTemplateVariablePicker,
    templateVariablePicker: request ? (
      <TemplateVariablePicker
        request={request}
        onClosed={() => setRequest(null)}
      />
    ) : null,
  };
}
