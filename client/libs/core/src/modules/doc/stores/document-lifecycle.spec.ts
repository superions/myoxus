// SPDX-License-Identifier: AGPL-3.0-or-later

import { UserFriendlyError } from "@myoxus/error";
import { Framework } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { isDocumentNotFoundError } from "../errors";
import { DocumentLifecycleStore } from "./document-lifecycle";

function createStore() {
  const framework = new Framework();
  framework.store(DocumentLifecycleStore);
  return framework.provider().get(DocumentLifecycleStore);
}

describe("isDocumentNotFoundError", () => {
  test.each(["name", "code", "type"] as const)(
    "accepts DOC_NOT_FOUND in the %s identity",
    (identity) => {
      const error = new UserFriendlyError({
        status: 404,
        code: identity === "code" ? "DOC_NOT_FOUND" : "NOT_FOUND",
        type: identity === "type" ? "DOC_NOT_FOUND" : "NOT_FOUND",
        name: identity === "name" ? "DOC_NOT_FOUND" : "NOT_FOUND",
        message: "missing",
      });

      expect(isDocumentNotFoundError(error)).toBe(true);
    },
  );

  test.each(["Document not found", "Request failed: not found: document"])(
    "accepts only the bounded historical message fallback: %s",
    (message) => {
      expect(isDocumentNotFoundError(new Error(message))).toBe(true);
    },
  );

  test.each([
    new Error("workspace not found"),
    new Error("document access forbidden"),
    new UserFriendlyError({
      status: 404,
      code: "NOT_FOUND",
      type: "NOT_FOUND",
      name: "NOT_FOUND",
      message: "not found: workspace",
    }),
  ])("does not terminate for unrelated errors", (error) => {
    expect(isDocumentNotFoundError(error)).toBe(false);
  });
});

describe("DocumentLifecycleStore", () => {
  test("terminates one document, aborts its generation and isolates peers", () => {
    const store = createStore();
    const docOneStates: string[] = [];
    const docTwoStates: string[] = [];
    const docOneSubscription = store
      .state$("doc-1")
      .subscribe((state) => docOneStates.push(state));
    const docTwoSubscription = store
      .state$("doc-2")
      .subscribe((state) => docTwoStates.push(state));
    const docOneSignal = store.signal("doc-1");
    const docTwoSignal = store.signal("doc-2");

    expect(store.markNotFound("doc-1")).toBe(true);
    expect(store.markNotFound("doc-1")).toBe(false);

    expect(store.state("doc-1")).toBe("not-found");
    expect(store.state("doc-2")).toBe("available");
    expect(docOneSignal.aborted).toBe(true);
    expect(docTwoSignal.aborted).toBe(false);
    expect(docOneStates).toEqual(["available", "not-found"]);
    expect(docTwoStates).toEqual(["available"]);

    docOneSubscription.unsubscribe();
    docTwoSubscription.unsubscribe();
  });

  test("does not implicitly revive a terminal document", () => {
    const store = createStore();
    store.markNotFound("doc-1");

    expect(store.state$("doc-1").value).toBe("not-found");
    expect(store.signal("doc-1").aborted).toBe(true);
    expect(store.state("doc-1")).toBe("not-found");
  });

  test("keeps server consumers blocked until creation is explicitly confirmed", () => {
    const store = createStore();
    const previousSignal = store.signal("doc-1");
    const states: string[] = [];
    store.state$("doc-1").subscribe((state) => states.push(state));

    expect(store.beginCreating("doc-1")).toBe(true);
    expect(store.beginCreating("doc-1")).toBe(false);
    expect(store.state("doc-1")).toBe("creating");
    expect(previousSignal.aborted).toBe(true);
    expect(() => store.requestSignal("doc-1")).toThrow(
      "Document lifecycle is awaiting initial server sync",
    );

    expect(store.beginAvailableLifecycle("doc-1", "created")).toBe(true);
    expect(store.state("doc-1")).toBe("available");
    expect(store.signal("doc-1").aborted).toBe(false);
    expect(states).toEqual(["available", "creating", "available"]);
  });

  test("waits for explicit creation confirmation before exposing a request signal", async () => {
    const store = createStore();
    store.beginCreating("doc-1");

    let settled = false;
    const requestSignal = store.waitUntilAvailable("doc-1").then((signal) => {
      settled = true;
      return signal;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    store.beginAvailableLifecycle("doc-1", "created");

    await expect(requestSignal).resolves.toMatchObject({ aborted: false });
  });

  test("rejects a lifecycle waiter when creation becomes terminal", async () => {
    const store = createStore();
    store.beginCreating("doc-1");

    const requestSignal = store.waitUntilAvailable("doc-1");
    store.markNotFound("doc-1");

    await expect(requestSignal).rejects.toThrow(
      "Document lifecycle is not available",
    );
  });

  test("does not install a waiter for an already aborted attempt", async () => {
    const store = createStore();
    const attempt = new AbortController();
    const reason = new Error("request disposed");
    store.beginCreating("doc-1");
    attempt.abort(reason);

    await expect(
      store.waitUntilAvailable("doc-1", attempt.signal),
    ).rejects.toBe(reason);
  });

  test("replaces a pending-create abort reason when creation fails", () => {
    const store = createStore();
    store.beginCreating("doc-1");

    store.markNotFound("doc-1");

    expect(store.state("doc-1")).toBe("not-found");
    expect(() => store.requestSignal("doc-1")).toThrow(
      "Document lifecycle is not available",
    );
  });

  test.each(["created", "membership"] as const)(
    "starts a fresh generation only after explicit %s confirmation",
    (source) => {
      const store = createStore();
      const oldSignal = store.signal("doc-1");
      store.markNotFound("doc-1");

      expect(store.beginAvailableLifecycle("doc-1", source)).toBe(true);
      const newSignal = store.signal("doc-1");

      expect(store.state("doc-1")).toBe("available");
      expect(oldSignal.aborted).toBe(true);
      expect(newSignal).not.toBe(oldSignal);
      expect(newSignal.aborted).toBe(false);
      expect(store.beginAvailableLifecycle("doc-1", source)).toBe(false);
    },
  );

  test("publishes available only after the fresh request generation is installed", () => {
    const store = createStore();
    store.markNotFound("doc-1");
    let signalSeenBySubscriber: AbortSignal | undefined;
    store.state$("doc-1").subscribe((state) => {
      if (state === "available") {
        signalSeenBySubscriber = store.requestSignal("doc-1");
      }
    });

    store.beginAvailableLifecycle("doc-1", "membership");

    expect(signalSeenBySubscriber).toBeDefined();
    expect(signalSeenBySubscriber?.aborted).toBe(false);
  });

  test("dispose aborts every active generation and completes streams", () => {
    const store = createStore();
    const firstSignal = store.signal("doc-1");
    const secondSignal = store.signal("doc-2");
    const completed = vi.fn();
    store.state$("doc-1").subscribe({ complete: completed });

    store.dispose();

    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(true);
    expect(completed).toHaveBeenCalledOnce();
  });
});
