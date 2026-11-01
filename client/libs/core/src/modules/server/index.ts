export { Server } from "./entities/server";
export type { AuthAccountInfo } from "./entities/session";
export { AccountChanged } from "./events/account-changed";
export { AccountLoggedIn } from "./events/account-logged-in";
export { AccountLoggedOut } from "./events/account-logged-out";
export { AuthProvider } from "./provider/auth";
export { ValidatorProvider } from "./provider/validator";
export { ServerScope } from "./scopes/server";
export { AccessTokenService } from "./services/access-token";
export { AuthService } from "./services/auth";
export { type AltchaChallenge, CaptchaService } from "./services/captcha";
export { DefaultServerService } from "./services/default-server";
export { EventSourceService } from "./services/eventsource";
export { FetchService } from "./services/fetch";
export {
  configureMyoxusGraphQLClientContext,
  GraphQLService,
} from "./services/graphql";
export { InvitationService } from "./services/invitation";
export type { PublicUserInfo } from "./services/public-user";
export { PublicUserService } from "./services/public-user";
export { ServerService } from "./services/server";
export { ServersService } from "./services/servers";
export { UserCopilotQuotaService } from "./services/user-copilot-quota";
export { UserFeatureService } from "./services/user-feature";
export {
  type EffectiveUserPreferenceValues,
  type UpdateUserPreferencesInput,
  type UserPreferences,
  UserPreferencesService,
  type UserPreferenceValues,
  type WorkspaceDashboardDashletId,
  type WorkspaceDashboardDashletSize,
  type WorkspaceDashboardLayout,
  type WorkspaceDashboardLayoutsProjection,
} from "./services/user-preferences";
export { UserQuotaService } from "./services/user-quota";
export { WorkspaceServerService } from "./services/workspace-server";
export type { ServerConfig } from "./types";

import { type Framework } from "@myoxus/infra";

import { GlobalCache, GlobalState } from "../storage/providers/global";
import { GlobalStateService } from "../storage/services/global";
import { UrlService } from "../url";
import { WorkspaceScope } from "../workspace";
import { ServerDocMeta } from "./entities/server-doc-meta";
import { Server } from "./entities/server";
import { AuthSession } from "./entities/session";
import { UserCopilotQuota } from "./entities/user-copilot-quota";
import { UserFeature } from "./entities/user-feature";
import { UserQuota } from "./entities/user-quota";
import { configureDefaultAuthProvider } from "./impl/auth";
import { AuthProvider } from "./provider/auth";
import { ServerScope } from "./scopes/server";
import { InvitationService } from "./services/invitation";
import { AuthService } from "./services/auth";
import { VirgultumWriterInfoService } from "./services/virgultum-writer-info";
import { CaptchaService } from "./services/captcha";
import { ServerDocMetaService } from "./services/server-doc-meta";
import { DefaultServerService } from "./services/default-server";
import { EventSourceService } from "./services/eventsource";
import { FetchService } from "./services/fetch";
import { GraphQLService } from "./services/graphql";
import { PublicUserService } from "./services/public-user";
import { ServerService } from "./services/server";
import { ServersService } from "./services/servers";
import { UserCopilotQuotaService } from "./services/user-copilot-quota";
import { UserFeatureService } from "./services/user-feature";
import { UserQuotaService } from "./services/user-quota";
import { UserPreferencesService } from "./services/user-preferences";
import { WorkspaceServerService } from "./services/workspace-server";
import { AcceptInviteStore } from "./stores/accept-invite";
import { AuthStore } from "./stores/auth";
import { ServerDocMetaStore } from "./stores/server-doc-meta";
import { InviteInfoStore } from "./stores/invite-info";
import { PublicUserStore } from "./stores/public-user";
import { ServerConfigStore } from "./stores/server-config";
import { ServerListStore } from "./stores/server-list";
import { UserCopilotQuotaStore } from "./stores/user-copilot-quota";
import { UserFeatureStore } from "./stores/user-feature";
import { UserQuotaStore } from "./stores/user-quota";
import { UserPreferencesStore } from "./stores/user-preferences";
import { DocScope, DocService } from "../doc";
import { GlobalDialogService } from "../dialogs";
import { AccessTokenService } from "./services/access-token";
import { AccessTokenStore } from "./stores/access-token";
import { I18nService } from "../i18n";

export function configureServerModule(framework: Framework) {
  configureDefaultAuthProvider(framework);

  framework
    .service(ServersService, [ServerListStore, ServerConfigStore])
    .service(DefaultServerService, [ServersService])
    .store(ServerListStore, [GlobalStateService])
    .store(ServerConfigStore, [ServerListStore])
    .entity(Server, [ServerListStore, I18nService])
    .scope(ServerScope)
    .service(ServerService, [ServerScope])
    .service(FetchService, [ServerService])
    .service(EventSourceService, [ServerService])
    .service(GraphQLService, [FetchService])
    .service(CaptchaService, [FetchService, ServerService])
    .service(AuthService, [
      FetchService,
      AuthStore,
      UrlService,
      GlobalDialogService,
    ])
    .store(AuthStore, [
      FetchService,
      GraphQLService,
      GlobalState,
      ServerService,
      AuthProvider,
    ])
    .entity(AuthSession, [AuthStore])
    .service(UserQuotaService)
    .store(UserQuotaStore, [GraphQLService])
    .entity(UserQuota, [AuthService, UserQuotaStore])
    .service(UserCopilotQuotaService)
    .store(UserCopilotQuotaStore, [GraphQLService])
    .entity(UserCopilotQuota, [
      AuthService,
      UserCopilotQuotaStore,
      ServerService,
    ])
    .service(UserFeatureService)
    .entity(UserFeature, [AuthService, UserFeatureStore])
    .store(UserFeatureStore, [GraphQLService])
    .store(InviteInfoStore, [GraphQLService])
    .service(InvitationService, [AcceptInviteStore, InviteInfoStore])
    .store(AcceptInviteStore, [GraphQLService])
    .service(PublicUserService, [PublicUserStore])
    .store(PublicUserStore, [GraphQLService])
    .service(UserPreferencesService, [
      UserPreferencesStore,
      AuthService,
      ServerService,
    ])
    .store(UserPreferencesStore, [GraphQLService, GlobalState])
    .service(AccessTokenService, [AccessTokenStore])
    .store(AccessTokenStore, [GraphQLService]);

  framework
    .scope(WorkspaceScope)
    .service(WorkspaceServerService)
    .scope(DocScope)
    .service(ServerDocMetaService)
    .entity(ServerDocMeta, [ServerDocMetaStore, DocService, GlobalCache])
    .store(ServerDocMetaStore, [WorkspaceServerService]);
  framework
    .scope(WorkspaceScope)
    .service(VirgultumWriterInfoService, [WorkspaceServerService]);
}
