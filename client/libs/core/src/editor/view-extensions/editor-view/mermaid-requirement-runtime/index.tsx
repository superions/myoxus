// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactToLit } from "@myoxus/lit-react";
import { useI18n } from "@myoxus/i18n";
import {
  MoreHorizontalIcon,
  CopyIcon,
  PasteIcon,
  CommentIcon,
} from "@myoxus/icons/react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Group,
  Menu,
  MenuItem,
  MyoxusTextInput,
  MyoxusText,
  NumberInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
  notify,
  IconButton,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  mermaidRequirementRendererToken,
  REQUIREMENT_TYPES,
  REQUIREMENT_RELATIONS,
  requirementDeleteImpact,
  bindRequirementClipboard,
  copyRequirementCards,
  pasteRequirementCards,
  type RequirementReactHostProps,
  type RequirementLabelActionsProps,
  type MermaidGfxObjectEditIntent,
  type RequirementFieldValues,
  type RequirementTypographyValues,
  requirementRenameImpact,
  type RequirementRenameReferences,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { RequirementDeleteConfirmation } from "./delete-confirmation";
import {
  RequirementPropertyControl,
  validRequirementPropertyValue,
  type RequirementPropertyName,
} from "./property-popover";
import {
  RequirementRelationForm,
  RequirementReferenceDiagnostics,
} from "./relation-popover";
import { RequirementDiagramSettings } from "./diagram-settings";
import { RequirementCommentsPopover } from "./comment-popover";
import { RequirementDiagramTitleForm } from "./diagram-title";
import { RequirementReferencePopover } from "./reference-popover";

