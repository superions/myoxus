// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { createOperationUuid } from "@myoxus/core/utils/uuid";
import {
  documentFieldCatalogQuery,
  type DocumentFieldCatalogQuery,
} from "@myoxus/graphql";
import { useFramework } from "@myoxus/infra";
import {
  templateInputKind,
  templateInputLabel,
  templateInputVariants,
} from "../../../modules/template-doc/services/template-inputs";
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
import {
  DocumentFieldSchema,
  type DocumentField,
} from "@virgultum/shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { templateVariableCapabilities } from "../../../modules/doc/services/template-variables";
import { CMDK } from "../../../modules/quicksearch/views/cmdk";
import {
  GraphQLService,
  WorkspaceServerService,
} from "../../../modules/server";
import { documentFieldLabels } from "./document-field-labels";
import {
  DocumentFieldDefinition,
  type DocumentInputKind,
} from "./document-field-definition";

type FieldCatalog = DocumentFieldCatalogQuery["documentFieldCatalog"];

/** Web and Electron share the existing searchable, keyboard-operated Facade list. */
export function TemplateVariablePicker({
  request,
  onClosed,
  catalog,
  catalogLoading,
  catalogError,
}: {
  request: MyoxusTemplateVariableRequest;
  onClosed: () => void;
  catalog?: FieldCatalog;
  catalogLoading?: boolean;
  catalogError?: boolean;
}) {
  const t = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [inputKind, setInputKind] = useState<DocumentInputKind | null>(null);
  const selected = useRef<{ token: string } | { field: DocumentField } | null>(
    null,
  );
  const source = request.templateSource !== false;
  const label = inputKind
    ? t["com.myoxus.editor.field.definition"]()
    : source && request.insertField
      ? t["com.myoxus.editor.field.insert-mixed"]()
      : !source && request.insertField
        ? t["com.myoxus.editor.field.document-fields"]()
        : resolveEditorMessage(templateVariableLabel, request.i18n);
  const customInputs = source ? templateInputVariants(query.trim()) : [];
  const inputKindLabels = {
    text: t.Text(),
    date: t.Date(),
    datetime: t["com.myoxus.common.date-time"](),
  };
  const groups = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (source ? templateVariableGroupOrder : [])
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
  }, [query, request.i18n, source]);
  const fields = useMemo(() => {
    if (!request.insertField || !catalog) return [];
    const labels = documentFieldLabels(t);
    const formats = {
      text: t.Text(),
      name: t["com.myoxus.common.name"](),
      email: t["com.myoxus.settings.email"](),
      date: t.Date(),
      time: t.Time(),
      datetime: t["com.myoxus.common.date-time"](),
    };
    return catalog.metadata.flatMap(({ key, formats: supported }) =>
      supported.flatMap((format) => {
        const parsed = DocumentFieldSchema.safeParse({
          type: "metadata",
          id: "catalog",
          key,
          format,
        });
        if (!parsed.success || parsed.data.type !== "metadata") return [];
        const field = parsed.data;
        const title = labels[field.key];
        const subtitle = formats[field.format];
        if (
          !`${title} ${subtitle} ${t["com.myoxus.editor.field.document-fields"]()}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
        )
          return [];
        return [
          {
            field,
            item: {
              id: `field:${key}:${format}`,
              source: "template-variable",
              label: { title, subTitle: subtitle },
            },
          },
        ];
      }),
    );
  }, [catalog, query, request.insertField, t]);
  const inputFields = useMemo(() => {
    if (!source || !request.insertField || !catalog) return [];
    const definitions: Record<
      DocumentInputKind,
      { label: string; multiple: boolean; hasOptions: boolean }
    > = {
      text: { label: t.Text(), multiple: false, hasOptions: false },
      date: { label: t.Date(), multiple: false, hasOptions: false },
      datetime: {
        label: t["com.myoxus.common.date-time"](),
        multiple: false,
        hasOptions: false,
      },
      "single-select": {
        label: t["com.myoxus.editor.field.single-select"](),
        multiple: false,
        hasOptions: true,
      },
      "multi-select": {
        label: t["com.myoxus.editor.field.multi-select"](),
        multiple: true,
        hasOptions: true,
      },
    };
    return catalog.inputKinds.flatMap(({ kind, multiple, hasOptions }) => {
      if (!Object.hasOwn(definitions, kind)) return [];
      const typed = kind as DocumentInputKind;
      const definition = definitions[typed];
      if (
        multiple !== definition.multiple ||
        hasOptions !== definition.hasOptions ||
        !`${definition.label} ${t["com.myoxus.editor.field.input-fields"]()}`
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase())
      )
        return [];
      return [
        {
          kind: typed,
          item: {
            id: `input-field:${kind}`,
            source: "template-variable",
            label: { title: definition.label },
          },
        },
      ];
    });
  }, [catalog, query, request.insertField, source, t]);

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
        if (selected.current && request.canWrite()) {
          if ("token" in selected.current)
            request.insert(selected.current.token);
          else request.insertField?.(selected.current.field);
        }
        onClosed();
        request.onClose();
      }}
    >
      {inputKind && catalog ? (
        <DocumentFieldDefinition
          key={inputKind}
          kind={inputKind}
          maxOptions={catalog.maxOptions}
          onCancel={() => setInputKind(null)}
          onSave={(field) => {
            selected.current = { field };
            setOpen(false);
          }}
        />
      ) : (
        <CMDK
          wrapLabels
          query={query}
          onQueryChange={setQuery}
          placeholder={
            !source
              ? t["com.myoxus.editor.field.search"]()
              : request.insertField
                ? t["com.myoxus.editor.field.search-mixed"]()
                : resolveEditorMessage(
                    editorMessage(
                      "com.myoxus.template-input.search",
                      "Search variables or type input.name",
                    ),
                    request.i18n,
                  )
          }
          loading={catalogLoading}
          error={
            catalogError ? t["com.myoxus.common.operation-failed"]() : undefined
          }
          groups={[
            ...(inputFields.length
              ? [
                  {
                    group: {
                      id: "input-fields",
                      label: t["com.myoxus.editor.field.input-fields"](),
                    },
                    items: inputFields.map(({ item }) => item),
                  },
                ]
              : []),
            ...(fields.length
              ? [
                  {
                    group: {
                      id: "document-fields",
                      label: t["com.myoxus.editor.field.document-fields"](),
                    },
                    items: fields.map(({ item }) => item),
                  },
                ]
              : []),
            ...(customInputs.length
              ? [
                  ...groups,
                  {
                    group: {
                      id: "custom-input",
                      label: t["com.myoxus.template-input.custom-name"](),
                    },
                    items: customInputs.map((name) => ({
                      id: name,
                      source: "template-variable",
                      label: {
                        title: `${templateInputLabel(name)} · ${inputKindLabels[templateInputKind(name)!]}`,
                        subTitle: `{{${name}}}`,
                      },
                    })),
                  },
                ]
              : groups),
          ]}
          onSubmit={(item) => {
            const input = inputFields.find(
              ({ item: choice }) => choice.id === item.id,
            );
            if (input) {
              setInputKind(input.kind);
              return;
            }
            const field = fields.find(
              ({ item: choice }) => choice.id === item.id,
            )?.field;
            if (field) {
              selected.current = {
                field: DocumentFieldSchema.parse({
                  ...field,
                  id: createOperationUuid(),
                }),
              };
            } else if (
              source &&
              !item.id.startsWith("field:") &&
              !item.id.startsWith("input-field:")
            ) {
              selected.current = { token: `{{${item.id}}}` };
            } else return;
            setOpen(false);
          }}
        />
      )}
    </Modal>
  );
}

export function useTemplateVariablePicker() {
  const framework = useFramework();
  const [request, setRequest] = useState<MyoxusTemplateVariableRequest | null>(
    null,
  );
  const [catalog, setCatalog] = useState<FieldCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  useEffect(() => {
    if (!request?.insertField) return;
    const controller = new AbortController();
    const graphql = framework
      .get(WorkspaceServerService)
      .server?.scope.get(GraphQLService);
    setCatalog(undefined);
    setCatalogLoading(true);
    setCatalogError(false);
    if (!graphql) {
      setCatalogLoading(false);
      setCatalogError(true);
      return () => controller.abort();
    }
    void graphql
      .gql({
        query: documentFieldCatalogQuery,
        context: {
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(30_000),
          ]),
        },
      })
      .then((result) => {
        if (!controller.signal.aborted) setCatalog(result.documentFieldCatalog);
      })
      .catch(() => {
        if (!controller.signal.aborted) setCatalogError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setCatalogLoading(false);
      });
    return () => controller.abort();
  }, [framework, request]);
  const openTemplateVariablePicker = useCallback(
    (next: MyoxusTemplateVariableRequest) => {
      if (!next.canWrite()) return;
      // Never show a previous document/server's catalog while this request loads.
      setCatalog(undefined);
      setCatalogError(false);
      setCatalogLoading(Boolean(next.insertField));
      setRequest(next);
    },
    [],
  );
  return {
    openTemplateVariablePicker,
    templateVariablePicker: request ? (
      <TemplateVariablePicker
        request={request}
        onClosed={() => setRequest(null)}
        catalog={catalog}
        catalogLoading={catalogLoading}
        catalogError={catalogError}
      />
    ) : null,
  };
}
