import type {
  EmbedGithubBlockUrlData,
  EmbedGithubModel,
} from "@virgultum/model";
import type { LinkPreviewProvider } from "@virgultum/shared/services";
import { isAbortError } from "@virgultum/shared/utils";
import { nothing } from "lit";

import type { EmbedGithubBlockComponent } from "./embed-github-block.js";
import {
  parseCardUrl,
  parseForgejoGiteaUrl,
  parseGitLabUrl,
  resolveGitForgeFamily,
} from "./git-forge.js";
import {
  GithubIssueClosedFailureIcon,
  GithubIssueClosedSuccessIcon,
  GithubIssueOpenIcon,
  GithubPRClosedIcon,
  GithubPRDraftIcon,
  GithubPRMergedIcon,
  GithubPROpenIcon,
} from "./styles.js";

export async function queryEmbedGithubData(
  embedGithubModel: EmbedGithubModel,
  linkPreviewer: LinkPreviewProvider,
  signal?: AbortSignal,
): Promise<Partial<EmbedGithubBlockUrlData>> {
  const family = resolveGitForgeFamily(embedGithubModel.props.url);
  const [githubApiData, openGraphData] = await Promise.all([
    queryEmbedGithubApiData(embedGithubModel, signal),
    linkPreviewer.query(embedGithubModel.props.url, signal),
  ]);
  return mergeGithubUrlData(githubApiData, openGraphData, family);
}

/**
 * Merge provider API metadata with ordinary preview data.
 *
 * GitHub keeps its historical behavior: ordinary preview values win when
 * present (they describe the actually served page); API values are retained
 * when the preview data is absent, so cards keep usable metadata without
 * Open Graph data.
 *
 * GitLab and Forgejo/Gitea run the API query in the browser with the
 * browser's own session, while the anonymous generic preview of a sign-in
 * page is only a fallback: direct API title and description take precedence
 * when present, and the preview still fills missing metadata and provides
 * the image.
 */
function mergeGithubUrlData(
  apiData: Partial<EmbedGithubBlockUrlData>,
  previewData: Partial<EmbedGithubBlockUrlData>,
  family: ReturnType<typeof resolveGitForgeFamily>,
): Partial<EmbedGithubBlockUrlData> {
  if (family !== "GitHub") {
    return {
      ...apiData,
      title: apiData.title ?? previewData.title ?? null,
      description: apiData.description ?? previewData.description ?? null,
      image: previewData.image ?? apiData.image ?? null,
    };
  }
  return {
    ...apiData,
    title: previewData.title ?? apiData.title ?? null,
    description: previewData.description ?? apiData.description ?? null,
    image: previewData.image ?? apiData.image ?? null,
  };
}

export async function queryEmbedGithubApiData(
  embedGithubModel: EmbedGithubModel,
  signal?: AbortSignal,
): Promise<Partial<EmbedGithubBlockUrlData>> {
  const url = embedGithubModel.props.url;
  const family = resolveGitForgeFamily(url);
  if (family === "GitHub") {
    return queryGithubApiData(embedGithubModel, signal);
  }
  // GitLab and Forgejo/Gitea query the provider's API directly in the
  // browser, on the card URL's own origin, using the browser's existing
  // session (`credentials: "include"`). A rejected, non-JSON or identity-
  // mismatched response yields absent metadata, never a failing request.
  if (family === "GitLab") {
    return queryGitLabApiData(url, signal);
  }
  if (family === "Forgejo/Gitea") {
    return queryForgejoGiteaApiData(url, signal);
  }
  return {};
}