function RequirementObjectForm({
  props,
  close,
  intent,
}: {
  props: RequirementReactHostProps;
  close: () => void;
  intent?: MermaidGfxObjectEditIntent | null;
}) {
  const t = useI18n();
  const object = [
    ...props.model.requirements,
    ...props.model.elements,
    ...props.model.relations,
  ].find((n) => n.sourceKey === props.selectedKey);
  // A row carries its actual Source provider key. It opens the same checked
  // form narrowed to that field, never a separate editable copy of the card.
  const propertyFields = {
    id: "requirementId",
    text: "text",
    risk: "risk",
    verifymethod: "verifyMethod",
    type: "elementType",
    docref: "docRef",
  } as const;
  const addressedField =
    intent?.kind === "detail" && object && "propertyKeys" in object
      ? intent.id === object.sourceKey && "requirementType" in object
        ? "requirementType"
        : Object.entries(object.propertyKeys ?? {}).find(
            ([, keys]) => keys?.[0] === intent.id,
          )?.[0]
      : undefined;
  const field =
    addressedField === "requirementType"
      ? addressedField
      : propertyFields[addressedField as keyof typeof propertyFields];
  const initial: RequirementFieldValues = object
    ? Object.fromEntries(
        Object.entries(object).filter(
          ([fieldName]) =>
            (!field || field === fieldName) &&
            [
              "name",
              "requirementId",
              "requirementType",
              "risk",
              "text",
              "verifyMethod",
              "elementType",
              "docRef",
              "kind",
            ].includes(fieldName),
        ),
      )
    : {};
  const [values, setValues] = useState(initial),
    [diagnostic, setDiagnostic] = useState<string>();
  const [removedProperties, setRemovedProperties] = useState<
    readonly RequirementPropertyName[]
  >([]);
  const [renameReferences, setRenameReferences] =
    useState<RequirementRenameReferences>({});
  const rename =
    values.name !== undefined &&
    object &&
    "name" in object &&
    values.name !== object.name
      ? requirementRenameImpact(props.model, props.selectedKey!, values.name)
      : undefined;
  const renameReady =
    !rename ||
    (rename.valid &&
      (!rename.remaining ||
        rename.relations.every((relation) =>
          Boolean(relation.sourceKey && renameReferences[relation.sourceKey]),
        )));
  const initialTypography = props.typography;
  const [typography, setTypography] = useState(initialTypography);
  const ambiguous =
    object &&
    "name" in object &&
    [...props.model.requirements, ...props.model.elements].filter(
      (candidate) => candidate.name === object.name,
    ).length > 1;
  const basis = useRef({
    source: props.sourceBasis,
    key: props.selectedKey,
    readonly: props.readonly,
    displayOnly: props.displayOnly,
  });
  useEffect(() => {
    const opened = basis.current;
    if (
      opened.source !== props.sourceBasis ||
      opened.key !== props.selectedKey ||
      opened.readonly !== props.readonly ||
      opened.displayOnly !== props.displayOnly
    )
      close();
  }, [
    props.sourceBasis,
    props.selectedKey,
    props.readonly,
    props.displayOnly,
    close,
  ]);
  if (!object) return null;
  const save = () => {
    if (!renameReady || !propertiesValid) return;
    const changed = Object.fromEntries(
      Object.entries(values).filter(
        ([field, value]) =>
          value !== initial[field as keyof RequirementFieldValues] &&
          !removedProperties.some(
            (property) => propertyFields[property] === field,
          ),
      ),
    );
    const result = props.onSave(
      props.selectedKey!,
      changed,
      basis.current.source,
      typography && initialTypography
        ? ({
            ...(typography.fontSize !== initialTypography.fontSize
              ? { "font-size": `${typography.fontSize}px` }
              : {}),
            ...(typography.fontWeight !== initialTypography.fontWeight
              ? { "font-weight": typography.fontWeight }
              : {}),
            ...(typography.fontStyle !== initialTypography.fontStyle
              ? { "font-style": typography.fontStyle }
              : {}),
          } satisfies RequirementTypographyValues)
        : undefined,
      renameReferences,
      removedProperties,
    );
    if (result.diagnostic) setDiagnostic(result.diagnostic);
    else close();
  };
  const labels: Record<string, string> = {
    name: m.erAlias(),
    requirementId: m.selectedRequirementId(),
    requirementType: m.selectedRequirementType(),
    risk: m.selectedRequirementRisk(),
    text: m.selectedRequirementText(),
    verifyMethod: m.selectedRequirementVerifyMethod(),
    elementType: m.selectedRequirementElementType(),
    docRef: m.selectedRequirementDocRef(),
    kind: m.selectedEdgeType(),
  };
  const enums: Record<string, readonly string[]> = {
    requirementType: REQUIREMENT_TYPES,
    kind: REQUIREMENT_RELATIONS,
  };
  const disabled = props.readonly || props.displayOnly;
  const propertiesValid = Object.entries(propertyFields).every(
    ([property, fieldName]) => {
      const value = values[fieldName];
      return (
        value === undefined ||
        removedProperties.includes(property as RequirementPropertyName) ||
        (value === "" &&
          "propertyKeys" in object &&
          !object.propertyKeys?.[property as RequirementPropertyName]
            ?.length) ||
        validRequirementPropertyValue(
          property as RequirementPropertyName,
          value,
        )
      );
    },
  );
  return (
    <Stack
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (
          event.key === "Enter" &&
          !(event.target instanceof HTMLTextAreaElement) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      {diagnostic ? <Alert>{diagnostic}</Alert> : null}
      {Object.entries(values).map(([field, value], index) => {
        const property = Object.entries(propertyFields).find(
          ([, fieldName]) => fieldName === field,
        )?.[0] as RequirementPropertyName | undefined;
        return property ? (
          <RequirementPropertyControl
            key={field}
            property={property}
            label={labels[field]}
            value={value}
            providers={
              "propertyKeys" in object
                ? (object.propertyKeys?.[property] ?? [])
                : []
            }
            model={props.model}
            removed={removedProperties.includes(property)}
            disabled={disabled}
            onChange={(value) =>
              setValues((current) => ({ ...current, [field]: value }))
            }
            onRemove={(removed) =>
              setRemovedProperties((current) =>
                removed
                  ? [...current, property]
                  : current.filter((candidate) => candidate !== property),
              )
            }
            autoFocus={index === 0}
          />
        ) : enums[field] ? (
          <Select
            key={field}
            label={labels[field]}
            comboboxProps={{ withinPortal: false }}
            value={value}
            disabled={disabled}
            data={
              value === ""
                ? [
                    {
                      value: "",
                      label: t["com.myoxus.document-metadata.value.not-set"](),
                    },
                    ...enums[field].map((value) => ({ value, label: value })),
                  ]
                : enums[field].map((value) => ({ value, label: value }))
            }
            onChange={(value) => setValues((v) => ({ ...v, [field]: value }))}
          />
        ) : (
          <MyoxusTextInput
            key={field}
            autoFocus={index === 0}
            label={labels[field]}
            value={value}
            disabled={disabled}
            onChange={(value) => setValues((v) => ({ ...v, [field]: value }))}
          />
        );
      })}
      {rename ? (
        <>
          {!rename.valid ? (
            <Alert>
              {values.name}: {m.requirementAliasUnavailable()}
            </Alert>
          ) : null}
          {rename.remaining ? (
            <Alert>
              {t["com.myoxus.editor.mermaid.requirement-rename-resolution"]({
                remaining: `${rename.remaining.name} (${"requirementType" in rename.remaining ? rename.remaining.requirementType : "element"})`,
                renamed: values.name!,
              })}
            </Alert>
          ) : null}
          <MyoxusText>{m.selectionDeleteImpact()}</MyoxusText>
          {rename.records.map((record) => {
            const relation =
              rename.remaining &&
              rename.relations.find(
                (relation) => relation.sourceKey === record.sourceKey,
              );
            return relation ? (
              <Select
                key={record.sourceKey}
                label={`${record.range.line}: ${record.raw}`}
                comboboxProps={{ withinPortal: false }}
                value={renameReferences[record.sourceKey] ?? ""}
                data={[
                  {
                    value: "keep",
                    label:
                      t[
                        "com.myoxus.editor.mermaid.requirement-delete-keep-relations"
                      ](),
                  },
                  {
                    value: "reassign",
                    label: `${values.name} (${"requirementType" in object ? object.requirementType : "element"})`,
                  },
                ]}
                onChange={(value) => {
                  if (value === "keep" || value === "reassign")
                    setRenameReferences((current) => ({
                      ...current,
                      [record.sourceKey]: value,
                    }));
                }}
              />
            ) : (
              <MyoxusText key={record.sourceKey}>
                {record.range.line}: {record.raw}
              </MyoxusText>
            );
          })}
        </>
      ) : null}
      {!field && typography ? (
        <Group>
          <NumberInput
            label={m.architectureFontSize()}
            min={1}
            disabled={disabled || ambiguous}
            value={typography.fontSize}
            onChange={(value) => {
              if (
                typeof value === "number" &&
                Number.isFinite(value) &&
                value > 0
              )
                setTypography({ ...typography, fontSize: value });
            }}
          />
          <Checkbox
            label={t.Bold()}
            checked={
              typography.fontWeight === "bold" ||
              Number(typography.fontWeight) >= 600
            }
            disabled={disabled || ambiguous}
            onChange={(event) =>
              setTypography({
                ...typography,
                fontWeight: event.currentTarget.checked ? "700" : "400",
              })
            }
          />
          <Checkbox
            label={t["com.myoxus.editor.keyboard.italic"]()}
            checked={typography.fontStyle === "italic"}
            disabled={disabled || ambiguous}
            onChange={(event) =>
              setTypography({
                ...typography,
                fontStyle: event.currentTarget.checked ? "italic" : "normal",
              })
            }
          />
        </Group>
      ) : null}
      {ambiguous && !field ? (
        <Alert>
          {object.name}: {m.requirementAliasUnavailable()}
        </Alert>
      ) : null}
      {object && "name" in object ? (
        <RequirementReferenceDiagnostics
          props={props}
          relationKeys={props.model.relations
            .filter(
              (relation) =>
                relation.from === object.name || relation.to === object.name,
            )
            .flatMap((relation) => relation.sourceKey ?? [])}
        />
      ) : null}
      <Group>
        <Button
          disabled={disabled || !renameReady || !propertiesValid}
          onClick={save}
        >
          {t.Save()}
        </Button>
        <Button onClick={close}>{m.cancel()}</Button>
      </Group>
    </Stack>
  );
}

function RequirementEditor({ props }: { props: RequirementReactHostProps }) {
  const [commentsVisible, setCommentsVisible] = useState(false);
  const t = useI18n(),
    liveProps = useRef(props);
  liveProps.current = props;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => bindRequirementClipboard(() => liveProps.current),
    [props.clipboard],
  );
  const copy = async () => {
    try {
      const write = copyRequirementCards(liveProps.current);
      if (write) {
        await write;
        notify.success(t["Copied to clipboard"]());
      }
    } catch {
      notify.error(t["com.myoxus.editor.clipboard.copy-failed"]());
    }
  };
  const paste = async () => {
    const basis = liveProps.current;
    try {
      const data = await basis.clipboard?.readCurrent?.();
      // Clipboard permission prompts can outlive a selection or owner change.
      if (
        !mounted.current ||
        !data ||
        liveProps.current.ownerIdentity !== basis.ownerIdentity ||
        liveProps.current.sourceBasis !== basis.sourceBasis ||
        liveProps.current.selectionKey !== basis.selectionKey
      )
        return;
      if (!pasteRequirementCards(liveProps.current, data))
        notify.error(t["com.myoxus.editor.clipboard.paste-unavailable"]());
    } catch {
      notify.error(t["com.myoxus.editor.clipboard.paste-unavailable"]());
    }
  };
  useEffect(() => {
    if (props.intent?.action === "duplicate") {
      props.onDuplicate(props.selectedKeys, props.sourceBasis);
      props.onClose();
    }
  }, [props.intent]);
  const [nativeIntent, setNativeIntent] =
    useState<MermaidGfxObjectEditIntent | null>(null);
  const fieldIntent =
    props.surface === "controls" ? nativeIntent : props.intent;
  const [connection, setConnection] = useState<
    MermaidGfxObjectEditIntent["connection"] | null
  >(null);
  // Preview temporarily hides the selected native wrappers. Keep the opening
  // anchor so that this renderer refresh cannot unmount and reset the form.
  const connectionAnchor = useRef(props.selectedAnchor);
  if (!connection && props.selectedAnchor)
    connectionAnchor.current = props.selectedAnchor;
  const closeConnection = (restoreSelection = true) => {
    setConnection(null);
    props.onClose(restoreSelection ? connection?.edgeId : undefined);
  };
  useEffect(() => {
    if (props.connectionProposal) {
      setOpen(false);
      setConnection(props.connectionProposal);
    }
  }, [props.connectionProposal]);
  const openConnection = () => {
    const nodes = [...props.model.requirements, ...props.model.elements].filter(
      (object) => props.selectedKeys.includes(object.sourceKey ?? ""),
    );
    setOpen(false);
    setConnection({
      sourceNodeId: nodes[0]?.id ?? "",
      targetNodeId: nodes[1]?.id ?? "",
    });
  };
  const [localOpen, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false),
    [deleteDiagnostic, setDeleteDiagnostic] = useState<string>();
  const editingKey = useRef<string | undefined>(undefined);
  const opened = Boolean(props.selectedKey && (localOpen || props.intent));
  const editedRelation = props.model.relations.find(
    (relation) => relation.sourceKey === props.selectedKey,
  );
  const openExistingRelation = () => {
    if (!editedRelation) return false;
    setOpen(false);
    setConnection({
      edgeId: editedRelation.id,
      sourceNodeId: editedRelation.fromId ?? "",
      targetNodeId: editedRelation.toId ?? "",
    });
    return true;
  };
  // A relation preview hides its original GFX wrappers. Like creation, the
  // connection draft must outlive that temporary loss of the live selection.
  useEffect(() => {
    const intent = props.intent;
    if (
      intent?.kind !== "edge" ||
      intent.action === "select" ||
      intent.action === "delete"
    )
      return;
    const relation = props.model.relations.find(
      (relation) => relation.id === intent.id,
    );
    if (relation) {
      setOpen(false);
      setConnection({
        edgeId: relation.id,
        sourceNodeId: relation.fromId ?? "",
        targetNodeId: relation.toId ?? "",
      });
    }
  }, [props.intent]);
  const close = () => {
    setOpen(false);
    setNativeIntent(null);
    props.onClose();
  };
  const closeDelete = () => {
    setDeleting(false);
    props.onClose();
  };
  const requestDelete = () => {
    if (props.readonly || props.displayOnly || !props.selectedKeys.length)
      return;
    setOpen(false);
    setDeleteDiagnostic(undefined);
    if (
      requirementDeleteImpact(props.model, props.selectedKeys)
        .requiresConfirmation
    ) {
      setDeleting(true);
      return;
    }
    const result = props.onDelete(
      props.selectedKeys,
      props.sourceBasis,
      "keep",
      false,
    );
    if (result.diagnostic) setDeleteDiagnostic(result.diagnostic);
    else closeDelete();
  };
  const callbacks = useRef({ requestDelete, close });
  callbacks.current = { requestDelete, close };
  const deleteRequestSeen = useRef(false);
  useEffect(() => {
    if (!props.deleteRequested) {
      deleteRequestSeen.current = false;
      return;
    }
    if (!deleteRequestSeen.current) {
      deleteRequestSeen.current = true;
      callbacks.current.requestDelete();
    }
  }, [props.deleteRequested]);
  useEffect(
    () =>
      props.subscribeEditIntent?.((intent) => {
        if (intent.action === "duplicate") {
          const current = liveProps.current;
          current.onDuplicate(current.selectedKeys, current.sourceBasis);
          return;
        }
        if (intent.connection) {
          setOpen(false);
          setConnection(intent.connection);
          return;
        }
        if (intent.action === "delete") {
          callbacks.current.requestDelete();
          return;
        }
        if (intent.kind === "edge" && intent.action !== "select") {
          const relation = props.model.relations.find(
            (relation) => relation.id === intent.id,
          );
          if (relation) {
            setOpen(false);
            setConnection({
              edgeId: relation.id,
              sourceNodeId: relation.fromId ?? "",
              targetNodeId: relation.toId ?? "",
            });
            return;
          }
        }
        const key =
          [
            ...props.model.requirements,
            ...props.model.elements,
            ...props.model.relations,
          ].find((n) => n.id === (intent.ownerId ?? intent.id))?.sourceKey ??
          (props.titleSelected ? props.selectedKey : undefined);
        editingKey.current = key;
        setNativeIntent(intent);
        setOpen(intent.action !== "select");
      }),
    [props.subscribeEditIntent, props.model],
  );
  useEffect(() => {
    if (props.surface !== "controls") return;
    const handler = (event: KeyboardEvent) => {
      if (
        props.readonly ||
        (!props.selectedKeys.length && !props.titleSelected) ||
        (props.titleSelected && event.key !== "Enter") ||
        !["Delete", "Backspace", "Enter"].includes(event.key) ||
        (event.target instanceof Element &&
          event.target.closest(
            "input,textarea,select,button,[role=combobox],[role=dialog],[contenteditable]",
          ))
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Enter") {
        if (openExistingRelation()) return;
        editingKey.current = props.selectedKey;
        setOpen(true);
      } else callbacks.current.requestDelete();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [
    props.surface,
    props.readonly,
    props.selectedKeys,
    props.selectedKey,
    props.model,
  ]);
  useEffect(() => {
    if (editingKey.current !== props.selectedKey) setOpen(false);
    setDeleting(false);
  }, [props.selectionKey, props.selectedKey]);
  const confirmation = deleting ? (
    <RequirementDeleteConfirmation props={props} close={closeDelete} />
  ) : null;
  const editButton = (
    <Button
      disabled={!props.selectedKey}
      onClick={() => {
        if (openExistingRelation()) return;
        setOpen(true);
        setNativeIntent(null);
        props.onOpen();
      }}
    >
      {m.displayEdit()}
    </Button>
  );
  const form =
    opened && props.titleSelected ? (
      <RequirementDiagramTitleForm props={props} close={close} />
    ) : opened && !editedRelation ? (
      <RequirementObjectForm
        key={`${props.selectionKey}:${fieldIntent?.kind === "detail" ? fieldIntent.id : "object"}`}
        props={props}
        intent={fieldIntent}
        close={close}
      />
    ) : null;
  const localPopover =
    props.surface === "editor" && form && props.selectedAnchor ? (
      <Popover
        fitViewport
        contentMeasure="reading"
        opened
        trapFocus
        returnFocus={false}
        onChange={(value) => {
          if (!value) close();
        }}
        position="bottom"
      >
        <PopoverTarget>
          {/* GFX anchor only; Mantine owns fitting, density and form dimensions. */}
          <Box
            pos="absolute"
            style={{
              left: props.selectedAnchor.left,
              top: props.selectedAnchor.top,
            }}
          />
        </PopoverTarget>
        <PopoverContent onPointerDown={(event) => event.stopPropagation()}>
          <Scrollable.Viewport autosize maxHeight="floating">
            {form}
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
    ) : null;
  const connectionPopover =
    connection && connectionAnchor.current ? (
      <Popover
        opened
        fitViewport
        trapFocus
        returnFocus={false}
        position="bottom"
        onChange={(open) => {
          if (!open) closeConnection(false);
        }}
      >
        <PopoverTarget>
          {/* Use the same existing renderer anchor as the object-field controls. */}
          <Box
            pos="absolute"
            style={{
              left: connectionAnchor.current.left,
              top: connectionAnchor.current.top,
            }}
          />
        </PopoverTarget>
        <PopoverContent onPointerDown={(event) => event.stopPropagation()}>
          <RequirementRelationForm
            props={props}
            proposal={connection}
            close={closeConnection}
          />
        </PopoverContent>
      </Popover>
    ) : null;
  const controls = !props.displayOnly ? (
    <Group>
      {!props.model.requirements.length && !props.model.elements.length ? (
        <MyoxusText>{m.emptyBlank()}</MyoxusText>
      ) : null}
      <RequirementDiagramSettings props={props} />
      <IconButton
        icon={<CommentIcon />}
        aria-label={m.visualComments()}
        tooltip={m.visualComments()}
        onClick={() => setCommentsVisible(!commentsVisible)}
        aria-pressed={commentsVisible}
      />
      {commentsVisible ? (
        <RequirementCommentsPopover
          props={props}
          anchor={{ key: props.selectedKey, position: "after" }}
        />
      ) : null}
      <Menu
        title={m.visualMoreActions()}
        items={
          <>
            <MenuItem
              prefixIcon={<CopyIcon />}
              disabled={
                props.readonly ||
                !props.selectedKeys.length ||
                props.selectedKeys.some((key) =>
                  props.model.relations.some(
                    (relation) => relation.sourceKey === key,
                  ),
                )
              }
              onSelect={() =>
                props.onDuplicate(props.selectedKeys, props.sourceBasis)
              }
            >
              {t["com.myoxus.editor.keyboard.duplicate"]()}
            </MenuItem>
            <MenuItem
              prefixIcon={<CopyIcon />}
              disabled={
                !props.clipboard ||
                !props.selectedKeys.length ||
                props.selectedKeys.some((key) =>
                  props.model.relations.some(
                    (relation) => relation.sourceKey === key,
                  ),
                )
              }
              onSelect={() => void copy()}
            >
              {t.Copy()}
            </MenuItem>
            <MenuItem
              prefixIcon={<PasteIcon />}
              disabled={props.readonly || !props.clipboard?.readCurrent}
              onSelect={() => void paste()}
            >
              {t["com.myoxus.context-menu.paste"]()}
            </MenuItem>
          </>
        }
      >
        <IconButton
          aria-label={m.visualMoreActions()}
          tooltip={m.visualMoreActions()}
          icon={<MoreHorizontalIcon />}
          disabled={props.displayOnly || !props.selectedKeys.length}
        />
      </Menu>
      {deleteDiagnostic ? <Alert>{deleteDiagnostic}</Alert> : null}
      <Menu
        title={m.visualAddNode()}
        items={
          <>
            {REQUIREMENT_TYPES.map((kind) => (
              <MenuItem
                key={kind}
                disabled={props.readonly}
                onSelect={() => props.onAdd(kind)}
              >
                {kind}
              </MenuItem>
            ))}
          </>
        }
      >
        <Button disabled={props.readonly}>{m.visualAddNode()}</Button>
      </Menu>
      <Button disabled={props.readonly} onClick={() => props.onAdd("element")}>
        {m.visualAddElement()}
      </Button>
      {props.embedded || props.surface === "controls" ? (
        <Button
          disabled={props.readonly || !props.selectedKeys.length}
          onClick={requestDelete}
        >
          {m.visualDelete()}
        </Button>
      ) : null}
      {props.surface === "editor" ? (
        <Button
          disabled={props.readonly || !props.canConnect}
          onClick={openConnection}
        >
          {props.connecting ? m.visualConnecting() : m.visualConnect()}
        </Button>
      ) : (
        <Popover
          opened={Boolean(connection)}
          fitViewport
          trapFocus
          returnFocus={false}
          position="bottom-start"
          onChange={(open) => {
            if (!open) closeConnection(false);
          }}
        >
          <PopoverTarget>
            <Button
              disabled={props.readonly || !props.canConnect}
              onClick={openConnection}
            >
              {m.visualConnect()}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            {connection ? (
              <RequirementRelationForm
                props={props}
                proposal={connection}
                close={closeConnection}
              />
            ) : null}
          </PopoverContent>
        </Popover>
      )}
      {props.surface === "editor" ? (
        editButton
      ) : (
        <Popover
          fitViewport
          contentMeasure="reading"
          opened={opened}
          onChange={(value) => {
            if (!value) close();
            else setOpen(true);
          }}
          position="bottom-start"
        >
          <PopoverTarget>{editButton}</PopoverTarget>
          <PopoverContent>
            <Scrollable.Viewport autosize maxHeight="floating">
              {form}
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
      )}
    </Group>
  ) : null;
  const referenceMarkers = props.referenceMarkers.map((marker) => (
    <Box
      key={marker.key}
      data-myoxus-ui-role="mermaid-requirement-reference-marker"
      pos={props.markersInClientSpace ? "fixed" : "absolute"}
      style={{
        left: marker.left,
        top: marker.top,
        transform: "translate(-50%, -50%)",
        zIndex: "var(--myoxus-z-index-popover)",
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <RequirementReferencePopover
        props={props}
        relationKeys={marker.relationKeys}
      />
    </Box>
  ));
  const markers = commentsVisible
    ? props.commentMarkers.map((marker) => (
        <Box
          key={marker.key}
          data-myoxus-ui-role="mermaid-requirement-comment-marker"
          pos={props.markersInClientSpace ? "fixed" : "absolute"}
          style={{
            left: marker.left,
            top: marker.top,
            zIndex: "var(--myoxus-z-index-popover)",
            transform: "translate(-50%, -50%)",
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <RequirementCommentsPopover
            props={props}
            anchor={marker.anchor}
            count={marker.count}
            commentKeys={marker.commentKeys}
          />
        </Box>
      ))
    : null;
  if (props.surface === "controls")
    return (
      <>
        {controls}
        {confirmation}
        {markers && typeof document !== "undefined"
          ? createPortal(markers, document.body)
          : null}
        {typeof document !== "undefined"
          ? createPortal(referenceMarkers, document.body)
          : null}
      </>
    );
  return (
    <MermaidGfxEditorWorkbench
      toolbar={props.embedded ? null : controls}
      actionTarget={props.embedded ? null : props.actionTarget}
      onWorkareaResize={props.onWorkareaResize}
      onEmbeddedActionsInsetChange={props.onEmbeddedActionsInsetChange}
      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      selectionKey={props.selectionKey}
      selectionControls={
        <>
          {localPopover}
          {props.surface === "editor" ? connectionPopover : null}
          {confirmation}
          {markers}
          {referenceMarkers}
        </>
      }
      pageViewport={props.embedded ? undefined : props.pageViewport}
      workarea={props.workarea}
      workareaFooter={props.workareaFooter}
      embeddedActions={
        props.embedded ? (
          <MermaidEmbeddedActions
            actions={controls}
            label={m.controlsLabel()}
            placement="inline"
          />
        ) : null
      }
    />
  );
}
export function createMermaidRequirementRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<
  RequirementReactHostProps | RequirementLabelActionsProps
> {
  const nativeView = (
    props: RequirementReactHostProps | RequirementLabelActionsProps,
  ) =>
    props.surface === "label-actions" ? (
      <RequirementLabelActions props={props} />
    ) : (
      <RequirementEditor props={props} />
    );
  return {
    token: mermaidRequirementRendererToken,
    nativeView,
    render: (props) => reactToLit(nativeView(props), true),
  };
}

function RequirementLabelActions({
  props,
}: {
  props: RequirementLabelActionsProps;
}) {
  const t = useI18n();
  return (
    <Popover opened fitViewport closeOnEscape={false} returnFocus={false}>
      <PopoverTarget>
        {/* The neutral text draft reports its actual renderer-space anchor. */}
        <Box
          pos="absolute"
          style={{ ...props.bounds, pointerEvents: "none" }}
        />
      </PopoverTarget>
      <PopoverContent
        aria-label={m.selectedNodeLabel()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <Group>
          <Button onClick={props.apply}>{t.Apply()}</Button>
          <Button onClick={props.cancel}>{m.cancel()}</Button>
        </Group>
      </PopoverContent>
    </Popover>
  );
}
