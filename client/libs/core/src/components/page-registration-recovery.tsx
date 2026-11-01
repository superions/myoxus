// SPDX-License-Identifier: AGPL-3.0-or-later

import { DocsService } from "@myoxus/core/modules/doc";
import { useGuard } from "@myoxus/core/components/guard";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { LiveData, useLiveData, useService } from "@myoxus/infra";
import { Alert, Button, Stack, Text } from "@myoxus/ui-facade";
import { useMemo, useState } from "react";

/** Explicit recovery for retained local content; never runs as a reconnect effect. */
export function PageRegistrationRecovery({ docId }: { docId?: string }) {
  const t = useI18n();
  const workspace = useService(WorkspaceService).workspace;
  const docs = useService(DocsService);
  const canCreate = useGuard("Workspace_CreateDoc");
  const state = useLiveData(
    useMemo(
      () => LiveData.from(workspace.engine.doc.state$, null),
      [workspace],
    ),
  );
  const records = useLiveData(docs.list.docs$);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const ids = docId
    ? (state?.unregisteredDocs ?? []).filter((id) => id === docId)
    : (state?.unregisteredDocs ?? []).filter(
        (id) => !records.some((record) => record.id === id),
      );
  if (!ids.length || workspace.flavour === "local") return null;

  const recover = async () => {
    setBusy(true);
    setFailed(false);
    try {
      for (const id of ids) await docs.recoverDocRegistration(id);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Alert
      title={t["com.myoxus.doc.recovery.title"]()}
      data-testid="page-registration-recovery"
    >
      <Stack>
        <Text>{t["com.myoxus.doc.recovery.description"]()}</Text>
        {failed ? (
          <Text role="alert">{t["com.myoxus.doc.recovery.failed"]()}</Text>
        ) : null}
        <Button loading={busy} disabled={!canCreate} onClick={recover}>
          {t["com.myoxus.doc.recovery.action"]()}
        </Button>
      </Stack>
    </Alert>
  );
}