async function queryGithubApiData(
  embedGithubModel: EmbedGithubModel,
  signal?: AbortSignal,
): Promise<Partial<EmbedGithubBlockUrlData>> {
  const { owner, repo, githubType, githubId } = embedGithubModel.props;
  let githubApiData: Partial<EmbedGithubBlockUrlData> = {};

  // github's public api has a rate limit of 60 requests per hour
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/${
    githubType === "issue" ? "issues" : "pulls"
  }/${githubId}`;

  const githubApiResponse = await fetch(apiUrl, {
    cache: "no-cache",
    signal,
  }).catch(() => null);

  if (githubApiResponse && githubApiResponse.ok) {
    const githubApiJson = await githubApiResponse.json();
    const { state, state_reason, draft, merged, created_at, assignees } =
      githubApiJson;

    const assigneeLogins = assignees.map(
      (assignee: { login: string }) => assignee.login,
    );

    let status = state;
    if (merged) {
      status = "merged";
    } else if (state === "open" && draft) {
      status = "draft";
    }

    githubApiData = {
      status,
      statusReason: state_reason,
      createdAt: created_at,
      assignees: assigneeLogins,
    };
  }

  return githubApiData;
}

/**
 * Extract the project path (`<group>/<project>`) from a GitLab resource
 * `web_url` such as `http://host/group/sub/project/-/issues/4`. Returns
 * `null` when the URL does not carry the `/-/` marker. GitLab 19.x
 * responses no longer report `path_with_namespace` (issues are served as
 * work items), so the `web_url` path prefix is the identity fallback.
 */
function projectPathFromWebUrl(webUrl: string): string | null {
  const parsed = parseCardUrl(webUrl);
  if (!parsed) return null;
  const markerIndex = parsed.pathname.indexOf("/-/");
  if (markerIndex <= 0) return null;
  const projectPath = parsed.pathname.slice(0, markerIndex).replace(/^\//, "");
  return projectPath === "" ? null : projectPath;
}

/**
 * Direct browser GET of the GitLab resource on the card URL's own origin
 * (`/api/v4/projects/:encoded_project_path/issues|merge_requests/:iid`),
 * using the browser's existing session. The response must confirm both the
 * project-local number and the project identity (via
 * `path_with_namespace`, or the `web_url` prefix on GitLab 19.x
 * responses); any mismatch leaves the metadata absent.
 */
async function queryGitLabApiData(
  url: string,
  signal?: AbortSignal,
): Promise<Partial<EmbedGithubBlockUrlData>> {
  const identity = parseGitLabUrl(url);
  const parsed = parseCardUrl(url);
  if (!identity || !parsed) return {};
  const projectPath = identity.owner
    ? `${identity.owner}/${identity.repo}`
    : identity.repo;
  const kind = identity.githubType === "issue" ? "issues" : "merge_requests";
  const apiUrl = `${parsed.origin}/api/v4/projects/${encodeURIComponent(
    projectPath,
  )}/${kind}/${identity.githubId}`;

  const response = await fetch(apiUrl, {
    cache: "no-cache",
    credentials: "include",
    signal,
  }).catch(() => null);

  if (!response || !response.ok) return {};

  const body = await response.json().catch(() => null);
  if (!body) return {};

  if (body.iid !== Number(identity.githubId)) return {};
  const actualProjectPath =
    typeof body.path_with_namespace === "string"
      ? body.path_with_namespace
      : projectPathFromWebUrl(
          typeof body.web_url === "string" ? body.web_url : "",
        );
  if (actualProjectPath !== projectPath) return {};

  // States that cannot be confirmed (`locked`, unknown) stay absent rather
  // than being guessed; a draft merge request is explicitly reported via
  // the `draft` flag while still open.
  const state = typeof body.state === "string" ? body.state : "";
  const isDraft = body.draft === true;
  let status: string | null = null;
  if (kind === "merge_requests") {
    if (state === "merged") status = "merged";
    else if (state === "opened" && isDraft) status = "draft";
    else if (state === "opened") status = "open";
    else if (state === "closed") status = "closed";
  } else {
    if (state === "opened") status = "open";
    else if (state === "closed") status = "closed";
  }

  const assignees = Array.isArray(body.assignees)
    ? body.assignees
        .map((assignee: { username?: unknown }) =>
          typeof assignee?.username === "string" ? assignee.username : null,
        )
        .filter(
          (username: string | null): username is string => username !== null,
        )
    : [];

  return {
    title: typeof body.title === "string" ? body.title : null,
    description:
      typeof body.description === "string" && body.description !== ""
        ? body.description
        : null,
    status,
    // No GitLab state in this set reports a closure reason; never fabricate
    // one.
    statusReason: null,
    createdAt: typeof body.created_at === "string" ? body.created_at : null,
    assignees,
  };
}

/**
 * Direct browser GET of the Forgejo/Gitea resource on the card URL's own
 * origin (`/api/v1/repos/:owner/:repo/issues|pulls/:number`), using the
 * browser's existing session. The response must confirm both the resource
 * number and the repository identity; any mismatch leaves the metadata
 * absent.
 */
async function queryForgejoGiteaApiData(
  url: string,
  signal?: AbortSignal,
): Promise<Partial<EmbedGithubBlockUrlData>> {
  const identity = parseForgejoGiteaUrl(url);
  const parsed = parseCardUrl(url);
  if (!identity || !parsed) return {};
  const kind = identity.githubType === "issue" ? "issues" : "pulls";
  const apiUrl = `${parsed.origin}/api/v1/repos/${identity.owner}/${identity.repo}/${kind}/${identity.githubId}`;

  const response = await fetch(apiUrl, {
    cache: "no-cache",
    credentials: "include",
    signal,
  }).catch(() => null);

  if (!response || !response.ok) return {};

  const body = await response.json().catch(() => null);
  if (!body) return {};

  if (body.number !== Number(identity.githubId)) return {};

  // Repository identity across the observed Gitea/Forgejo API shapes:
  // issues expose a top-level `repository` (Gitea 28.x/Forgejo 17.x,
  // plain-string owner) or `repo` (older Gitea, owner object with
  // `login`); pull requests carry no top-level repository object, so the
  // identity comes from `base.repo`.
  const repo = body.repository ?? body.repo ?? body.base?.repo;
  const actualOwner =
    typeof repo?.owner === "string"
      ? repo.owner
      : typeof repo?.owner?.login === "string"
        ? repo.owner.login
        : null;
  if (actualOwner !== identity.owner || repo?.name !== identity.repo) return {};

  const state = typeof body.state === "string" ? body.state : "";
  let status: string | null = null;
  if (kind === "pulls") {
    // Merged pull requests carry a non-null `merged_at` even when the
    // state is already `closed`.
    const mergedAt = body.merged_at;
    const merged =
      mergedAt !== null &&
      mergedAt !== undefined &&
      (typeof mergedAt === "object" ||
        (typeof mergedAt === "string" && mergedAt !== ""));
    if (merged) status = "merged";
    else if (body.draft === true) status = "draft";
  }
  if (!status) {
    if (state === "open") status = "open";
    else if (state === "closed") status = "closed";
  }

  const assignees = Array.isArray(body.assignees)
    ? body.assignees
        .map((assignee: { login?: unknown }) =>
          typeof assignee?.login === "string" ? assignee.login : null,
        )
        .filter((login: string | null): login is string => login !== null)
    : [];

  return {
    title: typeof body.title === "string" ? body.title : null,
    description:
      typeof body.body === "string" && body.body !== "" ? body.body : null,
    status,
    // No Forgejo/Gitea state in this set reports a closure reason; never
    // fabricate one.
    statusReason: null,
    createdAt: typeof body.created_at === "string" ? body.created_at : null,
    assignees,
  };
}

export async function refreshEmbedGithubUrlData(
  embedGithubElement: EmbedGithubBlockComponent,
  signal?: AbortSignal,
): Promise<void> {
  // The URL captured here must still be current when the response lands;
  // a superseded response must not overwrite the newer target (GFC-05G).
  const queriedUrl = embedGithubElement.model.props.url;
  let image = null,
    status = null,
    statusReason = null,
    title = null,
    description = null,
    createdAt = null,
    assignees = null;

  try {
    embedGithubElement.loading = true;

    // TODO(@mirone): remove service
    const queryUrlData = embedGithubElement.service?.queryUrlData;
    if (!queryUrlData) {
      console.error(
        `Trying to refresh github url data, but the queryUrlData is not found.`,
      );
      return;
    }

    const githubUrlData = await queryUrlData(embedGithubElement.model, signal);

    if (signal?.aborted || embedGithubElement.model.props.url !== queriedUrl) {
      return;
    }

    ({
      image = null,
      status = null,
      statusReason = null,
      title = null,
      description = null,
      createdAt = null,
      assignees = null,
    } = githubUrlData);

    embedGithubElement.store.updateBlock(embedGithubElement.model, {
      image,
      status,
      statusReason,
      title,
      description,
      createdAt,
      assignees,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return;
    throw Error;
  } finally {
    embedGithubElement.loading = false;
  }
}

export async function refreshEmbedGithubStatus(
  embedGithubElement: EmbedGithubBlockComponent,
  signal?: AbortSignal,
) {
  // TODO(@mirone): remove service
  const queryApiData = embedGithubElement.service?.queryApiData;
  if (!queryApiData) {
    console.error(
      `Trying to refresh github status, but the queryApiData is not found.`,
    );
    return;
  }

  const queriedUrl = embedGithubElement.model.props.url;
  const githubApiData = await queryApiData(embedGithubElement.model, signal);

  if (
    !githubApiData.status ||
    signal?.aborted ||
    embedGithubElement.model.props.url !== queriedUrl
  ) {
    return;
  }

  embedGithubElement.store.updateBlock(embedGithubElement.model, {
    status: githubApiData.status,
    statusReason: githubApiData.statusReason,
    createdAt: githubApiData.createdAt,
    assignees: githubApiData.assignees,
  });
}

export function getGithubStatusIcon(
  type: "issue" | "pr",
  status: string,
  statusReason: string | null,
) {
  if (type === "issue") {
    if (status === "open") {
      return GithubIssueOpenIcon;
    } else if (status === "closed" && statusReason === "completed") {
      return GithubIssueClosedSuccessIcon;
    } else if (status === "closed" && statusReason === "not_planned") {
      return GithubIssueClosedFailureIcon;
    } else {
      return nothing;
    }
  } else if (type === "pr") {
    if (status === "open") {
      return GithubPROpenIcon;
    } else if (status === "draft") {
      return GithubPRDraftIcon;
    } else if (status === "merged") {
      return GithubPRMergedIcon;
    } else if (status === "closed") {
      return GithubPRClosedIcon;
    }
  }
  return nothing;
}
