# Myoxus review instructions

## Repository role

Forgejo is the canonical development, integration, build and release source.
GitHub contains curated public source snapshots and receives contribution
proposals. Maintainers transfer accepted changes to Forgejo and publish the
result back here. A Copilot review provides advisory feedback; it does not
authorize merging, deployment or release publication. Do not propose moving
internal development to GitHub or synchronizing private history.

## Review focus

Report concrete, actionable defects introduced by the diff. Explain the
trigger, user impact and relevant file or line. Check affected consumers and
existing tests before claiming a regression. Distinguish verified findings
from uncertainty; do not invent test results, private context or requirements.
Prefer the smallest complete correction and existing owners over new layers,
speculative safeguards, broad refactors or style-only comments.

## Architecture and product boundaries

- `server/` owns the Rust server. Domain/application code owns business rules;
  infrastructure owns persistence and API code wires authenticated operations.
  Preserve authorization, transactions and deployed data contracts. SQL
  migrations are append-only; never edit an already released migration.
- Browser Web must remain server-backed and must not create or persist local
  workspaces. Native/Electron offline behavior has its own existing contract.
- `client/admin/`, `client/web/` and shared `client/libs/` UI use Mantine through
  `@myoxus/ui-facade` and the server-owned theme. Reuse native primitives and
  semantic tokens before adding local wrappers, CSS or styling props.
- `virgultum/` is the active editor. The server-backed Database product UI lives
  outside Virgultum. Do not restore removed editor database UI, active
  BlockSuite paths, billing, subscriptions or plan-based quotas.
- Preserve stored editor/protocol identifiers unless an explicit migration owns
  the change. Regenerate GraphQL and other generated artifacts through their
  owning scripts; do not hand-edit generated files.
- User-visible copy belongs to the existing i18n resources (EN/DE/FR/ES).
  Never log credentials, tokens or raw sensitive payloads.

## Validation and contributions

- The supported toolchain is Node 26 and repository-pinned Yarn 4.18.0. Use the
  existing test matrix in `build/scripts/test/run.sh` for relevant checks.
  Prefer useful existing regression coverage over duplicate tests or new suites.
- UI verification is desktop-only. Do not request mobile/compact viewport,
  device, emulator or simulator checks. Visual changes need served desktop
  interaction and screenshots; passing source checks alone do not prove them.
- Preserve existing file licenses, attribution and third-party provenance.
  Follow `CONTRIBUTING.md` for DCO sign-off and contribution requirements.
  Never suggest copying private operational material into the public tree.
- Handle confidential vulnerability reports through `SECURITY.md`; never ask
  contributors to disclose secrets or confidential exploit details publicly.
