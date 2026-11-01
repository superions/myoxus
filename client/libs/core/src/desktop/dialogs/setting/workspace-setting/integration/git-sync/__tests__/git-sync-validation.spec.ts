import {
  createGitSyncProfileMutation,
  deleteGitSyncProfileMutation,
  getGitSyncBindingsQuery,
  getGitSyncConflictsQuery,
  getGitSyncProfileQuery,
  getGitSyncRunsQuery,
  getGitSyncStatusQuery,
  resolveGitSyncConflictMutation,
  testGitConnectionMutation,
  triggerGitSyncMutation,
  updateGitSyncProfileMutation,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import { isValidGitSyncBranch, isValidGitSyncRepoUrl } from "../validation";

describe("git-sync URL validation", () => {
  test("accepts valid https URLs", () => {
    expect(isValidGitSyncRepoUrl("https://github.com/user/repo.git")).toBe(
      true,
    );
    expect(isValidGitSyncRepoUrl("https://gitlab.com/org/project")).toBe(true);
  });

  test("accepts valid SSH URLs", () => {
    expect(isValidGitSyncRepoUrl("git@github.com:user/repo.git")).toBe(true);
    expect(isValidGitSyncRepoUrl("git@gitlab.com:org/project.git")).toBe(true);
    expect(
      isValidGitSyncRepoUrl("ssh://git@git.internal/repos/project.git"),
    ).toBe(true);
  });

  test("rejects empty and invalid URLs", () => {
    expect(isValidGitSyncRepoUrl("")).toBe(false);
    expect(isValidGitSyncRepoUrl("not-a-url")).toBe(false);
    expect(isValidGitSyncRepoUrl("ftp://example.com/repo")).toBe(false);
  });
});

describe("git-sync branch validation", () => {
  test("accepts valid branch names", () => {
    expect(isValidGitSyncBranch("main")).toBe(true);
    expect(isValidGitSyncBranch("feature/my-branch")).toBe(true);
    expect(isValidGitSyncBranch("release/1.0.0")).toBe(true);
    expect(isValidGitSyncBranch("fix_underscore")).toBe(true);
  });

  test("allows empty branch (defaults to main)", () => {
    expect(isValidGitSyncBranch("")).toBe(true);
  });

  test("rejects invalid branch names", () => {
    expect(isValidGitSyncBranch("-starts-with-dash")).toBe(false);
    expect(isValidGitSyncBranch("has spaces")).toBe(false);
    expect(isValidGitSyncBranch("has:colon")).toBe(false);
  });
});

describe("git-sync GQL operations are exported", () => {
  test("queries have correct structure", () => {
    for (const query of [
      getGitSyncProfileQuery,
      getGitSyncStatusQuery,
      getGitSyncRunsQuery,
      getGitSyncConflictsQuery,
      getGitSyncBindingsQuery,
    ]) {
      expect(query).toHaveProperty("id");
      expect(query).toHaveProperty("op");
      expect(query).toHaveProperty("query");
      expect(typeof query.query).toBe("string");
      expect(query.query).toContain("query");
    }
  });

  test("mutations have correct structure", () => {
    for (const mutation of [
      createGitSyncProfileMutation,
      deleteGitSyncProfileMutation,
      triggerGitSyncMutation,
      testGitConnectionMutation,
      updateGitSyncProfileMutation,
      resolveGitSyncConflictMutation,
    ]) {
      expect(mutation).toHaveProperty("id");
      expect(mutation).toHaveProperty("op");
      expect(mutation).toHaveProperty("query");
      expect(typeof mutation.query).toBe("string");
      expect(mutation.query).toContain("mutation");
    }
  });

  test("operation IDs are unique", () => {
    const allOps = [
      getGitSyncProfileQuery,
      getGitSyncStatusQuery,
      getGitSyncRunsQuery,
      getGitSyncConflictsQuery,
      getGitSyncBindingsQuery,
      createGitSyncProfileMutation,
      deleteGitSyncProfileMutation,
      triggerGitSyncMutation,
      testGitConnectionMutation,
      updateGitSyncProfileMutation,
      resolveGitSyncConflictMutation,
    ];
    const ids = allOps.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("update and connection-test operations preserve lifecycle semantics", () => {
    expect(updateGitSyncProfileMutation.query).toContain(
      "updateGitSyncProfile(profileId: $profileId",
    );
    expect(updateGitSyncProfileMutation.query).not.toContain(
      "createGitSyncProfile",
    );
    expect(testGitConnectionMutation.query).toContain("branch: $branch");
  });
});
