/**
 * Workspace setting -> Organisation tab.
 *
 * Manager-scoped surface that mirrors the GraphQL contract built in
 * Paket D. The tab shows:
 *   - the OUs in which the current user is a member (`myOrganizationUnits`),
 *   - workspace links for those OUs (`myOrganizationUnitWorkspaces`),
 *   - a project-creation form (Allowed/RequiresApproval/Denied),
 *   - a workspace-creation form scoped to a specific OU.
 *
 * All gates are enforced by the Rust resolver. The UI only collects
 * inputs and reflects the server's policy decision.
 */
import {
  addOrganizationUnitMemberAsManagerMutation,
  canCreateOrganizationProjectQuery,
  canCreateWorkspaceInOrganizationUnitQuery,
  createOrganizationProjectMutation,
  createWorkspaceInOrganizationUnitMutation,
  managerSearchUsersQuery,
  myOrganizationAuditLogQuery,
  myOrganizationUnitMembersQuery,
  myOrganizationUnitsQuery,
  myOrganizationUnitWorkspacesQuery,
  OrganizationUnitMemberSourceEnum,
  OrganizationUnitRoleEnum,
  OrganizationUnitStatusEnum,
  OrganizationUnitWorkspaceRelationshipEnum,
  ProjectCreationDecisionEnum,
  removeOrganizationUnitMemberAsManagerMutation,
} from "@myoxus/graphql";
import { useI18n } from "@myoxus/i18n";
import { type ReactNode, useState } from "react";

import { useMutation } from "../../../../../components/hooks/use-mutation";
import { useQuery } from "../../../../../components/hooks/use-query";
import {
  Button,
  FormRow,
  FormSelect,
  Input,
  SettingsControlEmpty,
  SettingsControlList,
  SettingsDefinitionItem,
  SettingsDefinitionList,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SettingsPage,
  SettingsSection,
  SettingsStatusText,
  SettingsToolbar,
  Stack,
  StatusDot,
  SuggestionList,
  SuggestionListItemButton,
  SurfaceListItem,
  SurfaceListItemMain,
  SurfaceListMeta,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableScrollContainer,
} from "../../primitives";

// -- Tone roles ---------------------------------------------------------------

type StatusTone = "neutral" | "success" | "warning" | "error" | "info";
type I18n = ReturnType<typeof useI18n>;

