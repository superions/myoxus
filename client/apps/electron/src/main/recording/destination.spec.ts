// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { deriveRecordingDestination } from "./destination";

test("capture binds the resolved route and server; missing authority never substitutes another workspace or server", () => {
  const meta = {
    basename: "/workspace/original",
    serverId: "original-server",
    workspaceName: "Original workspace",
  };
  const server = { id: "original-server", baseUrl: "https://original.example" };
  const derive = (url: string, target = meta, registered = server) =>
    deriveRecordingDestination(target, url, registered, "journal-today");
  expect(derive("assets://./workspace/original/document")).toEqual({
    workspaceId: "original",
    workspaceName: "Original workspace",
    serverId: server.id,
    serverBaseUrl: server.baseUrl,
    savingMode: "journal-today",
  });
  expect(derive("assets://./sign-In")).toBeUndefined();
  expect(derive("assets://./workspace/other/document")).toBeUndefined();
  expect(
    derive("assets://./workspace/original/document", meta, {
      id: "default-server",
      baseUrl: "https://default.example",
    }),
  ).toBeUndefined();
  expect(
    deriveRecordingDestination(
      { ...meta, serverId: undefined },
      "assets://./workspace/original/document",
      server,
      "new-doc",
    ),
  ).toBeUndefined();
  expect(
    deriveRecordingDestination(
      { ...meta, serverId: null },
      "assets://./workspace/original/document",
      undefined,
      "new-doc",
    ),
  ).toMatchObject({
    workspaceId: "original",
    serverId: null,
    serverBaseUrl: undefined,
  });
});
