// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  type WorkspaceMetadata,
  WorkspacesService,
} from "@myoxus/core/modules/workspace";
import { canUseLocalWorkspaces } from "@myoxus/core/modules/workspace/local-workspace-capability";
import { AssistanceMode } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { Button, ConfirmModal, Input, Notice, Stack } from "@myoxus/ui-facade";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

export interface WorkspaceDialogBodyProps {
  modal: ComponentProps<typeof ConfirmModal>;
  name: string;
  onNameChange: (value: string) => void;
  target: (disabled: boolean) => ReactNode;
  onCreated: (metadata: WorkspaceMetadata) => void;
}

export function LocalWorkspaceDialog({
  modal,
  name,
  onNameChange,
  target,
  onCreated,
}: WorkspaceDialogBodyProps) {
  const t = useI18n();
  const workspaces = useService(WorkspacesService);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [nameChecked, setNameChecked] = useState(false);
  const createdRef = useRef<WorkspaceMetadata | null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleCreate = async () => {
    setNameChecked(true);
    if (submittingRef.current || !name.trim() || !canUseLocalWorkspaces()) {
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const metadata =
        createdRef.current ??
        (await workspaces.create("local", undefined, {
          kind: "local-empty",
          name: name.trim(),
          assistanceMode: AssistanceMode.Guided,
        }));
      createdRef.current = metadata;
      if (mountedRef.current) onCreated(metadata);
    } catch {
      if (mountedRef.current) setFailed(true);
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  };

  const disabled = busy || Boolean(createdRef.current);

  return (
    <ConfirmModal
      {...modal}
      persistent={busy}
      cancelButtonOptions={{ disabled: busy }}
      customConfirmButton={() => (
        <Button
          type="submit"
          form="create-local-workspace-form"
          variant="primary"
          data-testid="create-workspace-create-button"
          disabled={busy}
          loading={busy}
        >
          {t.Create()}
        </Button>
      )}
    >
      <form
        id="create-local-workspace-form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleCreate();
        }}
      >
        <Stack>
          <Input
            autoFocus
            data-autofocus
            required
            maxLength={64}
            disabled={disabled}
            value={name}
            error={
              nameChecked && !name.trim()
                ? t["com.myoxus.document-metadata.validation.required"]({
                    label:
                      t["com.myoxus.nameWorkspace.subtitle.workspace-name"](),
                  })
                : undefined
            }
            onChange={onNameChange}
            label={t["com.myoxus.nameWorkspace.subtitle.workspace-name"]()}
            data-testid="create-workspace-input"
          />
          {target(disabled)}
          {failed ? (
            <Notice tone="error">
              {t["com.myoxus.create-workspace.error.message"]()}
            </Notice>
          ) : null}
        </Stack>
      </form>
    </ConfirmModal>
  );
}
