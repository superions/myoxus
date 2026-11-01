# Contributing to Myoxus

Thank you for helping improve Myoxus. Contributions are welcome when they
improve the product, its documentation, its security, or its operability and
fit the project boundaries described in [README.md](./README.md).

## Repository Roles

Forgejo is the canonical development, review, build, and release repository.
GitHub is the public source mirror and the intake surface for issues and pull
requests; maintainers integrate accepted work through the canonical Forgejo
repository. Report confidential security matters only through the process in
[SECURITY.md](./SECURITY.md), never through a public issue or pull request.

## Before You Start

1. Read the relevant developer and test documentation.
2. Search existing issues and pull requests before opening a new one.
3. For a security vulnerability, follow [SECURITY.md](./SECURITY.md) instead of
   opening a public issue.
4. For a substantial change, open an issue or design discussion first.

## Contribution Requirements

Every contribution must satisfy all of these requirements:

- It must be original work by the contributor or be submitted with documented
  permission from every rights holder.
- It must not include code, assets, fonts, documentation, or generated material
  whose license is incompatible with AGPL-3.0-or-later.
- It must not add Affine/upstream branding, undisclosed CDN assets, telemetry,
  credentials, or proprietary dependencies.
- It must preserve the server-owned business-logic boundary and the repository's
  security, privacy, and deployment contracts.
- It must include tests and documentation when the change affects behavior,
  public APIs, operations, or user-visible workflows.

The project accepts only contributions that can be distributed under
**AGPL-3.0-or-later**. Include SPDX identifiers where the repository convention
requires them and record third-party provenance for imported or generated
material.

## Rights and Contributor Agreement

Standard contributions are accepted under the project's [Developer Certificate
of Origin](./contribute/developer-certificate-of-origin), the AGPL-3.0-or-later
license, and the contributor's sign-off. By signing off, you confirm that you
have the right to submit the work under AGPL-3.0-or-later and that the project
may preserve that license when distributing the contribution.

Add the sign-off automatically with `git commit -s`. The sign-off must use your
real name and a reachable email address. A maintainer must not add a sign-off
for somebody else.

For a large code grant, a contribution from an organization, or a central
component where the project needs broader rights, maintainers may require the
separate [Contributor License Agreement](./CONTRIBUTOR_LICENSE_AGREEMENT.md).
That agreement grants, to the extent permitted by applicable law, exclusive,
worldwide, perpetual, irrevocable, transferable, sublicensable, and royalty-free
usage rights while keeping the public Myoxus codebase open source under
AGPL-3.0-or-later. A pull request alone is not a substitute for a requested
CLA.

## Pull Requests

Keep pull requests focused and explain:

- the problem and the chosen solution;
- affected server, client, deployment, or data contracts;
- tests and checks run locally;
- migration, rollback, security, and operational considerations;
- third-party code or assets introduced by the change.

Use a descriptive title. Keep generated files synchronized through their
canonical generators. Do not commit local databases, credentials, test
artifacts, build output, or editor state.

Maintainers may ask for changes, split a pull request, or close work that does
not fit the project scope. Feature requests are welcome through GitHub Issues,
but opening an issue does not create an obligation to investigate, respond to,
or implement it. Maintainers may close any issue or pull request at their sole
discretion, including without explanation. Passing automation is necessary but
does not by itself imply acceptance.

## Support and Releases

Public support is provided through GitHub Issues. Myoxus does not provide
installation, deployment, or individualized operations support. Please do not
include credentials, private data, or security vulnerabilities in public
issues.

Releases are made as needed and at least once per month. Security releases are
made as needed and are not tied to a fixed release cycle. Release timing,
contents, and availability remain at the maintainers' discretion.

## Development Checks

For a fresh public source checkout or archive, install dependencies and generate
the icon modules once before building clients:

```bash
yarn install --immutable
yarn workspace @virgultum/icons build
```

Generated icon modules are excluded from the public source. Repeat the icon
setup command after changing its inputs or removing its generated output.
Existing dependency builds, including Admin's, also run the icon generator.

`yarn build` also regenerates the GraphQL client. Use a running API from the
same source revision (`MYOXUS_CODEGEN_SERVER_ORIGIN` selects its origin), or set
`MYOXUS_GRAPHQL_SCHEMA_FILE` to the included
[versioned SDL](./docs/api/server/schema.graphql) for an offline build:

```bash
MYOXUS_GRAPHQL_SCHEMA_FILE="$PWD/docs/api/server/schema.graphql" yarn build
```

Schema changes use the native
[`export-graphql-schema` example](./server/crates/api/examples/export-graphql-schema.rs)
to refresh that SDL. Before the first Electron build, compile its native bindings
for the current host through the existing setup command:

```bash
yarn workspace @myoxus/electron native:ensure
yarn workspace @myoxus/electron build
```

Run the narrowest relevant checks first. Before submitting a substantial change,
run the applicable checks from the repository test matrix. At minimum, changed
TypeScript, Rust, TOML, and documentation files must pass the repository's
formatting and linting gates.

## Review and Merging

A maintainer reviews scope, correctness, security, provenance, tests, and
operational impact. Merges require the applicable required checks, a valid DCO
sign-off, and a CLA where one was explicitly requested. Maintainers may squash
commits and adjust
metadata without changing the substantive contribution.

## Code of Conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## License

Myoxus is licensed under [AGPL-3.0-or-later](./LICENSE). Contribution terms do
not grant permission to submit material under an incompatible license.
