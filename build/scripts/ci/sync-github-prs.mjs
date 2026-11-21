#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { intakeCommitter, publicEmails } from "./github-public-authors.mjs";

const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const repo = (value) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
const marker = /<!-- myoxus-github-pr:([^\n]+) -->/;
const imported = (body) => {
  const match = body?.match(marker);
  return match ? JSON.parse(match[1]) : undefined;
};

// GitHub history is a curated export, not an ancestor of the private target.
// Apply only the proposal's merge-base diff to a private index; never checkout
// or execute incoming files, hooks, filters, package scripts or workflows.
export async function syncGithubPrs({
  source = process.env.MYOXUS_GITHUB_REPOSITORY ?? "superions/myoxus",
  target = process.env.MYOXUS_FORGEJO_REPOSITORY ?? "myoxus/myoxus",
  origin = process.env.MYOXUS_FORGEJO_URL ?? "https://git.blume29.de",
  baseBranch = process.env.MYOXUS_PR_TARGET_BRANCH ?? "wip",
  number = process.env.MYOXUS_GITHUB_PR_NUMBER ?? "",
  token = process.env.MYOXUS_PR_SYNC_TOKEN,
  githubToken = process.env.MYOXUS_GITHUB_TOKEN,
  importer = process.env.MYOXUS_PR_IMPORTER ?? "myoxus-renovate",
  fetchImpl = fetch,
  // Local Git repositories are injected only by the isolated contract fixture.
  sourceGit = `https://github.com/${source}.git`,
  targetGit = `${origin}/${target}.git`,
} = {}) {
  if (!repo(source) || !repo(target) || new URL(origin).protocol !== "https:")
    throw new Error("Invalid repository configuration");
  if (number && !/^[1-9]\d*$/.test(number))
    throw new Error("Invalid PR number");
  if (!token) throw new Error("Forgejo PR intake credential is required");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/token|secret|password|credential|^GIT_|^NODE_OPTIONS$/i.test(key),
    ),
  );
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: `http.${origin}/.extraheader`,
    GIT_CONFIG_VALUE_1:
      "Authorization: Basic " +
      Buffer.from(`x-access-token:${token}`).toString("base64"),
    GIT_COMMITTER_NAME: "Myoxus GitHub intake",
    GIT_COMMITTER_EMAIL: intakeCommitter,
  });
  async function api(provider, route, method = "GET", body) {
    const credential = provider === "github" ? githubToken : token;
    const response = await fetchImpl(
      (provider === "github"
        ? `https://api.github.com/repos/${source}`
        : `${origin}/api/v1/repos/${target}`) + route,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Myoxus-PR-intake",
          ...(credential
            ? {
                Authorization: `${provider === "github" ? "Bearer" : "token"} ${credential}`,
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!response.ok)
      throw new Error(
        `${provider} ${method} ${route}: HTTP ${response.status}`,
      );
    return response.status === 204 ? undefined : response.json();
  }
  async function pages(provider, route) {
    const rows = [];
    for (let page = 1; ; page++) {
      const next = await api(
        provider,
        `${route}${route.includes("?") ? "&" : "?"}${provider === "github" ? "per_page" : "limit"}=50&page=${page}`,
      );
      if (!Array.isArray(next)) throw new Error("Invalid PR list");
      rows.push(...next);
      if (next.length < 50) return rows;
    }
  }
  const originals = number
    ? [await api("github", `/pulls/${number}`)]
    : await pages("github", "/pulls?state=open");
  const copies = await pages("forgejo", "/pulls?state=all");
  const stats = {
    created: 0,
    updated: 0,
    unchanged: 0,
    closed: 0,
    skipped: 0,
    failed: 0,
  };
  const directory = mkdtempSync(join(tmpdir(), "myoxus-pr-intake-"));
  const git = (args, input) =>
    execFileSync("git", args, {
      cwd: directory,
      env,
      input,
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  const text = (args, input) => git(args, input).toString().trim();
  try {
    git(["init", "--bare", "--quiet"]);
    git(["remote", "add", "forgejo", targetGit]);
    git(["remote", "add", "github", sourceGit]);
    git(["check-ref-format", `refs/heads/${baseBranch}`]);
    for (const pr of originals) {
      try {
        if (pr.state !== "open") {
          stats.skipped++;
          continue;
        }
        if (
          !Number.isSafeInteger(pr.number) ||
          !sha(pr.head?.sha) ||
          !sha(pr.base?.sha)
        )
          throw new Error("Invalid source identity");
        const key = `${source}#${pr.number}`;
        const branch = `dev/github/${source}/${pr.number}`;
        const matches = copies.filter(
          (copy) => imported(copy.body)?.key === key,
        );
        if (matches.length > 1)
          throw new Error("Duplicate imported PR identity");
        let copy = matches[0];
        const previous = imported(copy?.body);
        if (copy?.merged === true) {
          // A merged PR retains its original branch in head.label after
          // Forgejo moves head.ref to its internal ref on branch deletion.
          if (
            copy.state !== "closed" ||
            copy.user?.login !== importer ||
            copy.base?.ref !== baseBranch ||
            copy.base?.repo_id !== copy.head?.repo_id ||
            !Number.isSafeInteger(copy.base?.repo_id) ||
            ![copy.head?.ref, copy.head?.label].includes(branch) ||
            !sha(copy.merge_commit_sha) ||
            !sha(copy.head?.sha) ||
            !sha(previous.commit) ||
            previous.head !== pr.head.sha
          ) {
            stats.skipped++;
            continue;
          }
          // Maintainers may have updated the integration branch. Verify that
          // its merged head still contains the commit recorded by the importer.
          if (previous.commit !== copy.head.sha) {
            git([
              "fetch",
              "--quiet",
              "--no-tags",
              "--filter=blob:none",
              "forgejo",
              copy.head.sha,
            ]);
            git([
              "merge-base",
              "--is-ancestor",
              previous.commit,
              copy.head.sha,
            ]);
          }
          if (!githubToken)
            throw new Error("GitHub PR write credential is required");
          const route = `/pulls/${pr.number}`;
          // GitHub's close API has no expected-head field. Refresh immediately
          // before the write and keep a visibly newer proposal open.
          const latest = await api("github", route);
          if (latest.state !== "open" || latest.head?.sha !== previous.head) {
            stats.skipped++;
            continue;
          }
          const closed = await api("github", route, "PATCH", {
            state: "closed",
          });
          if (closed?.state !== "closed" || closed.head?.sha !== previous.head)
            throw new Error(
              "GitHub close response differs from the reviewed source",
            );
          stats.closed++;
          console.log(`Closed GitHub ${key} after Forgejo merge`);
          continue;
        }
        if (copy && copy.state !== "open") {
          stats.skipped++;
          continue;
        }
        if (
          copy &&
          copy.body.indexOf("<!-- /myoxus-github-pr -->") <
            copy.body.search(marker)
        )
          throw new Error("Importer description block was edited");
        if (copy && (copy.base.ref !== baseBranch || copy.head.ref !== branch))
          throw new Error("Imported PR refs were edited");
        git([
          "fetch",
          "--quiet",
          "--no-tags",
          "--filter=blob:none",
          "forgejo",
          `refs/heads/${baseBranch}:refs/intake/base`,
        ]);
        const base = text(["rev-parse", "refs/intake/base"]);
        const remote = text([
          "ls-remote",
          "--heads",
          targetGit,
          `refs/heads/${branch}`,
        ]);
        const oldHead = remote.split(/\s/)[0] || undefined;
        if (copy && oldHead !== previous.commit)
          throw new Error("Managed branch changed; preserve local work");
        if (oldHead)
          git([
            "fetch",
            "--quiet",
            "--no-tags",
            "--filter=blob:none",
            "forgejo",
            oldHead,
          ]);
        if (previous?.head === pr.head.sha) {
          stats.unchanged++;
          continue;
        }
        git([
          "fetch",
          "--quiet",
          "--no-tags",
          "--filter=blob:none",
          "github",
          `+refs/pull/${pr.number}/head:refs/intake/head`,
          pr.base.sha,
        ]);
        if (text(["rev-parse", "refs/intake/head"]) !== pr.head.sha)
          throw new Error("Source moved; retry next run");
        const ancestor = text(["merge-base", pr.base.sha, pr.head.sha]);
        const paths = git([
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          ancestor,
          pr.head.sha,
        ])
          .toString()
          .split("\0")
          .filter(Boolean);
        // Public proposals cannot create or modify private control-plane files.
        if (
          paths.some((path) =>
            /^(?:\.forgejo|\.agents|\.codex|\.private|\.git|todo|learnings)(?:\/|$)|^AGENTS\.md$|^docs\/(?:dev|test)(?:\/|$)/i.test(
              path,
            ),
          )
        )
          throw new Error("Proposal touches private control-plane paths");
        const patch = git([
          "diff",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-textconv",
          "--no-renames",
          ancestor,
          pr.head.sha,
        ]);
        if (!patch.length) {
          stats.skipped++;
          continue;
        }
        git(["read-tree", base]);
        // A previous public proposal may be stale relative to private wip. Git's
        // three-way index application accepts clean changes and rejects conflicts.
        git(["apply", "--cached", "--3way", "--whitespace=error"], patch);
        const tree = text(["write-tree"]);
        if (tree === text(["rev-parse", `${base}^{tree}`])) {
          stats.skipped++;
          continue;
        }
        const author = text([
          "show",
          "-s",
          "--format=%an%n%ae%n%aI",
          pr.head.sha,
        ]).split("\n");
        Object.assign(env, {
          GIT_AUTHOR_NAME: author[0],
          GIT_AUTHOR_EMAIL: author[1],
          GIT_AUTHOR_DATE: author[2],
          GIT_COMMITTER_DATE: author[2],
        });
        const range = `${ancestor}..${pr.head.sha}`;
        const publicAuthors = publicEmails(
          text(["log", "--format=%ae", range]).split("\n"),
        );
        const provenance = `Imported-from: https://github.com/${source}/pull/${pr.number}\nGitHub-Head: ${pr.head.sha}`;
        const originalMessages =
          text([
            "log",
            "--reverse",
            "--format=Author: %an <%ae>%n%B",
            range,
          ]) +
          "\n";
        const subject = pr.title.replace(/[\r\n]+/g, " ").trim();
        const message =
          `${subject}\n\n${provenance}\nPublic-GitHub-Authors: ${publicAuthors.join(",")}\n\n` +
          originalMessages;
        // Updates are ordinary fast-forwards with current wip as another parent;
        // no public ancestry, force-push, or overwritten maintainer commits.
        const parents = oldHead ? ["-p", oldHead, "-p", base] : ["-p", base];
        let commit;
        if (oldHead && !copy) {
          // Recover a successful push followed by a failed PR creation. Only the
          // exact generated tree/message on private ancestry can be adopted.
          const oldMessage = text(["show", "-s", "--format=%B", oldHead]);
          const legacyMessage = `${pr.title}\n\n${provenance}\n\n${originalMessages}`;
          if (
            text(["rev-parse", oldHead + "^{tree}"]) !== tree ||
            ![message.trim(), legacyMessage.trim()].includes(oldMessage) ||
            text(["rev-parse", oldHead + "^1"]) !== base
          )
            throw new Error(
              "Unlinked intake branch exists; manual reconciliation required",
            );
          commit = oldHead;
        } else commit = text(["commit-tree", tree, ...parents], message);
        const latest = await api("github", `/pulls/${pr.number}`);
        if (latest.state !== "open" || latest.head.sha !== pr.head.sha)
          throw new Error("Source moved before publish");
        git([
          "push",
          "--quiet",
          `--force-with-lease=refs/heads/${branch}:${oldHead ?? ""}`,
          targetGit,
          `${commit}:refs/heads/${branch}`,
        ]);
        const metadata = { key, head: pr.head.sha, commit };
        const block = `<!-- myoxus-github-pr:${JSON.stringify(metadata)} -->\nSource: https://github.com/${source}/pull/${pr.number}\nAuthor: @${pr.user.login}\nGitHub head: ${pr.head.sha}\n\n${(pr.body ?? "").replace(/<!--\s*\/?myoxus-github-pr/g, "&lt;!-- myoxus-github-pr")}\n<!-- /myoxus-github-pr -->`;
        if (copy) {
          const end = copy.body.indexOf("<!-- /myoxus-github-pr -->");
          const start = copy.body.search(marker);
          if (end < start)
            throw new Error("Importer description block was edited");
          const body =
            copy.body.slice(0, start) +
            block +
            copy.body.slice(end + "<!-- /myoxus-github-pr -->".length);
          await api("forgejo", `/pulls/${copy.number}`, "PATCH", { body });
          stats.updated++;
        } else {
          copy = await api("forgejo", "/pulls", "POST", {
            base: baseBranch,
            head: branch,
            title: pr.title,
            body: block,
          });
          copies.push(copy);
          stats.created++;
        }
        console.log(`GitHub ${key} -> Forgejo #${copy.number}`);
      } catch (error) {
        stats.failed++;
        // Git errors can include authenticated URLs/headers; never print stderr.
        console.error(
          `GitHub PR ${pr.number}: ${error.stderr ? "Git transfer/apply failed; conflict or changed branch" : error.message}`,
        );
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  return stats;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const stats = await syncGithubPrs();
  console.log(JSON.stringify(stats));
  if (stats.failed) process.exitCode = 1;
}
