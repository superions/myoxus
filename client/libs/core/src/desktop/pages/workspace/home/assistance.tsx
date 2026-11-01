// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  AssistanceMode,
  workspaceSetupAssistanceQuery,
  type WorkspaceSetupAssistanceQuery,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { Button, Group, MyoxusText, Notice } from "@myoxus/ui-facade";
import { useEffect, useRef, useState } from "react";
import { WorkbenchService } from "@myoxus/core/modules/workbench";
import { AssistantGroups } from "@myoxus/core/modules/database/presentation/renderer";
import {
  UserPreferencesService,
  type Server,
} from "@myoxus/core/modules/server";
import type { GlobalState } from "@myoxus/core/modules/storage";
import { localWorkspaceAssistanceKey } from "@myoxus/core/modules/workspace/metadata";

type Props = {
  server: Server | null;
  workspaceId: string;
  local: boolean;
  state: GlobalState;
  onNewTask: () => void;
  onOpenNotes: () => void;
  onOpenLibrary: () => void;
};

/** Optional native Home entry links only. Confirmed Guided proposes these
 * commands; rendering never seeds content or executes an assistance recipe. */
export function WorkspaceHomeAssistance(props: Props) {
  return props.local ? (
    <LocalHomeAssistance key={props.workspaceId} {...props} />
  ) : props.server ? (
    <RemoteHomeAssistance
      key={JSON.stringify([props.server.id, props.workspaceId])}
      {...props}
      server={props.server}
    />
  ) : null;
}
function RemoteHomeAssistance(props: Props & { server: Server }) {
  const t = useI18n();
  const workbench = useService(WorkbenchService).workbench;
  const service = props.server.scope.get(UserPreferencesService);
  const identity = useLiveData(service.preferenceIdentity$);
  const revision = useLiveData(service.assistanceRevision$);
  const actor = useLiveData(props.server.account$)?.id;
  const epoch = useRef(0);
  const [authRevision, setAuthRevision] = useState(0);
  const [retry, setRetry] = useState(0);
  const [confirmed, setConfirmed] = useState<{
    identity: string;
    revision: number;
    authRevision: number;
    mode: AssistanceMode;
  }>();
  const [help, setHelp] = useState<{
    assistance: NonNullable<
      NonNullable<
        WorkspaceSetupAssistanceQuery["workspace"]
      >["workspaceSetupAssistance"]
    >;
    scope: string;
    generation: number;
  }>();
  const [failed, setFailed] = useState(false);
  const scope = JSON.stringify([
    props.server.id,
    props.workspaceId,
    identity,
    revision,
    actor,
    authRevision,
  ]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useEffect(() => {
    const subscription = props.server.account$.subscribe((account) => {
      if (account?.id !== actor) {
        ++epoch.current;
        setHelp(undefined);
        setConfirmed(undefined);
        setAuthRevision((value) => value + 1);
      }
    });
    return () => {
      ++epoch.current;
      subscription.unsubscribe();
    };
  }, [props.server, actor]);
  useEffect(() => {
    let active = true;
    const generation = ++epoch.current;
    setConfirmed(undefined);
    setHelp(undefined);
    setFailed(false);
    if (identity && actor)
      void service.getAssistance(props.workspaceId).then(
        (value) => {
          if (
            active &&
            generation === epoch.current &&
            scopeRef.current === scope &&
            props.server.account$.value?.id === actor
          )
            setConfirmed({
              identity,
              revision,
              authRevision,
              mode: value.mode,
            });
        },
        () => {
          if (active && generation === epoch.current) setConfirmed(undefined);
        },
      );
    return () => {
      active = false;
    };
  }, [
    service,
    props.server,
    props.workspaceId,
    identity,
    revision,
    actor,
    authRevision,
    scope,
  ]);
  const guided = Boolean(
    identity &&
    confirmed?.identity === identity &&
    confirmed.revision === revision &&
    confirmed.authRevision === authRevision &&
    confirmed.mode === AssistanceMode.Guided,
  );
  useEffect(() => {
    let active = true;
    const generation = epoch.current;
    setHelp(undefined);
    setFailed(false);
    if (guided && actor)
      void props.server
        .gql({
          query: workspaceSetupAssistanceQuery,
          variables: { workspaceId: props.workspaceId },
        })
        .then(
          (response) => {
            if (
              !active ||
              generation !== epoch.current ||
              scopeRef.current !== scope ||
              props.server.account$.value?.id !== actor
            )
              return;
            if (
              response.currentUser?.id !== actor ||
              response.workspace?.id !== props.workspaceId
            ) {
              setFailed(true);
              return;
            }
            const assistance = response.workspace.workspaceSetupAssistance;
            if (assistance?.descriptor.presentation.guidedHelp)
              setHelp({ assistance, scope, generation });
          },
          () => {
            if (
              active &&
              generation === epoch.current &&
              scopeRef.current === scope
            )
              setFailed(true);
          },
        );
    return () => {
      active = false;
    };
  }, [guided, actor, props.server, props.workspaceId, scope, retry]);
  if (!guided) return null;
  const assistance =
    help?.scope === scope && help.generation === epoch.current
      ? help.assistance
      : undefined;
  const sourceDescriptor = assistance?.descriptor;
  // These are existing authorized working copies, not Library sources to seed.
  const documentSources = sourceDescriptor?.documentSources.filter((source) =>
    assistance?.documentTargets.some(
      (target) =>
        target.step === source.step &&
        target.group === source.group &&
        target.sourceDigest === source.digest &&
        Boolean(target.documentExternalId),
    ),
  );
  const descriptor = sourceDescriptor
    ? { ...sourceDescriptor, documentSources: documentSources ?? [] }
    : undefined;
  const step = descriptor?.presentation.guidedHelp;
  const groups = step?.groups.filter((group) =>
    documentSources?.some(
      (source) => source.step === step.id && source.group === group.id,
    ),
  );
  return (
    <>
      <NativeHomeLinks {...props} />
      {failed ? (
        <Notice tone="warning">
          {t["com.myoxus.common.operation-failed"]()}
          <Button onClick={() => setRetry((value) => value + 1)}>
            {t.Retry()}
          </Button>
        </Notice>
      ) : null}
      {descriptor && step && groups?.length ? (
        <AssistantGroups
          descriptor={descriptor}
          stepId={step.id}
          artworkServer={props.server}
          groups={groups}
          answers={{}}
          adapters={{}}
          onOpenDocumentSource={(source) => {
            if (
              epoch.current !== help?.generation ||
              scopeRef.current !== help?.scope ||
              props.server.account$.value?.id !== actor ||
              !guided
            )
              return;
            const target = assistance?.documentTargets.find(
              (target) =>
                target.step === source.step &&
                target.group === source.group &&
                target.sourceDigest === source.digest,
            );
            if (target?.documentExternalId)
              workbench.openDoc(target.documentExternalId, { at: "tail" });
          }}
        />
      ) : null}
    </>
  );
}
function LocalHomeAssistance(props: Props) {
  const [mode, setMode] = useState(AssistanceMode.Manual);
  useEffect(() => {
    const subscription = props.state
      .watch<AssistanceMode>(localWorkspaceAssistanceKey(props.workspaceId))
      .subscribe((value) => setMode(value ?? AssistanceMode.Manual));
    return () => subscription.unsubscribe();
  }, [props.state, props.workspaceId]);
  return mode === AssistanceMode.Guided ? <NativeHomeLinks {...props} /> : null;
}
function NativeHomeLinks({
  local,
  onNewTask,
  onOpenNotes,
  onOpenLibrary,
}: Props) {
  const t = useI18n();
  return (
    <>
      <MyoxusText>
        {local
          ? t["com.myoxus.workspace-home.guided.local"]()
          : t["com.myoxus.workspace-home.guided.description"]()}
      </MyoxusText>
      <Group>
        {!local ? (
          <Button onClick={onNewTask}>
            {t["com.myoxus.database.tasks.new"]()}
          </Button>
        ) : null}
        <Button onClick={onOpenNotes}>
          {local
            ? t["All content"]()
            : t["com.myoxus.workspace-home.guided.capture"]()}
        </Button>
        <Button onClick={onOpenLibrary}>
          {t["com.myoxus.rootAppSidebar.library"]()}
        </Button>
      </Group>
    </>
  );
}
