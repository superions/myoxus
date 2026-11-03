#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { pathToFileURL } from "node:url";

const GITHUB = "https://api.github.com/repos/superions/myoxus";
const FORGEJO = "https://git.blume29.de/api/v1/repos/myoxus/myoxus";
const BOT = "myoxus-bot";
const LABEL = "source:github";
const issueId = (body) =>
  body?.match(/<!-- myoxus-github-issue:(\d+) -->/)?.[1];
const commentId = (body) =>
  body?.match(/<!-- myoxus-github-comment:(\d+) -->/)?.[1];
const importedText = (text) =>
  (text ?? "").replace(/<!--\s*\/?myoxus-github-/g, "&lt;!-- myoxus-github-");

function managed(kind, id, text) {
  return `<!-- myoxus-github-${kind}:${id} -->\n${text}\n<!-- /myoxus-github-${kind} -->`;
}

// Only this delimited block belongs to the importer. Local notes before/after
// it and locally added comments are never replaced or published to GitHub.
function replaceManaged(body, kind, id, replacement) {
  const start = body.indexOf(`<!-- myoxus-github-${kind}:${id} -->`);
  const end = body.indexOf(`<!-- /myoxus-github-${kind} -->`, start);
  if (start < 0 || end < start)
    throw new Error(
      "Importer block was edited; refusing to replace internal text",
    );
  return (
    body.slice(0, start) +
    replacement +
    body.slice(end + `<!-- /myoxus-github-${kind} -->`.length)
  );
}

export async function syncGithubIssues({
  githubToken = process.env.MYOXUS_GITHUB_TOKEN,
  forgejoToken = process.env.MYOXUS_ISSUE_SYNC_TOKEN,
  fetchImpl = fetch,
} = {}) {
  for (const token of [githubToken, forgejoToken])
    if (typeof token !== "string" || token.length < 16 || /\s/.test(token))
      throw new Error(
        "GitHub read and Forgejo issue-write credentials are required",
      );
  async function api(provider, route, method = "GET", body) {
    if (provider === "github" && method !== "GET")
      throw new Error("GitHub intake is read-only");
    const root = provider === "github" ? GITHUB : FORGEJO;
    const response = await fetchImpl(root + route, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `${provider === "github" ? "Bearer" : "token"} ${provider === "github" ? githubToken : forgejoToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Myoxus-issue-intake",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok)
      throw new Error(
        `${provider} ${method} issue API HTTP ${response.status}`,
      );
    return response.status === 204 ? undefined : response.json();
  }
  async function pages(provider, route) {
    const entries = [],
      size = provider === "github" ? 100 : 50;
    for (let page = 1; ; page++) {
      const rows = await api(
        provider,
        route +
          (route.includes("?") ? "&" : "?") +
          (provider === "github" ? "per_page=" : "limit=") +
          size +
          "&page=" +
          page,
      );
      if (!Array.isArray(rows))
        throw new Error("Issue API returned an invalid list");
      entries.push(...rows);
      if (rows.length < size) return entries;
    }
  }
  const githubIssues = (await pages("github", "/issues?state=all")).filter(
    (x) => !x.pull_request,
  );
  const stats = {
    created: 0,
    updated: 0,
    commentsCreated: 0,
    commentsUpdated: 0,
  };
  let labels = await pages("forgejo", "/labels");
  let label = labels.find((l) => l.name === LABEL);
  if (!label)
    label = await api("forgejo", "/labels", "POST", {
      name: LABEL,
      color: "6e7781",
      description: "Public GitHub issue intake",
    });
  if (!githubIssues.length) return stats;
  const importedIssues = async () =>
    new Map(
      (await pages("forgejo", "/issues?state=all&type=issues"))
        .filter((x) => x.user?.login === BOT && issueId(x.body))
        .map((x) => [issueId(x.body), x]),
    );
  let linked = await importedIssues();
  for (const source of githubIssues) {
    if (
      !Number.isSafeInteger(source.id) ||
      !Number.isSafeInteger(source.number)
    )
      throw new Error("Invalid GitHub issue identity");
    const id = String(source.id);
    const block = managed(
      "issue",
      id,
      `Source: [GitHub #${source.number}](${source.html_url})\nAuthor: @${source.user?.login ?? "deleted"}\nCreated: ${source.created_at}\nGitHub status: ${source.state}\nGitHub title: ${source.title}\n<!-- myoxus-github-title:${Buffer.from(source.title).toString("base64url")} -->\n\n${importedText(source.body)}`,
    );
    let target = linked.get(id);
    if (!target) {
      try {
        target = await api("forgejo", "/issues", "POST", {
          title: source.title,
          body: block,
          labels: [label.id],
        });
      } catch (error) {
        // A timed-out POST may have committed. Rediscover its stable ID before
        // another create, both here and on the next scheduled run.
        linked = await importedIssues();
        target = linked.get(id);
        if (!target) throw error;
      }
      linked.set(id, target);
      stats.created++;
    } else {
      const body = replaceManaged(target.body, "issue", id, block);
      const previous = target.body.match(
        /<!-- myoxus-github-title:([A-Za-z0-9_-]+) -->/,
      )?.[1];
      const title =
        previous &&
        target.title === Buffer.from(previous, "base64url").toString()
          ? source.title
          : target.title;
      if (body !== target.body || title !== target.title) {
        target = await api("forgejo", "/issues/" + target.number, "PATCH", {
          body,
          title,
        });
        linked.set(id, target);
        stats.updated++;
      }
    }
    if (!source.comments) continue;
    const originals = await pages(
      "github",
      "/issues/" + source.number + "/comments",
    );
    const importedComments = async () =>
      new Map(
        (await pages("forgejo", "/issues/" + target.number + "/comments"))
          .filter((x) => x.user?.login === BOT && commentId(x.body))
          .map((x) => [commentId(x.body), x]),
      );
    let comments = await importedComments();
    for (const original of originals) {
      if (!Number.isSafeInteger(original.id))
        throw new Error("Invalid GitHub comment identity");
      const key = String(original.id);
      const text = managed(
        "comment",
        key,
        `[Original GitHub comment](${original.html_url})\nAuthor: @${original.user?.login ?? "deleted"}\nCreated: ${original.created_at}\n\n${importedText(original.body)}`,
      );
      let copy = comments.get(key);
      if (!copy) {
        try {
          copy = await api(
            "forgejo",
            "/issues/" + target.number + "/comments",
            "POST",
            { body: text },
          );
        } catch (error) {
          comments = await importedComments();
          copy = comments.get(key);
          if (!copy) throw error;
        }
        comments.set(key, copy);
        stats.commentsCreated++;
      } else {
        const body = replaceManaged(copy.body, "comment", key, text);
        if (body !== copy.body) {
          await api("forgejo", "/issues/comments/" + copy.id, "PATCH", {
            body,
          });
          stats.commentsUpdated++;
        }
      }
    }
  }
  return stats;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(await syncGithubIssues()));
