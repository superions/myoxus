<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Organization and workspace administration

[Documentation](../../README.md) / [Operations](../README.md) / [Administration](./README.md)

Manage your organization through the **Admin frontend**. Create the structure
that fits your departments, teams and projects, assign people and connect their
shared workspaces. **Security → OAuth** connects your identity provider and maps
SSO groups to that structure.

Every user has an automatically provided personal workspace. Shared workspaces
sit alongside it: a department can use several, and a workspace can serve one
project, a portfolio or a cross-team topic. Organizational units provide the
management structure around those working areas.

<details>
<summary>On this page</summary>

- [Where to go in Admin](#where-to-go-in-admin)
- [Set up the organization](#set-up-the-organization)
- [Members and managers](#members-and-managers)
- [Assigning workspaces to an OU](#assigning-workspaces-to-an-ou)
- [SSO and group mapping](#sso-and-group-mapping)
- [Project and workspace creation by managers](#project-and-workspace-creation-by-managers)
- [Import and export](#import-and-export)
- [Safe status changes and deletion](#safe-status-changes-and-deletion)
- [Troubleshooting](#troubleshooting)

</details>

## Where to go in Admin

Open the Admin frontend at `/adminfrontend` and sign in with a global Admin
account. **Organization** and **Security** are in the **Governance** navigation
group. The labels below follow the English interface.

| What you want to do                                             | Admin location                                    |
| --------------------------------------------------------------- | ------------------------------------------------- |
| Set the organization name and slug                              | **Organization → Overview**                       |
| Choose a structure model or create custom unit types            | **Organization → Unit types**                     |
| Create and edit departments, teams or project units             | **Organization → Units**                          |
| Navigate the hierarchy visually                                 | **Organization → Organigram**                     |
| Find users, inspect capabilities and organizational memberships | **Organization → Members**                        |
| Add people or assign shared workspaces to a unit                | Open the unit, then **Members** or **Workspaces** |
| Set manager permissions and project approval rules              | **Organization → Policy**                         |
| Approve or reject project requests                              | **Organization → Requests**                       |
| Export the structure or import a JSON snapshot                  | **Organization → Import / Export**                |
| Connect SSO and map provider groups to units                    | **Security → OAuth → OIDC**                       |

For scripts and integrations, use the separate
[Administration via API](../../api/server/administration.md) reference.

## Set up the organization

### Organization name

Open **Organization → Overview**, edit the name and slug, then save. The
organization key is shown for identification and remains unchanged. The default
organization and the bundled unit types are created during server provisioning.

### Choose a structure model

Open **Organization → Unit types** and select the **Active organization model**
that fits your installation.

| Model                              | Intended structure                                      |
| ---------------------------------- | ------------------------------------------------------- |
| **Default**                        | General teams, departments and project units            |
| **Large municipal administration** | The bundled model for larger municipal organizations    |
| **Small municipal administration** | The bundled model for smaller municipal organizations   |
| **Deep business hierarchy**        | A business structure with several organizational levels |
| **Matrix / Project**               | A matrix or project-oriented structure                  |
| **All**                            | All active preset and custom types                      |

The selection controls which types appear in unit forms. It does not delete
units or change existing assignments. Units using a type outside the selected
model remain available for editing.

Use **Create unit type** to add a custom type. Give it a stable key and display
label, then choose its capabilities: for example, whether it can have children,
appear at the root or own and manage workspaces. Choose **All** to make custom
types available in the unit forms. Bundled preset types remain server-maintained.

### Create and arrange units

1. Open **Organization → Units** and choose **Create unit**.
2. Enter the name and slug, choose the type and select a parent, or place the
   unit at the root.
3. Save, then select the unit to open its details.
4. Use **Master data** to change its name, type, parent or status. Save the
   changes explicitly.

Use **Organigram** to navigate the same hierarchy visually. Selecting a unit
opens the same detail view used by the Units list. A unit cannot become its own
parent or be moved below one of its descendants.

The Units list initially shows active units. Change the status filter to find
disabled or archived entries.

## Members and managers

Use **Organization → Members** to find a person by name or email, inspect the
account and review its organizational memberships. User details also expose
global capabilities and account activity.

To assign a person to a particular unit:

1. Open the unit through **Units** or **Organigram**.
2. Select **Members** and search for the person.
3. Choose **Reader**, **Member** or **Manager**, then add the membership.
4. Review its role and **Source** in the list. Existing rows offer role changes
   and a removal action.

| Role        | Meaning                                                       |
| ----------- | ------------------------------------------------------------- |
| **Reader**  | Read-oriented participation in the unit                       |
| **Member**  | Participation in the unit's shared work                       |
| **Manager** | Scoped management of the unit, subject to organization policy |

An organizational role and a direct workspace role are different assignments.
The server derives access from the applicable relationships; adding an OU
membership does not create a separate direct workspace membership.

Assign managers through the unit's membership controls or an OIDC manager
mapping. Myoxus maintains the accompanying Manager capability automatically.
A global Manager capability alone is insufficient: the person also needs a
Manager membership in the relevant active unit. A unit manager does not become
a global Admin or the workspace owner.

## Assigning workspaces to an OU

Open a unit's **Workspaces** tab, select an existing workspace, choose the
relationship and add it. Existing relationships can be changed in the list.
A unit can have multiple workspace relationships, and a workspace can be linked
to several units.

| Relationship | Meaning                                                              | Example                                                    |
| ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Owner**    | The unit owns the workspace; a workspace has at most one owning unit | Engineering owns its shared service documentation          |
| **Managed**  | The unit manages the workspace without owning it                     | A central operations team manages a department's workspace |
| **Linked**   | An informational association without management authority            | Several departments reference a common project workspace   |

Changing the owning unit transfers ownership; the previous owning unit remains
attached as **Managed**. Check the workspace's members and applicable unit roles
when validating access. Personal workspace ownership remains with its user.

Use the Admin **Workspaces** area for direct workspace membership and content
administration. Central template distribution is covered in the
[Template Registry guide](../integrations/template-registry.md).

## SSO and group mapping

SSO authenticates a person through your identity provider. **Group mapping**
adds that person to matching Myoxus organizational units during login.
Configure the provider under **Security → OAuth**, and manage the target units
under **Organization**.

### Connect the identity provider

1. Create the target departments, teams or project units in **Organization**.
2. Register a confidential OpenID Connect client in your identity provider.
   Its redirect URI is your browser-facing Myoxus origin followed by
   `/api/oauth/callback`.
3. In **Security → OAuth**, expand **OIDC**. Enter the client ID,
   client secret and issuer URL.
4. Choose **Authentik**, **Keycloak** or **Custom** under **Provider preset**.
   For a preset, use **Apply preset endpoints** and review the derived discovery,
   authorization, token, UserInfo and JWKS endpoints.
5. Configure scopes and **Claim mappings** for the values your provider sends.
   The normal identity scopes are `openid`, `profile` and `email`. Ensure the
   provider also emits its group claim when you use group mapping.
6. Save the provider configuration.

Presets fill conventional endpoints and claim defaults. Configure the client,
scopes and group claim on the provider side as well. The
[authentication guide](../security/authentication.md#oauthoidc) covers Authentik,
Keycloak, certificates and provider-specific setup.

### Map groups to units

In **Claim mappings**, set **Groups field** to the claim name and choose
**Groups source**: **UserInfo**, **ID token** or **UserInfo and ID token**.
Then expand **Group to organization unit mapping**:

1. Enable **Synchronize OIDC groups into organization units**.
2. Choose a **Default role**, usually **Member**.
3. Add a rule for each provider group. Enter its group value, select the target
   unit through the search picker and choose the role.
4. Set the missing-group, unknown-group and membership-removal policies.
5. Save and test with a representative account.

Security and Setup keep every mapping row in the draft. A missing group, missing
target unit or invalid role blocks Save and identifies the affected row; correct
it or remove it explicitly. Incomplete rows are never silently filtered out of
the saved configuration. Editing a group value keeps input focus, and rejected
saves retain the complete draft. A manually entered or previously saved group
is not invalid merely because directory lookup does not contain it. Server-side
configuration, target and login checks remain authoritative.

Saved target pickers resolve the OU name and parent-name breadcrumb again after
reload, including inactive OUs. If identical breadcrumbs remain (for example,
same-name siblings), the unit slug distinguishes them. UUIDs remain the saved
identity; labels do not change the mapping target or its role. A target absent
from the inventory is shown as **Target unavailable** with its retained UUID,
not silently removed or assigned a guessed name. Correct or remove that rule
explicitly. Showing an inactive target does not authorize login or assignment to
it; normal server-side lifecycle and access checks still apply.

To select a provider group, first save **Provider group directory** read access,
then choose **Load groups** above the mapping table. **Refresh** explicitly reads
the saved connection again. Search matches loaded names, paths and claim values
locally; typing a search is not a mapping change and makes no provider request.
Choose a result by pointer or the arrow keys and Enter. Escape/Tab leaves the
existing claim value unchanged. Only the result's normalized login claim value
is saved, never its provider catalog ID. Ambiguous/incompatible results cannot
be selected; existing unknown or deleted values are retained.

Use **Enter group manually** for transformed login claims or when catalog access
is unavailable. Manual input changes only that rule; no catalog match is required.
An unconfigured directory, a catalog not loaded yet, loading, an empty catalog,
no search matches and failed reads have separate feedback. A failed read never
clears rules or logs the operator out of Admin. Connection edits must be saved
or discarded before loading; save/remove/change retires the old catalog and
late responses. Afterward load the current saved connection explicitly.

| Example provider group | Target unit   | Role    |
| ---------------------- | ------------- | ------- |
| `dept-finance`         | Finance       | Member  |
| `finance/managers`     | Finance       | Manager |
| `project-atlas`        | Atlas project | Member  |
| `architecture-readers` | Architecture  | Reader  |

Use the values your provider actually emits. Leading slashes in path-style
groups are normalized, so `/finance/managers` matches `finance/managers`.
Mappings select existing units; they do not create departments or workspaces.

| Setting                                                              | What it controls                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Missing groups policy**                                            | Deny login when the configured claim is absent, or allow login without group-derived memberships |
| **Unknown groups policy**                                            | Ignore unmapped groups, or deny login if an unmapped group is present                            |
| **Remove OIDC memberships that are missing from the provider claim** | Remove stale OIDC-owned unit memberships at the next successful login                            |

Mapping synchronizes organizational memberships, rather than direct workspace
roles or global Admin rights. Access to unit-owned workspaces follows the
server's organizational permission rules. A Manager mapping uses the same
scoped model as an assignment in the Organization page.

### Test and verify the result

Use **Sample claims JSON** and **Test OIDC provider** to check discovery, JWKS
and group mapping. Review the diagnostic counts and warnings. Sample claims
exercise the mapping; they do not prove what the provider sends in a real login.

Sign in with a test user through the normal SSO flow, then inspect the person
under **Organization → Members** or in the unit's **Members** tab. Confirm the
role, the **OIDC** source and access to the intended shared workspaces. To test
group removal, change the provider membership, sign in again and confirm that
only the expected OIDC memberships disappear.

### Choose the membership source deliberately

| Source     | How to maintain it                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| **Manual** | Maintain in Admin; OIDC reconciliation preserves it                              |
| **Import** | Maintain through organization snapshot import; OIDC reconciliation preserves it  |
| **OIDC**   | Maintain through provider groups and mapping rules; reconciliation runs at login |

OIDC preserves memberships owned by other sources. If a manual or imported
membership exists for the same person and unit, an OIDC rule does not replace
its role. Review **Source** before changing the access model. A local role
change on an OIDC-owned membership can be reset by the next login.

LDAP and SCIM are reserved source values in the data model; this organization
integration currently synchronizes groups through OIDC. For a directory-backed
setup, configure its groups in your OIDC identity provider and map the emitted
claim here.

## Project and workspace creation by managers

Open **Organization → Policy** to set project creation separately for
**Root-level projects** and **Projects inside an OU**.

| State                 | Result                                                       |
| --------------------- | ------------------------------------------------------------ |
| **Disabled**          | Managers cannot create projects in this scope                |
| **Requires approval** | A project request goes to an Admin for a decision            |
| **Allowed**           | Managers can create projects directly in the permitted scope |

Workspace creation and OU member management have separate switches:
**Manager may create workspaces** and **Manager may manage OU members**.
They are not three-state project policies. Set the values and save.

Open **Organization → Requests** to review pending requests. Check the proposed
name, requester and scope, then **Approve** or **Reject**. The list also shows
completed decisions.

## Import and export

Use **Organization → Import / Export** for a reusable organization snapshot.

1. Download the **JSON** snapshot before a larger structural change. The
   export area also offers individual CSV projections.
2. Upload a JSON snapshot or paste its contents to import in Admin.
3. Run **Dry-run**, inspect errors and correct the input.
4. Apply the exact checked input once the preview is error-free. Editing the
   input requires another dry run.
5. Review the result and reload the export to confirm the resulting structure.

Admin imports JSON snapshots. The server also supports CSV import for API
integrations; see the [API interchange reference](../../api/server/administration.md#import-and-export)
for files and columns. An organization export describes settings, units,
memberships and relationships; it is not a backup of workspace content.
See [backup and restore](../data/backup-and-restore.md) for installation data.

If the export refresh fails after a successful import, use **Retry** in the
export area. The import has succeeded; another Apply is not a readback retry.

## Safe status changes and deletion

Change a unit's status in **Master data**. **Active** units participate in
organizational permissions and accept new relationships. **Disabled** and
**Archived** units remain available for inspection but are operationally inactive.

For permanent deletion, open the unit's **Settings** tab and load or refresh
the deletion preview. It lists children, members, workspace relationships,
project requests and OIDC mappings that block deletion. Resolve them through
their Admin controls, then refresh the preview.

Only an inactive unit without blockers can be deleted. Confirmation requires
the exact name and current preview. Deletion is irreversible and does not
cascade into the unit's workspaces or other records.

## Troubleshooting

| Symptom                                              | What to check in Admin                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| A unit is missing                                    | Status filter, search and parent hierarchy                                                                        |
| A type is missing from a creation form               | Active organization model; select **All** for custom types                                                        |
| A manager cannot administer a unit                   | Global Manager capability, Manager membership in that unit, active status and Policy settings                     |
| SSO works but membership is missing                  | Actual group claim, Groups field/source, mapping target, role and existing membership source                      |
| A removed provider group still grants membership     | A successful new login, removal setting, and whether Source is Manual or Import instead of OIDC                   |
| Login is denied after enabling mapping               | Missing/unknown group policy, emitted scopes and values, OIDC diagnostic warnings                                 |
| Workspace access differs from the expected unit role | Unit relationship, active status and direct workspace membership; **Linked** alone grants no management authority |
| A unit cannot be deleted                             | Current Settings deletion preview and its blockers                                                                |
| Import succeeded but export failed                   | Retry the export readback rather than applying again                                                              |

Related guides: [authentication and SSO](../security/authentication.md),
[Administration via API](../../api/server/administration.md),
[local CLI operations](./cli.md) and
[central templates](../integrations/template-registry.md).
