// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import assert from "node:assert/strict";
import test from "node:test";
import { syncGithubIssues } from "./sync-github-issues.mjs";

test("intake reconciles ambiguous creates, repeat polls and edits while preserving private work", async () => {
  const source = {
    id: 101,
    number: 5,
    title: "Public report",
    body: "Original description",
    state: "open",
    comments: 1,
    user: { login: "reporter" },
    created_at: "2026-11-01T10:00:00Z",
    html_url: "https://github.com/superions/myoxus/issues/5",
  };
  const original = {
    id: 303,
    body: "Public reply",
    user: { login: "author" },
    created_at: source.created_at,
    html_url: source.html_url + "#issuecomment-303",
  };
  const labels = [],
    issues = [],
    comments = [],
    writes = [];
  let lostIssueResponse = true,
    lostCommentResponse = true;
  const ok = (value) => new Response(JSON.stringify(value), { status: 200 });
  const fetchImpl = async (url, options) => {
    const u = new URL(url),
      method = options.method,
      body = options.body && JSON.parse(options.body);
    if (u.hostname === "api.github.com") {
      assert.equal(
        method,
        "GET",
        "internal text must never be published to GitHub",
      );
      assert.equal(
        options.headers.Authorization,
        "Bearer fixture-github-token",
      );
      if (u.pathname.endsWith("/comments")) return ok([original]);
      return ok([source, { id: 102, number: 6, pull_request: {} }]);
    }
    assert.equal(u.hostname, "git.blume29.de");
    assert.equal(options.headers.Authorization, "token fixture-forgejo-token");
    if (method !== "GET") writes.push({ path: u.pathname, body });
    if (u.pathname.endsWith("/labels")) {
      if (method === "POST") {
        const label = { id: 7, ...body };
        labels.push(label);
        return ok(label);
      }
      return ok(labels);
    }
    if (u.pathname.endsWith("/issues")) {
      if (method === "POST") {
        const issue = {
          id: 20,
          number: 1,
          ...body,
          state: "open",
          user: { login: "myoxus-bot" },
        };
        issues.push(issue);
        if (lostIssueResponse) {
          lostIssueResponse = false;
          throw new Error("response lost after commit");
        }
        return ok(issue);
      }
      return ok(issues);
    }
    if (u.pathname.endsWith("/issues/1") && method === "PATCH") {
      assert.equal(body.state, undefined);
      assert.equal(body.labels, undefined);
      Object.assign(issues[0], body);
      return ok(issues[0]);
    }
    if (u.pathname.endsWith("/issues/1/comments")) {
      if (method === "POST") {
        const comment = { id: 40, ...body, user: { login: "myoxus-bot" } };
        comments.push(comment);
        if (lostCommentResponse) {
          lostCommentResponse = false;
          throw new Error("comment response lost after commit");
        }
        return ok(comment);
      }
      return ok(comments);
    }
    if (u.pathname.endsWith("/issues/comments/40") && method === "PATCH") {
      Object.assign(comments[0], body);
      return ok(comments[0]);
    }
    throw new Error("Unexpected fixture request " + method + " " + u.pathname);
  };
  const run = () =>
    syncGithubIssues({
      githubToken: "fixture-github-token",
      forgejoToken: "fixture-forgejo-token",
      fetchImpl,
    });
  assert.deepEqual(await run(), {
    created: 1,
    updated: 0,
    commentsCreated: 1,
    commentsUpdated: 0,
  });
  const initialWrites = writes.length;
  assert.deepEqual(await run(), {
    created: 0,
    updated: 0,
    commentsCreated: 0,
    commentsUpdated: 0,
  });
  assert.equal(writes.length, initialWrites);
  issues[0].body += "\nPrivate investigation stays here";
  issues[0].title = "Internal working title";
  issues[0].state = "closed";
  issues[0].labels.push(99);
  comments.push({
    id: 41,
    body: "Internal comment",
    user: { login: "maintainer" },
  });
  source.body = "Updated public description";
  source.title = "Updated public title";
  original.body = "Edited public reply";
  assert.deepEqual(await run(), {
    created: 0,
    updated: 1,
    commentsCreated: 0,
    commentsUpdated: 1,
  });
  assert.equal(issues.length, 1);
  assert.equal(comments.length, 2);
  assert.equal(issues[0].title, "Internal working title");
  assert.equal(issues[0].state, "closed");
  assert(issues[0].labels.includes(99));
  assert(issues[0].body.includes("Private investigation stays here"));
  assert(issues[0].body.includes(source.body));
  assert(comments[0].body.includes(original.body));
  assert.equal(comments[1].body, "Internal comment");
});
