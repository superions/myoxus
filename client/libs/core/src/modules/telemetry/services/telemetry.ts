import { DebugLogger } from "@myoxus/debug";
import { ServerDeploymentType } from "@myoxus/graphql";
import { LiveData, OnEvent, Service } from "@myoxus/infra";
import { flushTelemetry, setTelemetryContext, tracker } from "@myoxus/track";
import { shallowEqual } from "@myoxus/ui-facade";

import type { GlobalContextService } from "../../global-context";
import { ApplicationStarted } from "../../lifecycle";
import type { AuthAccountInfo, Server, ServersService } from "../../server";
import { UserPreferencesService } from "../../server/services/user-preferences";

const logger = new DebugLogger("telemetry-service");

@OnEvent(ApplicationStarted, (e) => e.onApplicationStart)
export class TelemetryService extends Service {
  private readonly disposableFns: (() => void)[] = [];

  private readonly currentAccount$ =
    this.globalContextService.globalContext.serverId.$.selector((id) =>
      id
        ? this.serversService.server$(id)
        : this.serversService.selectedServerId$
            .map((selected) =>
              selected
                ? this.serversService.server$(selected)
                : new LiveData<Server | undefined>(undefined),
            )
            .flat(),
    )
      .flat()
      .selector(
        (server) =>
          [
            server?.account$,
            server?.config$.selector(
              (c) => c.type === ServerDeploymentType.Standalone,
            ),
            new LiveData(server?.baseUrl),
            server?.scope.get(UserPreferencesService).userPreferences$,
            new LiveData(server?.id),
          ] as const,
      )
      .flat()
      .map(([account, selfHosted, baseUrl, preferences, serverId]) => ({
        account,
        selfHosted,
        baseUrl,
        serverId,
        enabled: preferences?.effectiveValues.telemetryEnabled === true,
      }))
      .distinctUntilChanged(shallowEqual);

  constructor(
    private readonly globalContextService: GlobalContextService,
    private readonly serversService: ServersService,
  ) {
    super();

    let prevAccount: AuthAccountInfo | null = null;
    let prevSelfHosted: boolean | undefined = undefined;
    const unsubscribe = this.currentAccount$.subscribe(
      ({ account, selfHosted, baseUrl, enabled, serverId }) => {
        const channel =
          BUILD_CONFIG.appBuildType === "beta" ||
          BUILD_CONFIG.appBuildType === "internal" ||
          BUILD_CONFIG.appBuildType === "stable"
            ? BUILD_CONFIG.appBuildType
            : "stable";

        // Reset identity before switching destinations. A server's preference
        // acknowledgement controls opt-in; missing configuration sends nothing.
        if (prevAccount) tracker.reset();
        setTelemetryContext({
          isAuthed: !!account,
          isSelfHosted: !!selfHosted,
          channel,
          serverBaseUrl: enabled ? (baseUrl ?? "") : "",
          serverId,
        });

        // the isSelfHosted property from environment is not reliable
        if (selfHosted !== prevSelfHosted) {
          tracker.register({
            isSelfHosted: selfHosted,
          });
        }
        prevSelfHosted = selfHosted;
        if (account) {
          tracker.identify(account.id);
          tracker.people.set({
            $email: account.email,
            $name: account.label,
            $avatar: account.avatar,
          });
          void flushTelemetry().catch((error) => {
            logger.error("failed to flush telemetry after login", error);
          });
        } else if (prevAccount) {
          void flushTelemetry().catch((error) => {
            logger.error("failed to flush telemetry after logout", error);
          });
        }
        prevAccount = account ?? null;
      },
    );
    this.disposableFns.push(() => {
      unsubscribe.unsubscribe();
    });
  }

  onApplicationStart() {
    this.registerMiddlewares();
  }

  registerMiddlewares() {
    this.disposables.push(
      tracker.middleware((_event, parameters) => {
        const extraContext = this.extractGlobalContext();
        return {
          ...extraContext,
          ...parameters,
        };
      }),
    );
  }

  extractGlobalContext(): { page?: string; serverId?: string } {
    const globalContext = this.globalContextService.globalContext;
    const page = globalContext.isDoc.get()
      ? globalContext.isTrashDoc.get()
        ? "trash"
        : globalContext.docMode.get() === "page"
          ? "doc"
          : "edgeless"
      : globalContext.isAllDocs.get()
        ? "allDocs"
        : globalContext.isTrash.get()
          ? "trash"
          : globalContext.isCollection.get()
            ? "collection"
            : globalContext.isTag.get()
              ? "tag"
              : undefined;
    const serverId = globalContext.serverId.get() ?? undefined;
    return { page, serverId };
  }

  override dispose(): void {
    this.disposableFns.forEach((dispose) => dispose());
    super.dispose();
  }
}
