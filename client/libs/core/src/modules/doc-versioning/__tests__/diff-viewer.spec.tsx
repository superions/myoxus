/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";

const synchronize = vi.hoisted(() =>
  vi.fn(async (): Promise<void> => undefined),
);
vi.mock("../document-sync", () => ({
  waitForDocumentVersionSync: synchronize,
}));
vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async () => {
    const { formatRegionalDateTime } =
      await import("@myoxus/core/modules/i18n/regional-format");
    return {
      useRegionalFormatters: () => ({
        formatDateTime: (value: string) =>
          formatRegionalDateTime(value, {
            locale: "en",
            timezone: "Europe/Berlin",
            dateFormat: "year-month-day",
            timeFormat: "24-hour",
          }),
      }),
    };
  },
);
vi.mock("@myoxus/i18n", async (original) => {
  const actual = await original<typeof import("@myoxus/i18n")>();
  const { readFileSync } = await import("node:fs");
  const en = JSON.parse(
    readFileSync("client/libs/i18n/src/resources/en.json", "utf8"),
  );
  const translate = (key: string, args?: Record<string, unknown>) =>
    (en[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_: string, name: string) =>
      String(args?.[name] ?? ""),
    );
  const t = new Proxy(
    { language: "en", t: translate },
    {
      get: (target, key: string) =>
        key in target
          ? target[key as keyof typeof target]
          : (args?: Record<string, unknown>) => translate(key, args),
    },
  );
  return { ...actual, useI18n: () => t };
});

import { DocumentVersionDiffViewer } from "../diff-viewer";

