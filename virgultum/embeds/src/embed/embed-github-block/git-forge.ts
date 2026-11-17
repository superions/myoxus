import {
  forgejoGiteaUrlRegex,
  gitForgeUrlRegex,
  gitlabUrlRegex,
  githubUrlRegex,
} from "./embed-github-model.js";

export { gitForgeUrlRegex };

/**
 * Resource identity of a Git forge card, resolved from the card's source
 * URL. The field names follow the historical persisted model fields
 * (`owner`, `repo`, `githubType`, `githubId`) shared by all providers;
 * `owner` may hold a group path for providers that have nested groups.
 */
export type GitForgeUrlIdentity = {
  owner: string;
  repo: string;
  githubType: "issue" | "pr";
  githubId: string;
};

/**
 * Presentation targets of a Git forge card, derived from its source URL.
 *
 * These are display values only and are never persisted.
 */
export type GitForgeUrlTargets = {
  /** Host rendered in the card footer. */
  host: string;
  /** Base of assignee profile links. */
  profileOrigin: string;
};

/**
 * Confirmed provider family of a Git forge URL, resolved on the client.
 */
export type GitForgeFamily = "GitHub" | "GitLab" | "Forgejo/Gitea";

/**
 * Resolve the persisted card identity (owner, repo, type, number) from a
 * GitHub issue or pull request URL.
 *
 * @returns the identity, or `null` when `url` is not a GitHub issue or pull
 * request link.
 */
export function parseGithubUrl(url: string): GitForgeUrlIdentity | null {
  const match = githubUrlRegex.exec(url);
  if (!match) return null;
  const [, owner, repo, githubType, githubId] = match;
  return {
    owner,
    repo,
    githubType: githubType === "issue" ? "issue" : "pr",
    githubId,
  };
}

/**
 * Resolve the persisted card identity from a GitLab issue or merge request
 * URL. `owner` holds the (possibly nested) group path; a top-level project
 * yields an empty owner.
 *
 * @returns the identity, or `null` when `url` is not a GitLab resource link.
 */
export function parseGitLabUrl(url: string): GitForgeUrlIdentity | null {
  const match = gitlabUrlRegex.exec(url);
  if (!match) return null;
  const [, projectPath, kind, number] = match;
  const segments = projectPath.split("/");
  const repo = segments[segments.length - 1];
  if (!repo) return null;
  return {
    owner: segments.slice(0, -1).join("/"),
    repo,
    githubType: kind === "issues" ? "issue" : "pr",
    githubId: number,
  };
}

/**
 * Resolve the persisted card identity from a Forgejo/Gitea issue or pull
 * request URL.
 *
 * @returns the identity, or `null` when `url` is not a Forgejo/Gitea
 * resource link.
 */
export function parseForgejoGiteaUrl(url: string): GitForgeUrlIdentity | null {
  const match = forgejoGiteaUrlRegex.exec(url);
  if (!match) return null;
  const [, owner, repo, kind, number] = match;
  return {
    owner,
    repo,
    githubType: kind === "issues" ? "issue" : "pr",
    githubId: number,
  };
}

/**
 * Resolve the persisted card identity from any Git forge URL. GitHub is
 * tried first, then GitLab (its `/-/` marker distinguishes it from the
 * Forgejo/Gitea shape), then Forgejo/Gitea.
 *
 * @returns the identity, or `null` when no provider shape matches.
 */
export function parseGitForgeUrl(url: string): GitForgeUrlIdentity | null {
  return (
    parseGithubUrl(url) ?? parseGitLabUrl(url) ?? parseForgejoGiteaUrl(url)
  );
}

/**
 * Resolve the provider family of a Git forge URL.
 *
 * @returns the family, or `null` when no provider shape matches.
 */
export function resolveGitForgeFamily(url: string): GitForgeFamily | null {
  if (parseGithubUrl(url) !== null) return "GitHub";
  if (parseGitLabUrl(url) !== null) return "GitLab";
  if (parseForgejoGiteaUrl(url) !== null) return "Forgejo/Gitea";
  return null;
}

/**
 * Parse a card URL with the native `URL` parser. URLs may omit the scheme;
 * those are parsed as `https`. Supports bracketed IPv6 authorities, local
 * addresses and explicit ports.
 */
export function parseCardUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    try {
      return new URL(`https://${url}`);
    } catch {
      return null;
    }
  }
}

/**
 * Resolve the footer host and assignee profile origin for a Git forge card
 * URL.
 *
 * Only URLs that resolve to a known provider return targets; a matching URL
 * shape is a candidate, not proof of the remote product. GitHub URLs are
 * normalized to the bare `github.com` host so `www`-prefixed URLs render
 * exactly like today. GitLab and Forgejo/Gitea URLs use their own origin
 * (including local addresses, explicit ports and bracketed IPv6 hosts).
 */
export function resolveGitForgeTargets(url: string): GitForgeUrlTargets | null {
  const family = resolveGitForgeFamily(url);
  if (family === null) return null;
  if (family === "GitHub") {
    return { host: "github.com", profileOrigin: "https://www.github.com" };
  }
  const parsed = parseCardUrl(url);
  if (!parsed) return null;
  return { host: parsed.host, profileOrigin: parsed.origin };
}