function formatAuditDate(language: string | undefined, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

type SelectedMemberUser = {
  id: string;
  label: string;
  email: string;
};

const ROOT_PROJECT_SCOPE_VALUE = "__myoxus_organization_root__";
const organizationQueryConfig = {
  suspense: false,
  suppressErrorNotification: true,
} as const;

function organizationUnitDisplayName(
  unit: { name?: string | null; unitName?: string | null },
  t: I18n,
): string {
  return (
    unit.name?.trim() ||
    unit.unitName?.trim() ||
    t["com.myoxus.settings.workspace.organization.units.unknown"]()
  );
}

// -- Atoms --------------------------------------------------------------------

// These route-local atoms only bind domain copy to existing Facade primitives.
// Visual chrome, spacing, status colors and responsive behavior stay in Facade.
const OrganizationStatus = ({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) => (
  <StatusDot
    tone={tone}
    label={label}
    aria-label={label}
    data-myoxus-ui-role={`settings-organization-status:${tone}`}
  />
);

const OrganizationListItem = ({
  name,
  desc,
  inList = false,
  trailing,
  testId,
}: {
  name: ReactNode;
  desc?: ReactNode;
  inList?: boolean;
  trailing?: ReactNode;
  testId?: string;
}) => (
  <SurfaceListItem
    component={inList ? "li" : "article"}
    data-testid={testId}
    density="compact"
    layout="row"
    alignItems="center"
    justifyContent="space-between"
    data-myoxus-ui-role="settings-organization-list-item"
  >
    <SurfaceListItemMain compact grow>
      <SettingsListItemTitle>{name}</SettingsListItemTitle>
      {desc !== undefined ? (
        <SettingsListItemMeta breakAnywhere>{desc}</SettingsListItemMeta>
      ) : null}
    </SurfaceListItemMain>
    {trailing ? (
      <SurfaceListMeta layout="inline">{trailing}</SurfaceListMeta>
    ) : null}
  </SurfaceListItem>
);

// -- Helpers ------------------------------------------------------------------

const unitSelectData = (
  units: Array<{ id: string; name?: string | null; unitName?: string | null }>,
  t: I18n,
) =>
  units.map((unit) => ({
    value: unit.id,
    label: organizationUnitDisplayName(unit, t),
  }));

const decisionTone = (
  decision?: ProjectCreationDecisionEnum,
  t?: I18n,
): { tone: StatusTone; label: string } => {
  switch (decision) {
    case ProjectCreationDecisionEnum.Allowed:
      return {
        tone: "success",
        label: t
          ? t["com.myoxus.settings.workspace.organization.policy.allowed"]()
          : "allowed",
      };
    case ProjectCreationDecisionEnum.RequiresApproval:
      return {
        tone: "warning",
        label: t
          ? t[
              "com.myoxus.settings.workspace.organization.policy.requires-approval"
            ]()
          : "requires approval",
      };
    case ProjectCreationDecisionEnum.Denied:
      return {
        tone: "error",
        label: t
          ? t["com.myoxus.settings.workspace.organization.policy.denied"]()
          : "denied",
      };
    default:
      return {
        tone: "neutral",
        label: t
          ? t["com.myoxus.settings.workspace.organization.status.empty"]()
          : "—",
      };
  }
};

const unitStatusTone = (
  status: OrganizationUnitStatusEnum,
  t: I18n,
): { tone: StatusTone; label: string } => {
  switch (status) {
    case OrganizationUnitStatusEnum.Active:
      return {
        tone: "success",
        label: t["com.myoxus.settings.workspace.organization.status.active"](),
      };
    case OrganizationUnitStatusEnum.Disabled:
      return {
        tone: "error",
        label:
          t["com.myoxus.settings.workspace.organization.status.disabled"](),
      };
    case OrganizationUnitStatusEnum.Archived:
      return {
        tone: "neutral",
        label:
          t["com.myoxus.settings.workspace.organization.status.archived"](),
      };
  }
};

const relationshipTone = (
  relationship: OrganizationUnitWorkspaceRelationshipEnum,
  t: I18n,
): { tone: StatusTone; label: string } => {
  switch (relationship) {
    case OrganizationUnitWorkspaceRelationshipEnum.Owner:
      return {
        tone: "warning",
        label:
          t["com.myoxus.settings.workspace.organization.relationship.owner"](),
      };
    case OrganizationUnitWorkspaceRelationshipEnum.Managed:
      return {
        tone: "info",
        label:
          t[
            "com.myoxus.settings.workspace.organization.relationship.managed"
          ](),
      };
    case OrganizationUnitWorkspaceRelationshipEnum.Linked:
      return {
        tone: "neutral",
        label:
          t["com.myoxus.settings.workspace.organization.relationship.linked"](),
      };
  }
};

const roleTone = (
  role: OrganizationUnitRoleEnum,
  t: I18n,
): { tone: StatusTone; label: string } => {
  switch (role) {
    case OrganizationUnitRoleEnum.Manager:
      return {
        tone: "success",
        label:
          t[
            "com.myoxus.settings.workspace.organization.members.role.manager"
          ](),
      };
    case OrganizationUnitRoleEnum.Member:
      return {
        tone: "info",
        label:
          t["com.myoxus.settings.workspace.organization.members.role.member"](),
      };
    case OrganizationUnitRoleEnum.Reader:
      return {
        tone: "neutral",
        label:
          t["com.myoxus.settings.workspace.organization.members.role.reader"](),
      };
  }
};

const sourceLabel = (
  source: OrganizationUnitMemberSourceEnum,
  t: I18n,
): string => {
  switch (source) {
    case OrganizationUnitMemberSourceEnum.Manual:
      return t[
        "com.myoxus.settings.workspace.organization.members.source.manual"
      ]();
    case OrganizationUnitMemberSourceEnum.Import:
      return t[
        "com.myoxus.settings.workspace.organization.members.source.import"
      ]();
    case OrganizationUnitMemberSourceEnum.Ldap:
      return t[
        "com.myoxus.settings.workspace.organization.members.source.ldap"
      ]();
    case OrganizationUnitMemberSourceEnum.Oidc:
      return t[
        "com.myoxus.settings.workspace.organization.members.source.oidc"
      ]();
    case OrganizationUnitMemberSourceEnum.Scim:
      return t[
        "com.myoxus.settings.workspace.organization.members.source.scim"
      ]();
  }
};

const userLabel = (
  user: { userName?: string | null; userEmail?: string | null },
  t: I18n,
): string =>
  user.userName?.trim() ||
  user.userEmail?.trim() ||
  t["com.myoxus.settings.workspace.organization.members.unknown-user"]();

const searchUserLabel = (
  user: { name?: string | null; email: string },
  t: I18n,
): string =>
  user.name?.trim() ||
  user.email.trim() ||
  t["com.myoxus.settings.workspace.organization.members.unknown-user"]();

const UUID_LIKE_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const auditEventLabel = (eventKey: string, t: I18n): string => {
  const translated = t.t(
    `com.myoxus.settings.workspace.organization.audit.event.${eventKey}`,
  );
  return translated ===
    `com.myoxus.settings.workspace.organization.audit.event.${eventKey}`
    ? eventKey
    : translated;
};

const auditCategoryLabel = (category: string, t: I18n): string => {
  const translated = t.t(
    `com.myoxus.settings.workspace.organization.audit.category.${category}`,
  );
  return translated ===
    `com.myoxus.settings.workspace.organization.audit.category.${category}`
    ? category
    : translated;
};

const auditTargetLabel = (
  target: { type?: string | null; label?: string | null } | null | undefined,
  t: I18n,
): string | null => {
  if (!target) return null;
  const label = target.label?.trim();
  if (label && !UUID_LIKE_RE.test(label)) return label;
  if (!target.type) return null;
  const translated = t.t(
    `com.myoxus.settings.workspace.organization.audit.target.${target.type}`,
  );
  return translated ===
    `com.myoxus.settings.workspace.organization.audit.target.${target.type}`
    ? target.type
    : translated;
};

// ── Page ───────────────────────────────────────────────────────────────

export const WorkspaceOrganizationSettings = () => {
  const t = useI18n();

  const { data: unitsData, mutate: refetchUnits } = useQuery(
    {
      query: myOrganizationUnitsQuery,
    },
    organizationQueryConfig,
  );
  const { data: linksData, mutate: refetchLinks } = useQuery(
    {
      query: myOrganizationUnitWorkspacesQuery,
    },
    organizationQueryConfig,
  );

  const myUnits = unitsData?.myOrganizationUnits ?? [];
  const myLinks = linksData?.myOrganizationUnitWorkspaces ?? [];

  const [projectName, setProjectName] = useState("");
  const [projectUnit, setProjectUnit] = useState<string>("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceUnit, setWorkspaceUnit] = useState<string>("");
  const [memberUnit, setMemberUnit] = useState<string>("");
  const [auditUnit, setAuditUnit] = useState<string>("");
  const [memberUserSearch, setMemberUserSearch] = useState("");
  const [selectedMemberUser, setSelectedMemberUser] =
    useState<SelectedMemberUser | null>(null);
  const [memberRole, setMemberRole] = useState<OrganizationUnitRoleEnum>(
    OrganizationUnitRoleEnum.Member,
  );
  const selectedMemberUnitId = memberUnit;
  const selectedAuditUnitId = auditUnit;
  const selectedWorkspaceUnitId = workspaceUnit;

  const { data: membersData, mutate: refetchMembers } = useQuery(
    selectedMemberUnitId
      ? {
          query: myOrganizationUnitMembersQuery,
          variables: { unitId: selectedMemberUnitId },
        }
      : undefined,
    organizationQueryConfig,
  );
  const myMembers = memberUnit
    ? (membersData?.myOrganizationUnitMembers ?? [])
    : [];
  const trimmedMemberUserSearch = memberUserSearch.trim();
  const userSearchEnabled =
    Boolean(memberUnit) && trimmedMemberUserSearch.length >= 2;
  const { data: userSearchData } = useQuery(
    userSearchEnabled
      ? {
          query: managerSearchUsersQuery,
          variables: {
            unitId: memberUnit,
            query: trimmedMemberUserSearch,
            limit: 8,
          },
        }
      : undefined,
    organizationQueryConfig,
  );
  const userSearchResults = userSearchData?.managerSearchUsers ?? [];

  const { data: auditData } = useQuery(
    selectedAuditUnitId
      ? {
          query: myOrganizationAuditLogQuery,
          variables: { unitId: selectedAuditUnitId, take: 50 },
        }
      : undefined,
    organizationQueryConfig,
  );
  const myAudit = selectedAuditUnitId
    ? (auditData?.myOrganizationAuditLog ?? [])
    : [];
  const addMember = useMutation({
    mutation: addOrganizationUnitMemberAsManagerMutation,
  });
  const removeMember = useMutation({
    mutation: removeOrganizationUnitMemberAsManagerMutation,
  });

  const { data: rootDecisionData } = useQuery(
    myUnits.length > 0
      ? {
          query: canCreateOrganizationProjectQuery,
          variables: { unitId: null },
        }
      : undefined,
    organizationQueryConfig,
  );
  const { data: unitDecisionData } = useQuery(
    projectUnit
      ? {
          query: canCreateOrganizationProjectQuery,
          variables: { unitId: projectUnit },
        }
      : undefined,
    organizationQueryConfig,
  );
  const { data: wsDecisionData } = useQuery(
    selectedWorkspaceUnitId
      ? {
          query: canCreateWorkspaceInOrganizationUnitQuery,
          variables: { unitId: selectedWorkspaceUnitId },
        }
      : undefined,
    organizationQueryConfig,
  );

  const createProject = useMutation({
    mutation: createOrganizationProjectMutation,
  });
  const createWorkspace = useMutation({
    mutation: createWorkspaceInOrganizationUnitMutation,
  });

  const rootDecision = decisionTone(
    rootDecisionData?.canCreateOrganizationProject as
      ProjectCreationDecisionEnum | undefined,
    t,
  );
  const unitDecision = decisionTone(
    unitDecisionData?.canCreateOrganizationProject as
      ProjectCreationDecisionEnum | undefined,
    t,
  );
  const organizationUnitOptions = unitSelectData(myUnits, t);
  const projectScopeOptions = [
    {
      value: ROOT_PROJECT_SCOPE_VALUE,
      label:
        t[
          "com.myoxus.settings.workspace.organization.create-project.scope-root"
        ](),
    },
    ...organizationUnitOptions,
  ];

  return (
    <SettingsPage
      title={t["com.myoxus.settings.workspace.organization.header.title"]()}
      subtitle={t[
        "com.myoxus.settings.workspace.organization.header.subtitle"
      ]()}
    >
      {/* MY UNITS */}
      <SettingsSection
        title={t["com.myoxus.settings.workspace.organization.my-units.title"]()}
      >
        {myUnits.length === 0 ? (
          <OrganizationListItem
            name={t[
              "com.myoxus.settings.workspace.organization.my-units.empty"
            ]()}
            desc={t[
              "com.myoxus.settings.workspace.organization.my-units.empty-desc"
            ]()}
            trailing={
              <OrganizationStatus
                tone="neutral"
                label={t[
                  "com.myoxus.settings.workspace.organization.status.empty"
                ]()}
              />
            }
          />
        ) : (
          <SettingsControlList
            data-myoxus-ui-role="settings-organization-list"
            role="list"
          >
            {myUnits.map((u) => (
              <OrganizationListItem
                key={u.id}
                inList
                name={organizationUnitDisplayName(u, t)}
                trailing={
                  <OrganizationStatus
                    tone={unitStatusTone(u.status, t).tone}
                    label={unitStatusTone(u.status, t).label}
                  />
                }
              />
            ))}
          </SettingsControlList>
        )}
      </SettingsSection>

      {/* WORKSPACES IN MY OUS */}
      <SettingsSection
        title={t[
          "com.myoxus.settings.workspace.organization.workspaces.title"
        ]()}
      >
        {myLinks.length === 0 ? (
          <OrganizationListItem
            name={t[
              "com.myoxus.settings.workspace.organization.workspaces.empty"
            ]()}
            trailing={
              <OrganizationStatus
                tone="neutral"
                label={t[
                  "com.myoxus.settings.workspace.organization.status.none"
                ]()}
              />
            }
          />
        ) : (
          <SettingsControlList
            data-myoxus-ui-role="settings-organization-list"
            role="list"
          >
            {myLinks.map((l) => {
              const relationship = relationshipTone(l.relationship, t);
              const unitName = organizationUnitDisplayName(l, t);
              return (
                <OrganizationListItem
                  key={`${l.unitId}-${l.workspaceId}-${l.relationship}`}
                  inList
                  name={
                    l.workspaceName ||
                    t[
                      "com.myoxus.settings.workspace.organization.workspaces.unknown"
                    ]()
                  }
                  desc={`${t[
                    "com.myoxus.settings.workspace.organization.members.unit-label"
                  ]()}: ${unitName}`}
                  trailing={
                    <OrganizationStatus
                      tone={relationship.tone}
                      label={relationship.label}
                    />
                  }
                />
              );
            })}
          </SettingsControlList>
        )}
      </SettingsSection>

      {/* CREATE PROJECT */}
      <SettingsSection
        title={t[
          "com.myoxus.settings.workspace.organization.create-project.title"
        ]()}
      >
        <SettingsDefinitionList>
          <SettingsDefinitionItem
            label={t[
              "com.myoxus.settings.workspace.organization.create-project.policy-root"
            ]()}
          >
            <OrganizationStatus
              tone={rootDecision.tone}
              label={rootDecision.label}
            />
          </SettingsDefinitionItem>
          <SettingsDefinitionItem
            label={t[
              "com.myoxus.settings.workspace.organization.create-project.policy-unit"
            ]()}
          >
            {projectUnit ? (
              <OrganizationStatus
                tone={unitDecision.tone}
                label={unitDecision.label}
              />
            ) : (
              <OrganizationStatus
                tone="neutral"
                label={t[
                  "com.myoxus.settings.workspace.organization.status.empty"
                ]()}
              />
            )}
          </SettingsDefinitionItem>
        </SettingsDefinitionList>
        <Stack>
          <FormRow
            label={t[
              "com.myoxus.settings.workspace.organization.create-project.name-placeholder"
            ]()}
          >
            <Input
              aria-label={t[
                "com.myoxus.settings.workspace.organization.create-project.name-placeholder"
              ]()}
              block
              value={projectName}
              onChange={setProjectName}
              placeholder={t[
                "com.myoxus.settings.workspace.organization.create-project.name-placeholder"
              ]()}
              data-testid="organization-create-project-name"
            />
          </FormRow>
          <FormRow
            label={t[
              "com.myoxus.settings.workspace.organization.create-project.scope-label"
            ]()}
          >
            <FormSelect
              aria-label={t[
                "com.myoxus.settings.workspace.organization.create-project.scope-label"
              ]()}
              value={projectUnit || ROOT_PROJECT_SCOPE_VALUE}
              onChange={(value) =>
                setProjectUnit(value === ROOT_PROJECT_SCOPE_VALUE ? "" : value)
              }
              data={projectScopeOptions}
              data-testid="organization-create-project-unit"
            />
          </FormRow>
          <SettingsToolbar justify="flex-start" aria-live="polite">
            <Button
              data-testid="organization-create-project-submit"
              disabled={!projectName || createProject.isMutating}
              onClick={async () => {
                try {
                  await createProject.trigger({
                    input: {
                      proposedName: projectName,
                      parentUnitId: projectUnit || null,
                    },
                  });
                  setProjectName("");
                } catch (error) {
                  console.error("create project failed", error);
                }
              }}
            >
              {t[
                "com.myoxus.settings.workspace.organization.create-project.submit"
              ]()}
            </Button>
            {createProject.data?.createOrganizationProject ? (
              <SettingsStatusText tone="active">
                {t[
                  "com.myoxus.settings.workspace.organization.create-project.last-result"
                ]()}
                {": "}
                <OrganizationStatus
                  tone={
                    decisionTone(
                      createProject.data.createOrganizationProject
                        .decision as ProjectCreationDecisionEnum,
                      t,
                    ).tone
                  }
                  label={
                    decisionTone(
                      createProject.data.createOrganizationProject
                        .decision as ProjectCreationDecisionEnum,
                      t,
                    ).label
                  }
                />
              </SettingsStatusText>
            ) : null}
          </SettingsToolbar>
        </Stack>
      </SettingsSection>

      {/* CREATE WORKSPACE IN OU */}
      <SettingsSection
        title={t[
          "com.myoxus.settings.workspace.organization.create-workspace.title"
        ]()}
      >
        <OrganizationListItem
          name={t[
            "com.myoxus.settings.workspace.organization.create-workspace.policy"
          ]()}
          trailing={
            workspaceUnit ? (
              wsDecisionData?.canCreateWorkspaceInOrganizationUnit ? (
                <OrganizationStatus
                  tone="success"
                  label={t[
                    "com.myoxus.settings.workspace.organization.policy.allowed"
                  ]()}
                />
              ) : (
                <OrganizationStatus
                  tone="error"
                  label={t[
                    "com.myoxus.settings.workspace.organization.policy.denied"
                  ]()}
                />
              )
            ) : (
              <OrganizationStatus
                tone="neutral"
                label={t[
                  "com.myoxus.settings.workspace.organization.status.empty"
                ]()}
              />
            )
          }
        />
        <Stack>
          <FormRow label={t["Workspace Name"]()}>
            <Input
              aria-label={t["Workspace Name"]()}
              block
              value={workspaceName}
              onChange={setWorkspaceName}
              placeholder={t["Workspace Name"]()}
              data-testid="organization-create-ws-name"
            />
          </FormRow>
          <FormRow
            label={t[
              "com.myoxus.settings.workspace.organization.create-workspace.unit-label"
            ]()}
          >
            <FormSelect
              aria-label={t[
                "com.myoxus.settings.workspace.organization.create-workspace.unit-label"
              ]()}
              value={workspaceUnit || null}
              onChange={setWorkspaceUnit}
              data={organizationUnitOptions}
              placeholder={t[
                "com.myoxus.settings.workspace.organization.create-workspace.unit-placeholder"
              ]()}
              data-testid="organization-create-ws-unit"
            />
          </FormRow>
          <SettingsToolbar justify="flex-start">
            <Button
              data-testid="organization-create-ws-submit"
              disabled={
                !workspaceUnit ||
                !workspaceName.trim() ||
                createWorkspace.isMutating
              }
              onClick={async () => {
                try {
                  await createWorkspace.trigger({
                    input: {
                      unitId: workspaceUnit,
                      name: workspaceName.trim(),
                    },
                  });
                  setWorkspaceName("");
                  setWorkspaceUnit("");
                  await Promise.all([refetchUnits(), refetchLinks()]);
                } catch (error) {
                  console.error("create workspace in OU failed", error);
                }
              }}
            >
              {t[
                "com.myoxus.settings.workspace.organization.create-workspace.submit"
              ]()}
            </Button>
          </SettingsToolbar>
        </Stack>
      </SettingsSection>

      {/* MEMBERS — manager-scoped CRUD, scoped to OUs the caller manages. */}
      <SettingsSection
        title={t["com.myoxus.settings.workspace.organization.members.title"]()}
        description={t[
          "com.myoxus.settings.workspace.organization.members.notice.description"
        ]()}
      >
        <Stack>
          <FormRow
            label={t[
              "com.myoxus.settings.workspace.organization.members.unit-label"
            ]()}
          >
            <FormSelect
              aria-label={t[
                "com.myoxus.settings.workspace.organization.members.unit-label"
              ]()}
              value={memberUnit || null}
              onChange={(value) => {
                setMemberUnit(value);
                setMemberUserSearch("");
                setSelectedMemberUser(null);
              }}
              data={organizationUnitOptions}
              placeholder={t[
                "com.myoxus.settings.workspace.organization.members.unit-placeholder"
              ]()}
              data-testid="organization-member-unit"
            />
          </FormRow>

          {memberUnit ? (
            <>
              <FormRow
                label={t[
                  "com.myoxus.settings.workspace.organization.members.user-label"
                ]()}
              >
                <Input
                  aria-label={t[
                    "com.myoxus.settings.workspace.organization.members.user-label"
                  ]()}
                  block
                  value={memberUserSearch}
                  onChange={(value) => {
                    setMemberUserSearch(value);
                    setSelectedMemberUser(null);
                  }}
                  placeholder={t[
                    "com.myoxus.settings.workspace.organization.members.user-search-placeholder"
                  ]()}
                  data-testid="organization-member-user-search"
                />
                {userSearchEnabled ? (
                  userSearchResults.length > 0 ? (
                    <SuggestionList>
                      {userSearchResults.map((user) => {
                        const label = searchUserLabel(user, t);
                        return (
                          <SuggestionListItemButton
                            key={user.id}
                            data-testid="organization-member-user-option"
                            onMouseDown={(event) => {
                              event.preventDefault();
                              setSelectedMemberUser({
                                id: user.id,
                                label,
                                email: user.email,
                              });
                              setMemberUserSearch(`${label} · ${user.email}`);
                            }}
                          >
                            <SettingsListItemTitle>
                              {label}
                            </SettingsListItemTitle>
                            <SettingsListItemMeta breakAnywhere>
                              {user.email}
                            </SettingsListItemMeta>
                          </SuggestionListItemButton>
                        );
                      })}
                    </SuggestionList>
                  ) : (
                    <SettingsControlEmpty>
                      {t[
                        "com.myoxus.settings.workspace.organization.members.user-search-empty"
                      ]()}
                    </SettingsControlEmpty>
                  )
                ) : null}
                {selectedMemberUser ? (
                  <SettingsStatusText
                    tone="active"
                    data-testid="organization-member-selected-user"
                  >
                    {t[
                      "com.myoxus.settings.workspace.organization.members.selected-user"
                    ]()}
                    {": "}
                    {selectedMemberUser.label}
                    {" · "}
                    {selectedMemberUser.email}
                  </SettingsStatusText>
                ) : null}
              </FormRow>
              <FormRow
                label={t[
                  "com.myoxus.settings.workspace.organization.members.role-label"
                ]()}
              >
                <FormSelect
                  aria-label={t[
                    "com.myoxus.settings.workspace.organization.members.role-label"
                  ]()}
                  value={memberRole}
                  onChange={(value) =>
                    setMemberRole(value as OrganizationUnitRoleEnum)
                  }
                  data={[
                    {
                      value: OrganizationUnitRoleEnum.Reader,
                      label:
                        t[
                          "com.myoxus.settings.workspace.organization.members.role.reader"
                        ](),
                    },
                    {
                      value: OrganizationUnitRoleEnum.Member,
                      label:
                        t[
                          "com.myoxus.settings.workspace.organization.members.role.member"
                        ](),
                    },
                  ]}
                  data-testid="organization-member-role"
                />
              </FormRow>
              <SettingsToolbar justify="flex-start">
                <Button
                  data-testid="organization-member-add"
                  disabled={!selectedMemberUser || addMember.isMutating}
                  onClick={async () => {
                    if (!selectedMemberUser) return;
                    try {
                      await addMember.trigger({
                        unitId: memberUnit,
                        userId: selectedMemberUser.id,
                        role: memberRole,
                      });
                      setMemberUserSearch("");
                      setSelectedMemberUser(null);
                      await refetchMembers();
                    } catch (error) {
                      console.error("add OU member failed", error);
                    }
                  }}
                >
                  {t[
                    "com.myoxus.settings.workspace.organization.members.action.add"
                  ]()}
                </Button>
              </SettingsToolbar>
            </>
          ) : null}
        </Stack>

        {memberUnit ? (
          myMembers.length > 0 ? (
            <TableScrollContainer data-myoxus-ui-role="settings-organization-member-table-scroll">
              <Table
                withTableBorder={false}
                withColumnBorders={false}
                verticalSpacing="sm"
                data-myoxus-ui-role="settings-organization-member-table"
              >
                <TableHeader>
                  <TableRow data-myoxus-ui-role="settings-table-header-row">
                    <TableHead>
                      {t[
                        "com.myoxus.settings.workspace.organization.members.user-label"
                      ]()}
                    </TableHead>
                    <TableHead>
                      {t[
                        "com.myoxus.settings.workspace.organization.members.role-label"
                      ]()}
                    </TableHead>
                    <TableHead>
                      {t[
                        "com.myoxus.settings.workspace.organization.members.source-label"
                      ]()}
                    </TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {myMembers.map((m) => {
                    const role = roleTone(m.role, t);
                    return (
                      <TableRow
                        key={`${m.unitId}-${m.userId}`}
                        data-myoxus-ui-role="settings-table-data-row"
                      >
                        <TableCell>
                          <SurfaceListItemMain compact>
                            <SettingsListItemTitle>
                              {userLabel(m, t)}
                            </SettingsListItemTitle>
                            {m.userEmail ? (
                              <SettingsListItemMeta breakAnywhere>
                                {m.userEmail}
                              </SettingsListItemMeta>
                            ) : null}
                          </SurfaceListItemMain>
                        </TableCell>
                        <TableCell>
                          <OrganizationStatus
                            tone={role.tone}
                            label={role.label}
                          />
                        </TableCell>
                        <TableCell muted>{sourceLabel(m.source, t)}</TableCell>
                        <TableCell>
                          <Button
                            data-myoxus-ui-role="button:compact"
                            data-testid="organization-member-remove"
                            disabled={
                              m.role === OrganizationUnitRoleEnum.Manager ||
                              removeMember.isMutating
                            }
                            onClick={async () => {
                              try {
                                await removeMember.trigger({
                                  unitId: m.unitId,
                                  userId: m.userId,
                                });
                                await refetchMembers();
                              } catch (error) {
                                console.error("remove OU member failed", error);
                              }
                            }}
                            variant="error"
                          >
                            {t[
                              "com.myoxus.settings.workspace.organization.members.action.remove"
                            ]()}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableScrollContainer>
          ) : (
            <OrganizationListItem
              name={t[
                "com.myoxus.settings.workspace.organization.members.empty"
              ]()}
              desc={t[
                "com.myoxus.settings.workspace.organization.members.empty-desc"
              ]()}
              trailing={
                <OrganizationStatus
                  tone="neutral"
                  label={t[
                    "com.myoxus.settings.workspace.organization.status.empty"
                  ]()}
                />
              }
            />
          )
        ) : null}
      </SettingsSection>

      {/* AUDIT LOG (ORG-G-06) */}
      <SettingsSection
        title={t["com.myoxus.settings.workspace.organization.audit.title"]()}
      >
        {myUnits.length === 0 ? (
          <OrganizationListItem
            name={t["com.myoxus.settings.workspace.organization.audit.empty"]()}
            desc={t[
              "com.myoxus.settings.workspace.organization.audit.empty-desc"
            ]()}
            trailing={
              <OrganizationStatus
                tone="neutral"
                label={t[
                  "com.myoxus.settings.workspace.organization.status.empty"
                ]()}
              />
            }
          />
        ) : (
          <Stack data-myoxus-ui-role="settings-organization-audit-stack">
            <FormRow
              label={t[
                "com.myoxus.settings.workspace.organization.audit.unit-label"
              ]()}
            >
              <FormSelect
                aria-label={t[
                  "com.myoxus.settings.workspace.organization.audit.unit-label"
                ]()}
                value={auditUnit || null}
                onChange={setAuditUnit}
                data={organizationUnitOptions}
                placeholder={t[
                  "com.myoxus.settings.workspace.organization.members.unit-placeholder"
                ]()}
              />
            </FormRow>
            {myAudit.length === 0 ? (
              <OrganizationListItem
                name={t[
                  "com.myoxus.settings.workspace.organization.audit.no-entries"
                ]()}
                desc={t[
                  "com.myoxus.settings.workspace.organization.audit.no-entries-desc"
                ]()}
                trailing={
                  <OrganizationStatus
                    tone="neutral"
                    label={t[
                      "com.myoxus.settings.workspace.organization.status.empty"
                    ]()}
                  />
                }
              />
            ) : (
              <SettingsControlList
                data-myoxus-ui-role="settings-organization-list"
                role="list"
              >
                {myAudit.map((entry) => {
                  const targetLabel = auditTargetLabel(entry.target, t);
                  const auditMeta = [
                    formatAuditDate(t.language, entry.createdAt),
                    entry.actor?.label,
                    targetLabel,
                  ].filter(Boolean);
                  return (
                    <OrganizationListItem
                      key={entry.id}
                      inList
                      name={auditEventLabel(entry.eventKey, t)}
                      desc={auditMeta.join(" · ")}
                      trailing={
                        <OrganizationStatus
                          tone="info"
                          label={auditCategoryLabel(entry.category, t)}
                        />
                      }
                    />
                  );
                })}
              </SettingsControlList>
            )}
          </Stack>
        )}
      </SettingsSection>
    </SettingsPage>
  );
};
