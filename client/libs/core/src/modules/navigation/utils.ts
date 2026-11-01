import { channelToScheme } from "@myoxus/core/utils";
import type { ReferenceParams } from "@virgultum/editor/model";
import { isNil, pick, pickBy } from "lodash-es";
import { parseNavigationQuery } from "../../utils/navigation-query";

function maybeMyoxusOrigin(origin: string, baseUrl: string) {
  return origin.startsWith("assets://") || origin === baseUrl;
}

export const resolveRouteLinkMeta = (
  href: string,
  baseUrl = location.origin,
) => {
  try {
    // Normalize the desktop scheme for URL parsing.
    const appProtocol = channelToScheme[BUILD_CONFIG.appBuildType] + "://";

    if (href.startsWith(appProtocol)) {
      href = href.replace(appProtocol, "http://");
    }

    const url = new URL(href, baseUrl);

    if (!maybeMyoxusOrigin(url.origin, baseUrl)) {
      return null;
    }

    // http://---/workspace/{workspaceid}/xxx/yyy
    // http://---/workspace/{workspaceid}/xxx
    const [_, workspaceId, moduleName, subModuleName] =
      url.pathname.match(/\/workspace\/([^/]+)\/([^/]+)(?:\/([^/]+))?/) || [];

    if (workspaceId) {
      const basename = `/workspace/${workspaceId}`;
      const pathname = url.pathname.replace(basename, "");
      const search = url.search;
      const hash = url.hash;
      const location = {
        pathname,
        search,
        hash,
      };
      if (moduleName === "databases" && subModuleName) {
        return {
          location,
          basename,
          workspaceId,
          moduleName: "database" as const,
          databaseId: subModuleName,
        };
      } else if (isRouteModulePath(moduleName)) {
        return {
          location,
          basename,
          workspaceId,
          moduleName,
          subModuleName,
        };
      } else if (moduleName) {
        // for now we assume all other cases are doc links
        return {
          location,
          basename,
          workspaceId,
          moduleName: "doc" as const,
          docId: moduleName,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
};

const toURL = (str: string) => {
  try {
    if (!URL.canParse(str)) return null;

    return new URL(str);
  } catch {
    return null;
  }
};

export const isLink = (str: string) => {
  str = str.trim();

  let url = toURL(str);

  if (!url) {
    const hasScheme = str.match(/^https?:\/\//);
    if (!hasScheme) {
      const dotIdx = str.indexOf(".");
      if (dotIdx > 0 && dotIdx < str.length - 1) {
        url = toURL(`https://${str}`);
      }
    }
  }

  return Boolean(url);
};

export const routeModulePaths = ["all", "collection", "tag", "trash"] as const;
export type RouteModulePath = (typeof routeModulePaths)[number];

const isRouteModulePath = (
  path: string,
): path is (typeof routeModulePaths)[number] =>
  routeModulePaths.includes(path as any);

export const resolveLinkToDoc = (href: string, baseUrl?: string) => {
  const meta = resolveRouteLinkMeta(href, baseUrl);
  if (!meta || meta.moduleName !== "doc") return null;

  const params = parseDocSearchParams(meta.location.search);

  return {
    ...pick(meta, ["workspaceId", "docId"]),
    ...params,
  };
};

export const preprocessParams = (
  params: Record<string, unknown>,
): ReferenceParams & { refreshKey?: string } => {
  const result: ReferenceParams & { refreshKey?: string } = pickBy(
    params,
    (value) => {
      if (isNil(value)) return false;
      if (typeof value === "string" && value.length === 0) return false;
      if (Array.isArray(value) && value.length === 0) return false;
      return true;
    },
  );

  if (result.blockIds?.length) {
    result.blockIds = result.blockIds.filter((v) => v.length);
  }
  if (result.elementIds?.length) {
    result.elementIds = result.elementIds.filter((v) => v.length);
  }

  return pick(result, [
    "mode",
    "blockIds",
    "elementIds",
    "databaseId",
    "databaseRowId",
    "refreshKey",
    "commentId",
  ]);
};

/** Decode the document-reference fields; comma-separated selections stay arrays. */
export function parseDocSearchParams(search: string) {
  const params = parseNavigationQuery(search);
  for (const key of ["mode", "blockIds", "elementIds"]) {
    if (!Object.hasOwn(params, key)) continue;
    const transform = (value: unknown) => {
      if (value === null) return null;
      if (key === "mode")
        return value === "page" || value === "edgeless" ? value : undefined;
      return String(value).split(",").filter(Boolean);
    };
    const value = params[key];
    // Repeated document fields retain their historical per-occurrence shape.
    (params as Record<string, unknown>)[key] = Array.isArray(value)
      ? value.map(transform)
      : transform(value);
  }
  return preprocessParams(params);
}

export function toURLSearchParams(
  params?: Partial<Record<string, string | string[]>>,
) {
  if (!params) return;

  const items = Object.entries(params)
    .filter(([_, v]) => !isNil(v))
    .filter(([_, v]) => {
      if (typeof v === "string") {
        return v.length > 0;
      }
      if (Array.isArray(v)) {
        return v.length > 0;
      }
      return false;
    })
    .map(([k, v]) => [k, Array.isArray(v) ? v.filter((v) => v.length) : v]) as [
    string,
    string | string[],
  ][];

  return new URLSearchParams(
    items
      .filter(([_, v]) => v.length)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]),
  );
}

// a type safe version of toURLSearchParams for doc search params
export function toDocSearchParams(
  params?: ReferenceParams & {
    refreshKey?: string;
  },
) {
  return toURLSearchParams(params);
}
