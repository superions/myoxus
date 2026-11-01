import { matchPath } from "react-router";

export function routeFactory(path: string) {
  // Only whole, required parameter segments are authored in routes.json.
  // Fail rather than silently drop unsupported optional/splat parameters.
  if (
    !path
      .split("/")
      .every((segment) => !/[:*?{}]/.test(segment) || /^:\w+$/.test(segment))
  ) {
    throw new Error(`Unsupported route pattern: ${path}`);
  }
  const match = matchPath(path, path);
  if (!match) throw new Error(`Invalid route: ${path}`);
  const names = Object.keys(match.params);
  // Existing factories interpolate raw IDs; generatePath would URI-encode them.
  const factory = path
    .split("/")
    .map((segment) =>
      names.includes(segment.slice(1)) && segment.startsWith(":")
        ? `\${params.${segment.slice(1)}}`
        : segment,
    )
    .join("/");
  const type = names.length
    ? `{ ${names.map((name) => `${name}: string`).join("; ")} }`
    : undefined;
  return { type, factory };
}
