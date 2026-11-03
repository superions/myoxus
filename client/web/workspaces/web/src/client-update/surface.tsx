import { useI18n } from "@myoxus/i18n";
import type {
  ClientUpdateGate,
  ClientUpdateGateSnapshot,
} from "@myoxus/storage";
import {
  ExceptionBoundaryFrame,
  ExceptionBoundarySurface,
  MyoxusButton,
  notify,
  SettingsSectionDescription,
  SettingsSectionHeading,
} from "@myoxus/ui-facade";
import { type PropsWithChildren, useEffect, useSyncExternalStore } from "react";

import {
  type ClientUpdateCacheResetSnapshot,
  clientUpdateCacheResetStore,
} from "./cache-reset";
import { clientUpdateGate, rereadClientUpdateControl } from "./coordinator";

const LIMITED_NOTIFICATION_ID = "client-update-limited";

function useClientUpdateSnapshot(gate: ClientUpdateGate) {
  return useSyncExternalStore(
    gate.subscribe,
    gate.getSnapshot,
    gate.getSnapshot,
  );
}

function LimitedUpdateNotice({
  snapshot,
}: {
  snapshot: Extract<ClientUpdateGateSnapshot, { status: "ready" }>;
}) {
  const t = useI18n();
  useEffect(() => {
    if (snapshot.control.phase !== "limited") {
      notify.dismiss(LIMITED_NOTIFICATION_ID);
      return;
    }
    notify.dismiss(LIMITED_NOTIFICATION_ID);
    notify.warning(
      {
        title: t["com.myoxus.clientUpdate.limited.title"](),
        message: t["com.myoxus.clientUpdate.limited.description"]({
          remaining: String(snapshot.remainingAttempts ?? 0),
        }),
      },
      { id: LIMITED_NOTIFICATION_ID, duration: 0 },
    );
    return () => notify.dismiss(LIMITED_NOTIFICATION_ID);
  }, [snapshot.control.phase, snapshot.remainingAttempts, t]);
  return null;
}

function BlockingUpdateSurface({
  snapshot,
  reread,
}: {
  snapshot: ClientUpdateGateSnapshot;
  reread: () => Promise<unknown>;
}) {
  const t = useI18n();
  const isLocalError = snapshot.status === "error";
  const phase =
    snapshot.status === "ready" ? snapshot.control.phase : snapshot.status;
  const title =
    phase === "suspended"
      ? t["com.myoxus.clientUpdate.suspended.title"]()
      : phase === "failed"
        ? t["com.myoxus.clientUpdate.failed.title"]()
        : phase === "error"
          ? t["com.myoxus.clientUpdate.controlError.title"]()
          : t["com.myoxus.clientUpdate.loading.title"]();
  const description =
    phase === "suspended"
      ? t["com.myoxus.clientUpdate.suspended.description"]()
      : phase === "failed"
        ? t["com.myoxus.clientUpdate.failed.description"]()
        : phase === "error"
          ? t["com.myoxus.clientUpdate.controlError.description"]()
          : t["com.myoxus.clientUpdate.loading.description"]();

  return (
    <ExceptionBoundaryFrame
      scope="app"
      data-myoxus-ui-role={`client-update-boundary:${phase}`}
    >
      <ExceptionBoundarySurface>
        <SettingsSectionHeading level={1}>{title}</SettingsSectionHeading>
        <SettingsSectionDescription>{description}</SettingsSectionDescription>
        {isLocalError ? (
          <MyoxusButton
            data-testid="client-update-control-retry"
            onClick={() => {
              void reread().catch(() => {
                // The gate retains the failure for this visible retry surface.
              });
            }}
          >
            {t["com.myoxus.clientUpdate.controlError.retry"]()}
          </MyoxusButton>
        ) : null}
      </ExceptionBoundarySurface>
    </ExceptionBoundaryFrame>
  );
}

function CacheResetSurface({
  snapshot,
}: {
  snapshot: Exclude<ClientUpdateCacheResetSnapshot, { status: "idle" }>;
}) {
  const t = useI18n();
  const failed = snapshot.status === "failed";
  const deleting =
    snapshot.status === "deleting" || snapshot.status === "completed";

  return (
    <ExceptionBoundaryFrame
      scope="app"
      data-myoxus-ui-role={`client-update-cache-reset:${snapshot.status}`}
    >
      <ExceptionBoundarySurface>
        <SettingsSectionHeading level={1}>
          {failed
            ? t["com.myoxus.clientUpdate.failed.title"]()
            : t["com.myoxus.clientUpdate.cacheReset.title"]()}
        </SettingsSectionHeading>
        <SettingsSectionDescription>
          {failed
            ? t["com.myoxus.clientUpdate.cacheReset.failed"]()
            : deleting
              ? t["com.myoxus.clientUpdate.cacheReset.deleting"]()
              : t["com.myoxus.clientUpdate.cacheReset.waiting"]()}
        </SettingsSectionDescription>
        {failed ? (
          <MyoxusButton
            onClick={clientUpdateCacheResetStore.retry}
            variant="primary"
          >
            {t["Retry"]()}
          </MyoxusButton>
        ) : null}
      </ExceptionBoundarySurface>
    </ExceptionBoundaryFrame>
  );
}

/** Global Web boundary; normal mode is deliberately a zero-chrome pass-through. */
export function ClientUpdateSurface({
  children,
  gate = clientUpdateGate,
  reread = rereadClientUpdateControl,
}: PropsWithChildren<{
  gate?: ClientUpdateGate;
  reread?: () => Promise<unknown>;
}>) {
  const snapshot = useClientUpdateSnapshot(gate);
  const cacheReset = useSyncExternalStore(
    clientUpdateCacheResetStore.subscribe,
    clientUpdateCacheResetStore.getSnapshot,
    clientUpdateCacheResetStore.getSnapshot,
  );

  if (cacheReset.status !== "idle") {
    return <CacheResetSurface snapshot={cacheReset} />;
  }

  if (
    snapshot.status === "ready" &&
    (snapshot.control.phase === "normal" ||
      snapshot.control.phase === "limited")
  ) {
    return (
      <>
        <LimitedUpdateNotice snapshot={snapshot} />
        {children}
      </>
    );
  }

  return <BlockingUpdateSurface snapshot={snapshot} reread={reread} />;
}
