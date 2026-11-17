/**
 * Optional trailing query/fragment: the persisted card URL keeps the complete
 * original link, so the identity parsers must tolerate it.
 */
const trailing = "(?:[?#][^\\s]*)?$";

/**
 * Host authority on any origin, including local addresses, explicit ports and
 * bracketed IPv6 literals.
 */
const authority = "(?:[\\w.-]+|\\[[^\\]]+\\])(?::\\d+)?";

export const githubUrlRegex: RegExp = new RegExp(
  `^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/([^/]+)\\/([^/]+)\\/(issue|pull)s?\\/(\\d+)${trailing}`,
);

/**
 * GitLab: `/<group>[/<subgroup>...]/<project>/-/issues/:number` and
 * `/-/merge_requests/:number`, on any origin (including local addresses and
 * explicit ports). Captures the full project path, the resource kind and the
 * project-local number.
 */
export const gitlabUrlRegex: RegExp = new RegExp(
  `^(?:https?:\\/\\/)?${authority}/(.+)/-/(issues|merge_requests)/(\\d+)${trailing}`,
);

/**
 * Forgejo/Gitea: `/<owner>/<repo>/issues/:number` and
 * `/<owner>/<repo>/pulls/:number`, on any origin. Captures the owner, the
 * repository, the resource kind and the resource number.
 */
export const forgejoGiteaUrlRegex: RegExp = new RegExp(
  `^(?:https?:\\/\\/)?${authority}/([^/]+)/([^/]+)/(issues|pulls)/(\\d+)${trailing}`,
);

/**
 * Combined matcher for every Git forge card shape: GitHub first, then
 * GitLab, then Forgejo/Gitea. Registers the existing card for the new URL
 * candidates; a matching URL is a candidate, not proof of the remote
 * product.
 *
 * The combined regex stays anchored to the complete URL: every alternative
 * is wrapped in a non-capturing group between the shared `^` and `$`, so an
 * embedded matching substring does not select this card.
 */
export const gitForgeUrlRegex: RegExp = new RegExp(
  "^(?:" +
    [githubUrlRegex, gitlabUrlRegex, forgejoGiteaUrlRegex]
      .map((regex) => regex.source.replace(/^[\s]*\^/, "").replace(/\$$/, ""))
      .join("|") +
    ")$",
);
