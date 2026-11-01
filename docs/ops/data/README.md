<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Data operations

[Documentation](../../README.md) / [Operations](../README.md)

Protect the authoritative data, manage structured records and deliver content
to readers. PostgreSQL, blobs and uploaded PDF fonts form the durable backup
set; Redis supplies rebuildable runtime state.

| Task                                                     | Guide                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Select and operate blob storage                          | [Storage](./storage.md)                                                                     |
| Create backups and prove recovery                        | [Backup and restore](./backup-and-restore.md)                                               |
| Exchange Markdown vault content                          | [Obsidian-compatible vault interchange](./backup-and-restore.md#obsidian-vault-interchange) |
| Operate records, queries and imports                     | [Databases](./databases/README.md)                                                          |
| Maintain Typst templates, fonts, profiles and validation | [PDF production](./pdf-export-templates.md)                                                 |
| Publish read-only HTML                                   | [Public publishing](./public-publishing.md)                                                 |

Portable exports serve interchange. Follow the complete backup procedure for
permissions, configuration, history and disaster recovery.
