# Documentation standards

[Documentation](./README.md)

Public documentation helps readers use, operate and integrate Myoxus. Keep each
page useful on its own and navigable from its owning index.

## Audiences and ownership

| Area                            | Audience        | Content                                                            |
| ------------------------------- | --------------- | ------------------------------------------------------------------ |
| [User guides](./user/README.md) | Workspace users | Handbooks, features, clients and downloads                         |
| [Operations](./ops/README.md)   | Operators       | Installation, configuration, administration and recovery           |
| [API](./api/README.md)          | Integrators     | Curated guides, generated reference and machine-readable contracts |

The nearest README owns a page's inventory entry. Keep one canonical guide for
each topic; link to it wherever supporting context is needed. Separate user
workflows, operating procedures and API examples by audience.

## Page design

| Element            | Convention                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------- |
| **Title**          | One descriptive H1, with sentence-case wording and correct product names                     |
| **Navigation**     | Relative breadcrumbs immediately below the title; a compact contents panel for long guides   |
| **Opening**        | State the task or benefit and the page's scope in a short paragraph                          |
| **Sections**       | Follow the reader's workflow; use H2 for main topics and H3 for their details                |
| **Tables**         | Compare parallel choices; keep cell text concise and give long procedures their own sections |
| **Visuals**        | Use relevant screenshots or editable SVG/Mermaid diagrams with descriptive alternatives      |
| **Examples**       | Label code fences, use current paths and keep credentials out of command arguments           |
| **Related guides** | Link to the canonical owner instead of repeating its instructions                            |

Use native Markdown headings, tables and lists. Keep expandable contents and
reference details usable in repository viewers. Diagram typography, spacing and
colors should follow the existing documentation illustrations.

## Language and content

Public guides use English; the user handbook has English and German editions
with matching chapter coverage. Keep protocol identifiers, settings and
persisted values exact. Translate explanations rather than technical keys.

Describe implemented behavior and useful operating contracts. Remove planning
notes, development-host details, phase labels, completion reports and editorial
instructions from reader-facing pages. Retain historical details only when they
explain a deployed migration, compatibility requirement or attribution.

Verify changed claims against the implementation, configuration and relevant
contracts. Keep product overviews clear and confident; place detailed format
behavior and operational diagnosis in their owning guides. Licenses, notices
and required attribution remain with their components.

## Source and generated material

Standalone implementation material belongs in the developer area. Operator
material belongs here under Operations; API and test references keep their
established owners. Source trees under `server/`, `client/` and `virgultum/`
contain source comments and legal notices, rather than standalone README guides.

Change generated documentation through its generator. Handbook pages come from
their editorial source; GraphQL pages come from the compiled server schema.
Update a documented contract and its owning index together.

## Links and verification

Use current repository paths and relative links. Local paths and heading anchors
must resolve in both the working tree and the extracted public source archive.
Public pages must remain independent of files excluded from that archive.

The canonical documentation gate checks links, index ownership, source-tree
placement, exported references and source-backed contracts:

```bash
build/scripts/test/run.sh --suite docs.consistency --strict
```

Review each changed page after editing. Finish with a second review of navigation,
claims, duplication and rendered presentation across the complete public set.
