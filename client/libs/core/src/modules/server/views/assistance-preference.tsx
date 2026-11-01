// SPDX-License-Identifier: AGPL-3.0-or-later
import { AssistanceMode, AssistanceSource } from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData } from "@myoxus/infra";
import {
  Button,
  FormSelect,
  MenuItem,
  MenuPanel,
  MenuSub,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import { writeGlobalStateConfirmed, type GlobalState } from "../../storage";
import { localWorkspaceAssistanceKey } from "../../workspace/metadata";
import { useEffect, useRef, useState } from "react";

import type { UserPreferencesService } from "../services/user-preferences";
import type { ConfirmedAssistance } from "../stores/user-preferences";

type Props = {
  service: UserPreferencesService;
  workspaceId?: string;
  projectId?: string;
  menu?: boolean;
};

/** Personal settings render native contextual inheritance. Remount on owner or
 * target changes so neither a late save nor a denied read can reuse old state. */
export function AssistancePreference(props: Props) {
  const identity = useLiveData(props.service.preferenceIdentity$);
  return identity ? (
    <AssistancePreferenceSession
      key={JSON.stringify([identity, props.workspaceId, props.projectId])}
      {...props}
    />
  ) : null;
}

function AssistancePreferenceSession({
  service,
  workspaceId,
  projectId,
  menu,
}: Props) {
  const t = useI18n();
  const revision = useLiveData(service.assistanceRevision$);
  const [confirmed, setConfirmed] = useState<ConfirmedAssistance>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setConfirmed(undefined);
    setFailed(false);
    void service.getAssistance(workspaceId, projectId).then(
      (value) => {
        if (active) setConfirmed(value);
      },
      () => {
        if (active) setFailed(true);
      },
    );
    return () => {
      active = false;
    };
  }, [service, workspaceId, projectId, revision, retry]);

  const labels = {
    [AssistanceMode.Manual]: t["com.myoxus.assistance.manual"](),
    [AssistanceMode.Guided]: t["com.myoxus.assistance.guided"](),
    [AssistanceMode.Automatic]: t["com.myoxus.assistance.automatic"](),
  };
  const inherited =
    confirmed &&
    (projectId
      ? confirmed.source !== AssistanceSource.Project
      : workspaceId
        ? confirmed.source !== AssistanceSource.Workspace
        : !confirmed.userDefaultExplicit);
  const value = confirmed ? (inherited ? "inherit" : confirmed.mode) : null;
  const options = [
    { value: "inherit", label: t["com.myoxus.assistance.inherit"]() },
    ...Object.values(AssistanceMode).map((mode) => ({
      value: mode,
      label: labels[mode],
    })),
  ];
  const save = async (next: string) => {
    if (saving || !confirmed) return;
    const mode = Object.values(AssistanceMode).find((mode) => mode === next);
    if (next !== "inherit" && !mode) return;
    const identity = service.preferenceIdentity$.value;
    setSaving(true);
    setFailed(false);
    try {
      await service.updateAssistance(mode ?? null, workspaceId, projectId);
      // ACK invalidation owns the only contextual read channel; an older
      // trailing save-read must not overwrite a newer IPC/reload projection.
    } catch {
      if (service.preferenceIdentity$.value === identity) setFailed(true);
    } finally {
      if (service.preferenceIdentity$.value === identity) setSaving(false);
    }
  };
  const error = failed ? t["com.myoxus.assistance.save-failed"]() : undefined;
  if (menu)
    return (
      <MenuSub
        triggerOptions={{ "data-testid": "project-assistance-menu" }}
        items={
          <MenuPanel>
            {options.map((option) => (
              <MenuItem
                key={option.value}
                checked={option.value === value}
                disabled={!confirmed || saving}
                onSelect={() => void save(option.value)}
              >
                {option.label}
              </MenuItem>
            ))}
            {error ? <MenuItem disabled>{error}</MenuItem> : null}
            {failed ? (
              <MenuItem onSelect={() => setRetry((value) => value + 1)}>
                {t["Retry"]()}
              </MenuItem>
            ) : null}
          </MenuPanel>
        }
      >
        {t["com.myoxus.assistance.title"]()}
      </MenuSub>
    );
  return (
    <Stack>
      <FormSelect
        label={t["com.myoxus.assistance.title"]()}
        description={t["com.myoxus.assistance.description"]()}
        data={options}
        value={value}
        disabled={!confirmed || saving}
        onChange={(next) => void save(next)}
        error={error}
        data-testid="assistance-preference"
      />
      {confirmed ? (
        <Notice>
          {t["com.myoxus.assistance.effective"]({
            mode: labels[confirmed.mode],
          })}
        </Notice>
      ) : null}
      {failed ? (
        <Button onClick={() => setRetry((value) => value + 1)}>
          {t["Retry"]()}
        </Button>
      ) : null}
    </Stack>
  );
}

/** Native local mode is a persisted presentation choice only. It has no server
 * inheritance, automation policy, or offline assistance replay. */
export function LocalAssistancePreference({
  state,
  workspaceId,
}: {
  state: GlobalState;
  workspaceId: string;
}) {
  const t = useI18n();
  const key = localWorkspaceAssistanceKey(workspaceId);
  const [projection, setProjection] = useState(() => ({
    key,
    mode: state.get<AssistanceMode>(key) ?? AssistanceMode.Manual,
  }));
  const mode = projection.key === key ? projection.mode : AssistanceMode.Manual;
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const activeKey = useRef(key);
  activeKey.current = key;
  useEffect(() => {
    setSaving(false);
    setFailed(false);
    const subscription = state
      .watch<AssistanceMode>(key)
      .subscribe((value) =>
        setProjection({ key, mode: value ?? AssistanceMode.Manual }),
      );
    return () => subscription.unsubscribe();
  }, [state, key]);
  return (
    <FormSelect
      label={t["com.myoxus.assistance.title"]()}
      description={t["com.myoxus.assistance.description"]()}
      value={mode}
      disabled={saving}
      data={[
        {
          value: AssistanceMode.Manual,
          label: t["com.myoxus.assistance.manual"](),
        },
        {
          value: AssistanceMode.Guided,
          label: t["com.myoxus.assistance.guided"](),
        },
        {
          value: AssistanceMode.Automatic,
          label: t["com.myoxus.assistance.automatic"](),
        },
      ]}
      error={failed ? t["com.myoxus.assistance.save-failed"]() : undefined}
      onChange={async (value) => {
        const selected = Object.values(AssistanceMode).find(
          (mode) => mode === value,
        );
        if (!selected) return;
        try {
          setSaving(true);
          await writeGlobalStateConfirmed(state, key, selected);
          if (active.current && activeKey.current === key) setFailed(false);
        } catch {
          if (active.current && activeKey.current === key) setFailed(true);
        } finally {
          if (active.current && activeKey.current === key) setSaving(false);
        }
      }}
    />
  );
}
