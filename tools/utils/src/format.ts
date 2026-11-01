import { once } from "lodash-es";
import { type BuiltInParserName, format, resolveConfig } from "prettier";

import { ProjectRoot } from "./path";

const DEFAULT_PRETTIER_OPTIONS = {
  quoteProps: "preserve" as const,
  trailingComma: "all" as const,
};

const readConfig = once(async () => {
  try {
    return (await resolveConfig(ProjectRoot.join("package.json").value)) ?? {};
  } catch {
    return {};
  }
});

export async function prettier(content: string, parser: BuiltInParserName) {
  const config = await readConfig();
  return format(content, {
    ...DEFAULT_PRETTIER_OPTIONS,
    ...config,
    parser,
  });
}