const snapshotId = "9007199254740993";
function response(revision = "5", id = snapshotId, added = "red! 👩🏽‍💻") {
  return {
    workspace: {
      historyDiff: {
        snapshotId: id,
        currentRevision: revision,
        readAt: "2026-10-11T20:10:00Z",
        extractionPartial: false,
        notices: [{ kind: "presentation_not_compared", blockId: null }],
        comparisonBlocks: [
          {
            blockId: "prose",
            kind: "modified",
            flavour: "myoxus:paragraph",
            placementKnown: true,
            runs: [
              { kind: "unchanged", text: "red " },
              { kind: "removed", text: "red " },
              { kind: "unchanged", text: "blue " },
              { kind: "added", text: added },
            ],
          },
        ],
      },
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(gql = vi.fn().mockResolvedValue(response())) {
  const sync = new BehaviorSubject({ synced: true, updating: false });
  const workspace = {
    id: "workspace",
    engine: { doc: { docState$: () => sync } },
  };
  const service = { gql };
  const cache = new Map();
  const view = (docId = "doc", id = snapshotId, visible = true) => (
    <SWRConfig value={{ provider: () => cache }}>
      <MyoxusUIProvider>
        <DocumentVersionDiffViewer
          visible={visible}
          workspace={workspace as never}
          docId={docId}
          snapshotId={id}
          captureTime="2020-02-03T04:05:00Z"
          label="Old capture"
          graphqlService={service as never}
        />
      </MyoxusUIProvider>
    </SWRConfig>
  );
  return { ...render(view()), gql, sync, view };
}
async function ack(
  sync: BehaviorSubject<{ synced: boolean; updating: boolean }>,
) {
  await act(async () => {
    sync.next({ synced: false, updating: true });
  });
  await act(async () => {
    sync.next({ synced: true, updating: false });
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  synchronize.mockReset().mockResolvedValue(undefined);
});

describe("fixed history-to-current consuming view", () => {
  test("keeps both texts and semantic prose markers, fixed source and server identity", async () => {
    const { gql } = setup();
    await screen.findByText(/current revision 5/);
    expect(
      screen.getByRole("heading", {
        name: "Selected capture: 2020-02-03, 05:05",
      }).textContent,
    ).toBe("Selected capture: 2020-02-03, 05:05");
    expect(
      screen.getByText(/Read from server: 2026-10-11, 22:10/).textContent,
    ).toContain("Read from server: 2026-10-11, 22:10");
    expect(gql).toHaveBeenCalledWith({
      query: expect.objectContaining({ op: "historyDiff" }),
      variables: {
        workspaceId: "workspace",
        pageDocId: "doc",
        snapshotId,
      },
    });
    expect(synchronize).toHaveBeenCalledBefore(gql);
    expect(
      screen.getByRole("heading", { name: "Current saved document" })
        .textContent,
    ).toBe("Current saved document");
    const prose = document.querySelector('[data-comparison-block="prose"]')!;
    expect(prose.querySelector("ins")?.textContent).toBe("red! 👩🏽‍💻");
    expect(prose.querySelector("del")?.textContent).toBe("red ");
    expect(prose.querySelector("del")?.getAttribute("style")).toContain(
      "line-through",
    );
    const runs = [...prose.children];
    expect(
      runs
        .filter((node) => node.tagName !== "INS")
        .map((node) => node.textContent)
        .join(""),
    ).toBe("red red blue ");
    expect(
      runs
        .filter((node) => node.tagName !== "DEL")
        .map((node) => node.textContent)
        .join(""),
    ).toBe("red blue red! 👩🏽‍💻");
    expect(prose.querySelector("ins")?.getAttribute("aria-label")).toContain(
      "Added:",
    );
    expect(
      screen.getByText(/does not establish formatting/).textContent,
    ).toContain("does not establish formatting");
    expect(document.querySelector("select")).toBeNull();
  });

  test("waits for acknowledgement and hides the prior result during pending writes", async () => {
    const gate = deferred<void>();
    synchronize.mockReturnValueOnce(gate.promise);
    const { gql, sync } = setup();
    await waitFor(() => expect(synchronize).toHaveBeenCalled());
    expect(gql).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    await screen.findByText(/current revision 5/);
    await act(async () => sync.next({ synced: false, updating: true }));
    expect(
      document.querySelector('[data-comparison-block="prose"]'),
    ).toBeNull();
    expect(screen.getByText(/Waiting for local changes/).textContent).toContain(
      "Waiting for local changes",
    );
    gql.mockResolvedValue(response("6", snapshotId, "Acknowledged"));
    await act(async () => sync.next({ synced: true, updating: false }));
    await screen.findByText(/current revision 6/);
    expect(
      document.querySelector('[data-comparison-block="prose"] ins')
        ?.textContent,
    ).toBe("Acknowledged");
  });

  test("late reads cannot replace a newer acknowledgement or another scope", async () => {
    const old = deferred<ReturnType<typeof response>>();
    const gql = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(response("6"));
    const { sync, rerender, view } = setup(gql);
    await waitFor(() => expect(gql).toHaveBeenCalledTimes(1));
    await ack(sync);
    await screen.findByText(/current revision 6/);
    await act(async () => old.resolve(response("5")));
    expect(screen.queryByText(/current revision 5/)).toBeNull();
    const next = deferred<ReturnType<typeof response>>();
    gql.mockReturnValueOnce(next.promise);
    rerender(view("other-doc", "9007199254740994"));
    expect(screen.queryByText(/current revision 6/)).toBeNull();
    await waitFor(() => expect(gql).toHaveBeenCalledTimes(3));
    await act(async () => next.resolve(response("8", "9007199254740994")));
    await screen.findByText(/current revision 8/);
    expect(gql.mock.calls.at(-1)?.[0].variables.pageDocId).toBe("other-doc");
    rerender(view("other-doc", "9007199254740994", false));
    expect(screen.queryByText(/current revision 8/)).toBeNull();
  });

  test("retry reports failure and text equality never claims complete document equality", async () => {
    const gql = vi.fn().mockRejectedValueOnce(new Error("Sync read failed"));
    setup(gql);
    await screen.findByText("Sync read failed");
    const data = response();
    data.workspace.historyDiff.comparisonBlocks[0].runs = [
      { kind: "unchanged", text: "Unchanged prose" },
    ];
    data.workspace.historyDiff.extractionPartial = true;
    data.workspace.historyDiff.notices.push({
      kind: "structure_changed",
      blockId: null,
    });
    gql.mockResolvedValue(data);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("No detected text changes");
    expect(
      screen.getByText(/Detected structure changes/).textContent,
    ).toContain("Detected structure changes");
    expect(screen.getByText(/Only part/).textContent).toContain("Only part");
    expect(screen.queryByText("No document changes")).toBeNull();
    expect(screen.getByText("Unchanged prose").textContent).toBe(
      "Unchanged prose",
    );
  });
});
