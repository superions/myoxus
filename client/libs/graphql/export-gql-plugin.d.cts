// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CodegenPlugin } from "@graphql-codegen/plugin-helpers";

interface ExportPluginConfig {
  output: string;
}

type ExportPlugin = CodegenPlugin<ExportPluginConfig>;

export const plugin: ExportPlugin["plugin"];
export const validate: NonNullable<ExportPlugin["validate"]>;
