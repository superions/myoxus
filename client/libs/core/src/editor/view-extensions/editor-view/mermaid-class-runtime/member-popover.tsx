// SPDX-License-Identifier: AGPL-3.0-or-later
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Badge,
  Box,
  ConfirmModal,
  MyoxusText,
  Button,
  Group,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  Scrollable,
  PopoverTarget,
  Select,
  Stack,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  type ClassReactHostProps,
  type MermaidClassMember,
} from "@virgultum/block-mermaid";
import { useState } from "react";
import { createPortal } from "react-dom";
import { changedClassFields, useClassDraft } from "./drafts";
export function ClassMemberForm({
  props,
  member,
  classKey,
  onClose,
}: {
  props: ClassReactHostProps;
  member?: MermaidClassMember;
  classKey: string;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const t = useI18n();
  const initial = {
    kind: member?.kind ?? ("attribute" as const),
    visibility: member?.visibility ?? "",
    name: member?.name ?? "",
    type: member?.type ?? "",
    parameters: member?.parameters ?? "",
    returnType: member?.returnType ?? "",
    classifier: member?.classifier ?? "",
    raw: member?.raw ?? "",
    before: "",
  };
  const d = useClassDraft(initial, props),
    v = d.value;
  const precise = !member || member.precise;
  const siblings =
      props.model.nodes
        .find((n) => n.sourceKey === classKey)
        ?.members.filter((candidate) => candidate.kind === member?.kind) ?? [],
    index = siblings.findIndex((candidate) => candidate.id === member?.id);
  const insertion =
    !member && v.before ? props.resolveMemberInsertAnchor(v.before) : null;
  return (
    <>
      {insertion
        ? createPortal(
            <Box
              pos="fixed"
              role="status"
              data-myoxus-ui-role="mermaid-member-insertion"
              style={{
                left: insertion.left,
                top: insertion.top,
                transform: "translate(-100%, -50%)",
                pointerEvents: "none",
                zIndex: "var(--myoxus-z-index-popover)",
              }}
            >
              <Badge>{m.timelineInsertPosition()}</Badge>
            </Box>,
            document.body,
          )
        : null}
      <Stack
        onKeyDown={(event) => {
          if (
            !member ||
            props.readonly ||
            !event.altKey ||
            !["ArrowUp", "ArrowDown"].includes(event.key)
          )
            return;
          const allowed =
            event.key === "ArrowUp"
              ? index > 0
              : index >= 0 && index < siblings.length - 1;
          if (!allowed) return;
          event.preventDefault();
          event.stopPropagation();
          d.commit("reorderClassMember", [
            member.id,
            event.key === "ArrowUp"
              ? siblings[index - 1]?.id
              : siblings[index + 2]?.id,
          ]);
        }}
      >
        {!member ? (
          <Select
            label={m.timelineInsertPosition()}
            value={v.before}
            data={[
              { value: "", label: t["admin.common.none"]() },
              ...(
                props.model.nodes.find((n) => n.sourceKey === classKey)
                  ?.members ?? []
              )
                .filter((m) => m.kind === v.kind)
                .map((m) => ({ value: m.id, label: m.raw })),
            ]}
            onChange={(value) => d.set("before", value)}
          />
        ) : null}
        <Select
          label={m.classMember()}
          data={[
            { value: "attribute", label: m.classAttribute() },
            { value: "operation", label: m.classOperation() },
          ]}
          value={v.kind}
          disabled={props.readonly || !precise}
          onChange={(value) => d.set("kind", value as typeof v.kind)}
        />
        {precise ? (
          <>
            <Select
              label={m.classVisibility()}
              data={["", "+", "-", "#", "~"].map((value) => ({
                value,
                label: value || m.optionDefault(),
              }))}
              value={v.visibility}
              disabled={props.readonly}
              onChange={(value) =>
                d.set("visibility", value as typeof v.visibility)
              }
            />
            <MyoxusTextInput
              autoFocus
              label={m.radarSourceName()}
              value={v.name}
              disabled={props.readonly}
              onChange={(value) => d.set("name", value)}
            />
            {v.kind === "attribute" ? (
              <MyoxusTextInput
                label={m.treemapType()}
                value={v.type}
                disabled={props.readonly}
                onChange={(value) => d.set("type", value)}
              />
            ) : (
              <>
                <MyoxusTextInput
                  label={m.classParameters()}
                  value={v.parameters}
                  disabled={props.readonly}
                  onChange={(value) => d.set("parameters", value)}
                />
                <MyoxusTextInput
                  label={m.classReturnType()}
                  value={v.returnType}
                  disabled={props.readonly}
                  onChange={(value) => d.set("returnType", value)}
                />
              </>
            )}
            <Select
              label={m.classClassifier()}
              data={[
                { value: "", label: m.optionDefault() },
                { value: "static", label: m.classStatic() },
                { value: "abstract", label: m.classAbstract() },
              ]}
              value={v.classifier}
              disabled={props.readonly}
              onChange={(value) =>
                d.set("classifier", value as typeof v.classifier)
              }
            />
          </>
        ) : (
          <MyoxusTextInput
            autoFocus
            label={m.classRawMember()}
            value={v.raw}
            disabled={props.readonly}
            onChange={(value) => d.set("raw", value)}
          />
        )}
        {d.diagnostic ? (
          <Alert color="myoxusError" role="alert">
            {d.diagnostic}
          </Alert>
        ) : null}
        {!props.readonly ? (
          <Group>
            <Button
              onClick={() => {
                const result = member
                  ? d.commit("editClassMember", [
                      member.id,
                      precise
                        ? (changedClassFields(
                            initial,
                            v,
                          ) as Partial<MermaidClassMember>)
                        : { raw: v.raw },
                    ])
                  : d.commit("addClassMember", [
                      classKey,
                      { ...v, raw: precise ? undefined : v.raw },
                      undefined,
                      v.before || undefined,
                    ]);
                if (!result.diagnostic) onClose();
              }}
            >
              {t["com.myoxus.editCollection.save"]()}
            </Button>
            {member ? (
              <>
                <Button
                  onClick={() => {
                    const result = d.commit("duplicateClassMember", [
                      member.id,
                    ]);
                    if (!result.diagnostic) onClose();
                  }}
                >
                  {t["com.myoxus.editor.keyboard.duplicate"]()}
                </Button>
                <Button
                  disabled={index <= 0}
                  onClick={() =>
                    d.commit("reorderClassMember", [
                      member.id,
                      siblings[index - 1]?.id,
                    ])
                  }
                >
                  {m.visualMoveUp()}
                </Button>
                <Button
                  disabled={index < 0 || index >= siblings.length - 1}
                  onClick={() =>
                    d.commit("reorderClassMember", [
                      member.id,
                      siblings[index + 2]?.id,
                    ])
                  }
                >
                  {m.visualMoveDown()}
                </Button>
                <Button onClick={() => setDeleting(true)}>
                  {m.visualDelete()}
                </Button>
              </>
            ) : null}
          </Group>
        ) : null}
        <ConfirmModal
          open={deleting}
          onOpenChange={setDeleting}
          title={m.visualDelete()}
          confirmText={m.visualDelete()}
          onConfirm={() => {
            if (!member) return;
            const result = d.commit("deleteClassMember", [member.id]);
            if (!result.diagnostic) {
              setDeleting(false);
              onClose();
            }
          }}
        >
          <Stack>
            {member
              ? props
                  .getImpact({ kind: "member", key: member.id })
                  .records.map((record) => (
                    <MyoxusText key={record.id}>{record.label}</MyoxusText>
                  ))
              : null}
          </Stack>
        </ConfirmModal>
      </Stack>
    </>
  );
}
export function ClassAddMemberPopover({
  props,
  classKey,
}: {
  props: ClassReactHostProps;
  classKey: string;
}) {
  const [opened, setOpened] = useState(false);
  return (
    <Popover fitViewport opened={opened} onChange={setOpened}>
      <PopoverTarget>
        <Button disabled={props.readonly} onClick={() => setOpened(!opened)}>
          {m.classAddMember()}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {opened ? (
            <ClassMemberForm
              props={props}
              classKey={classKey}
              onClose={() => setOpened(false)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
