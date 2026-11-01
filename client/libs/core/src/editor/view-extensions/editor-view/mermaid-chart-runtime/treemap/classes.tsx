// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ArrowDownSmallIcon,
  ArrowUpSmallIcon,
  CommentIcon,
  DeleteIcon,
} from "@myoxus/icons";
import {
  Alert,
  Button,
  ColorInput,
  Group,
  IconButton,
  MyoxusNumberInput,
  MyoxusText,
  MyoxusTextInput,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidTreemapReactHostProps,
  type TreemapClassDef,
  type TreemapCommand,
} from "@virgultum/block-mermaid";
import { useState } from "react";

const COLOR_PROPERTIES = new Set(["color", "fill", "stroke"]);
const DIMENSION_PROPERTIES = new Set([
  "border-width",
  "font-size",
  "stroke-width",
]);

function nativeDeclarationValue(
  property: string,
  value: string,
  emptyDimensionUnit = "px",
) {
  const normalizedProperty = property.trim().toLowerCase();
  if (
    COLOR_PROPERTIES.has(normalizedProperty) &&
    (!value.trim() || /^#[\da-f]{3,8}$/i.test(value.trim()))
  )
    return { kind: "color" as const };
  if (DIMENSION_PROPERTIES.has(normalizedProperty)) {
    const dimension = /^(-?(?:\d+(?:\.\d*)?|\.\d+))(.*)$/.exec(value.trim());
    if (!value.trim() || dimension)
      return {
        kind: "dimension" as const,
        number: dimension ? Number(dimension[1]) : "",
        unit: dimension?.[2] ?? emptyDimensionUnit,
      };
  }
  return { kind: "text" as const };
}

function DeclarationRow({
  definition,
  index,
  onApply,
  readonly,
}: {
  readonly definition: TreemapClassDef;
  readonly index: number;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly readonly: boolean;
}) {
  const declaration = definition.declarations[index];
  const [property, setProperty] = useState(declaration.property);
  const [value, setValue] = useState(declaration.value);
  const originalDimensionUnit =
    /^-?(?:\d+(?:\.\d*)?|\.\d+)(.*)$/.exec(declaration.value.trim())?.[1] ??
    "px";
  const nativeValue = nativeDeclarationValue(
    property,
    value,
    originalDimensionUnit,
  );
  const changed =
    property !== declaration.property || value !== declaration.value;
  return (
    <Group align="flex-end" wrap="nowrap">
      <MyoxusTextInput
        disabled={readonly}
        label={messages.property()}
        value={property}
        onChange={setProperty}
      />
      {nativeValue.kind === "color" ? (
        <ColorInput
          allowEmpty
          disabled={readonly}
          label={messages.value()}
          value={value}
          onChange={setValue}
        />
      ) : nativeValue.kind === "dimension" ? (
        <MyoxusNumberInput
          disabled={readonly}
          label={messages.value()}
          min={0}
          suffix={nativeValue.unit}
          value={nativeValue.number}
          onChange={(next) =>
            setValue(next === "" ? "" : `${next}${nativeValue.unit}`)
          }
        />
      ) : (
        <MyoxusTextInput
          disabled={readonly}
          label={messages.value()}
          value={value}
          onChange={setValue}
        />
      )}
      <Button
        disabled={readonly || !changed || !property.trim()}
        onClick={() =>
          onApply({
            type: "class.declaration.update",
            id: definition.id,
            index,
            property,
            value,
          })
        }
      >
        {messages.architectureApply()}
      </Button>
      <IconButton
        aria-label={messages.treemapMoveUp()}
        disabled={readonly || index === 0}
        icon={<ArrowUpSmallIcon />}
        tooltip={messages.treemapMoveUp()}
        onClick={() =>
          onApply({
            type: "class.declaration.reorder",
            id: definition.id,
            index,
            nextIndex: index - 1,
          })
        }
      />
      <IconButton
        aria-label={messages.treemapMoveDown()}
        disabled={readonly || index === definition.declarations.length - 1}
        icon={<ArrowDownSmallIcon />}
        tooltip={messages.treemapMoveDown()}
        onClick={() =>
          onApply({
            type: "class.declaration.reorder",
            id: definition.id,
            index,
            nextIndex: index + 1,
          })
        }
      />
      <IconButton
        aria-label={messages.visualDelete()}
        disabled={readonly}
        icon={<DeleteIcon />}
        tooltip={messages.visualDelete()}
        onClick={() =>
          onApply({
            type: "class.declaration.delete",
            id: definition.id,
            index,
          })
        }
      />
    </Group>
  );
}

function ClassDefinitionEditor({
  definition,
  onApply,
  onOpenComments,
  props,
}: {
  readonly definition: TreemapClassDef;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onOpenComments: (id: string) => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const [nextName, setNextName] = useState(definition.name);
  const [property, setProperty] = useState("");
  const [value, setValue] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [replacement, setReplacement] = useState<string | null>(null);
  const nativeValue = nativeDeclarationValue(property, value);
  const instances = props.model.classDefs.filter(
    (candidate) => candidate.name === definition.name,
  );
  const assigned = props.model.nodes.filter(
    (node) => node.className === definition.name,
  );
  const comments = props.model.comments.filter(
    (comment) =>
      comment.anchor.kind === "class-def" &&
      comment.anchor.id === definition.id,
  );
  const replacementNames = [
    ...new Set(
      props.model.classDefs
        .map((candidate) => candidate.name)
        .filter((name) => name !== definition.name),
    ),
  ];
  const requiresAssignmentResolution =
    instances.length === 1 && assigned.length > 0;
  const deleteDefinition = () => {
    if (
      (instances.length > 1 || assigned.length === 0) &&
      comments.length === 0
    ) {
      onApply({ type: "class.delete", id: definition.id, confirmed: true });
      return;
    }
    setDeletePending(true);
  };
  return (
    <Stack>
      <Group align="flex-end" wrap="nowrap">
        <MyoxusTextInput
          disabled={props.readonly}
          label={messages.treemapClassName()}
          value={nextName}
          onChange={setNextName}
        />
        <Button
          disabled={
            props.readonly ||
            nextName === definition.name ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nextName)
          }
          onClick={() =>
            onApply({ type: "class.rename", name: definition.name, nextName })
          }
        >
          {messages.treemapRenameClass()}
        </Button>
        {comments.length ? (
          <IconButton
            aria-label={messages.visualComments()}
            icon={<CommentIcon />}
            tooltip={messages.visualComments()}
            onClick={() => onOpenComments(definition.id)}
          />
        ) : null}
        <IconButton
          aria-label={messages.visualDelete()}
          disabled={props.readonly}
          icon={<DeleteIcon />}
          tooltip={messages.visualDelete()}
          onClick={deleteDefinition}
        />
      </Group>
      <MyoxusText typographySlot="caption">
        {messages.treemapClassPreview()}:{" "}
        {definition.declarations
          .map((item) => `${item.property}: ${item.value}`)
          .join(", ") || messages.treemapNoClass()}
      </MyoxusText>
      {definition.declarations.map((_, index) => (
        <DeclarationRow
          definition={definition}
          index={index}
          key={`${definition.id}:${index}`}
          onApply={onApply}
          readonly={props.readonly}
        />
      ))}
      <Group align="flex-end" wrap="nowrap">
        <MyoxusTextInput
          disabled={props.readonly}
          label={messages.property()}
          value={property}
          onChange={setProperty}
        />
        {nativeValue.kind === "color" ? (
          <ColorInput
            allowEmpty
            disabled={props.readonly}
            label={messages.value()}
            value={value}
            onChange={setValue}
          />
        ) : nativeValue.kind === "dimension" ? (
          <MyoxusNumberInput
            disabled={props.readonly}
            label={messages.value()}
            min={0}
            suffix={nativeValue.unit}
            value={nativeValue.number}
            onChange={(next) =>
              setValue(next === "" ? "" : `${next}${nativeValue.unit}`)
            }
          />
        ) : (
          <MyoxusTextInput
            disabled={props.readonly}
            label={messages.value()}
            value={value}
            onChange={setValue}
          />
        )}
        <Button
          disabled={props.readonly || !property.trim()}
          onClick={() => {
            if (
              onApply({
                type: "class.declaration.add",
                id: definition.id,
                property,
                value,
              })
            ) {
              setProperty("");
              setValue("");
            }
          }}
        >
          {messages.treemapAddDeclaration()}
        </Button>
      </Group>
      {deletePending ? (
        <Alert role="status">
          <Stack>
            <MyoxusText>
              {messages.treemapDeleteImpact({
                label: definition.name,
                children: 0,
                nodes: assigned.length,
                leaves: 0,
                value: 0,
                comments: comments.length,
                classes: 1,
              })}
            </MyoxusText>
            <Group align="flex-end" wrap="nowrap">
              {requiresAssignmentResolution ? (
                <>
                  <Button
                    color="myoxusError"
                    onClick={() =>
                      onApply({
                        type: "class.delete",
                        id: definition.id,
                        assignmentStrategy: "remove",
                        confirmed: true,
                      })
                    }
                  >
                    {messages.treemapRemoveAssignments()}
                  </Button>
                  <Select
                    label={messages.treemapReassignTo()}
                    data={replacementNames.map((name) => ({
                      label: name,
                      value: name,
                    }))}
                    value={replacement}
                    onChange={setReplacement}
                  />
                  <Button
                    disabled={!replacement}
                    onClick={() =>
                      replacement &&
                      onApply({
                        type: "class.delete",
                        id: definition.id,
                        assignmentStrategy: "reassign",
                        replacement,
                        confirmed: true,
                      })
                    }
                  >
                    {messages.architectureApply()}
                  </Button>
                </>
              ) : (
                <Button
                  color="myoxusError"
                  onClick={() =>
                    onApply({
                      type: "class.delete",
                      id: definition.id,
                      confirmed: true,
                    })
                  }
                >
                  {messages.visualDelete()}
                </Button>
              )}
              <Button variant="plain" onClick={() => setDeletePending(false)}>
                {messages.cancel()}
              </Button>
            </Group>
          </Stack>
        </Alert>
      ) : null}
    </Stack>
  );
}

export function TreemapClasses({
  nodeId,
  onApply,
  onOpenComments,
  props,
}: {
  readonly nodeId?: string;
  readonly onApply: (command: TreemapCommand) => boolean;
  readonly onOpenComments: (id: string) => void;
  readonly props: MermaidTreemapReactHostProps;
}) {
  const node = props.model.nodes.find((candidate) => candidate.id === nodeId);
  const [name, setName] = useState("");
  const names = [...new Set(props.model.classDefs.map((item) => item.name))];
  const unresolved = Boolean(
    node?.className && !names.includes(node.className),
  );
  if (props.readonly) {
    return (
      <Stack>
        {node ? (
          <MyoxusText>
            {messages.treemapClass()}:{" "}
            {node.className ?? messages.treemapNoClass()}
          </MyoxusText>
        ) : null}
        {props.model.classDefs.map((definition) => {
          const comments = props.model.comments.filter(
            (comment) =>
              comment.anchor.kind === "class-def" &&
              comment.anchor.id === definition.id,
          );
          return (
            <Stack key={definition.id}>
              <MyoxusText>{definition.name}</MyoxusText>
              <MyoxusText typographySlot="caption">
                {definition.declarations
                  .map((item) => `${item.property}: ${item.value}`)
                  .join(", ") || messages.treemapNoClass()}
              </MyoxusText>
              {comments.length ? (
                <Button
                  variant="plain"
                  onClick={() => onOpenComments(definition.id)}
                >
                  {messages.visualComments()}: {comments.length}
                </Button>
              ) : null}
            </Stack>
          );
        })}
      </Stack>
    );
  }
  return (
    <Stack>
      {node ? (
        <Group align="flex-end" wrap="nowrap">
          <Select
            clearable
            disabled={props.readonly}
            label={messages.treemapClass()}
            data={(unresolved ? [node.className!, ...names] : names).map(
              (name) => ({ label: name, value: name }),
            )}
            value={node.className}
            onChange={(next) =>
              onApply({ type: "class.assign", nodeId: node.id, name: next })
            }
          />
          {unresolved ? (
            <Button
              disabled={props.readonly}
              onClick={() =>
                onApply({
                  type: "class.add",
                  name: node.className!,
                  declarations: [],
                })
              }
            >
              {messages.treemapCreateDefinition()}
            </Button>
          ) : null}
        </Group>
      ) : null}
      {props.model.classDefs.map((definition) => (
        <Stack
          key={`${definition.id}:${definition.name}:${definition.declarations.map((item) => item.raw).join(",")}`}
        >
          <MyoxusText>{messages.treemapClassDefinition()}</MyoxusText>
          <ClassDefinitionEditor
            definition={definition}
            onApply={onApply}
            onOpenComments={onOpenComments}
            props={props}
          />
        </Stack>
      ))}
      <Group align="flex-end" wrap="nowrap">
        <MyoxusTextInput
          disabled={props.readonly}
          label={messages.treemapClassName()}
          value={name}
          onChange={setName}
        />
        <Button
          disabled={
            props.readonly ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            names.includes(name)
          }
          onClick={() =>
            onApply({ type: "class.add", name, declarations: [] }) &&
            setName("")
          }
        >
          {messages.structuredAddEntry()}
        </Button>
      </Group>
    </Stack>
  );
}
