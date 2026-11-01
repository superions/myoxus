import {
  abortBlobUploadMutation,
  BlobUploadMethod,
  completeBlobUploadMutation,
  createBlobUploadMutation,
  getBlobUploadPartUrlQuery,
  setBlobMutation,
  workspaceBlobQuotaQuery,
} from "@myoxus/graphql";
import { afterEach, expect, test, vi } from "vitest";

import { CloudBlobStorage } from "../impls/cloud/blob";

const quotaResponse = {
  workspace: {
    quota: {
      humanReadable: {
        blobLimit: "1 MB",
      },
      blobLimit: 1024 * 1024,
    },
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createStorage() {
  return new CloudBlobStorage({
    serverBaseUrl: "https://example.com",
    id: "workspace-1",
  });
}

test("encodes blob download key path segments without flattening folders", async () => {
  const storage = createStorage();
  const fetchMock = vi.fn(
    async () =>
      new Response(new Blob(["<svg/>"], { type: "image/svg+xml" }), {
        status: 200,
        headers: {
          "content-type": "image/svg+xml",
          "last-modified": "Sun, 28 Jun 2026 12:00:00 GMT",
        },
      }),
  );
  (storage.connection as any).fetch = fetchMock;

  const record = await storage.get("markdown-import/doc name/diagram#1.svg");

  expect(fetchMock).toHaveBeenCalledWith(
    "/api/workspaces/workspace-1/blobs/markdown-import/doc%20name/diagram%231.svg",
    expect.any(Object),
  );
  expect(record?.mime).toBe("image/svg+xml");
  expect(record?.size).toBeGreaterThan(0);
});

test("uses graphql upload when server returns GRAPHQL method", async () => {
  const storage = createStorage();
  const gqlMock = vi.fn(async ({ query }) => {
    if (query === workspaceBlobQuotaQuery) {
      return quotaResponse;
    }
    if (query === createBlobUploadMutation) {
      return {
        createBlobUpload: {
          method: BlobUploadMethod.Graphql,
          blobKey: "blob-key",
          alreadyUploaded: false,
        },
      };
    }
    if (query === setBlobMutation) {
      return { setBlob: "blob-key" };
    }
    throw new Error("Unexpected query");
  });

  (storage.connection as any).gql = gqlMock;

  await storage.set({
    key: "blob-key",
    data: new Uint8Array([1, 2, 3]),
    mime: "text/plain",
  });

  const queries = gqlMock.mock.calls.map((call) => call[0].query);
  expect(queries).toContain(createBlobUploadMutation);
  expect(queries).toContain(setBlobMutation);
});

test("falls back to graphql when presigned upload fails", async () => {
  const storage = createStorage();
  const gqlMock = vi.fn(async ({ query }) => {
    if (query === workspaceBlobQuotaQuery) {
      return quotaResponse;
    }
    if (query === createBlobUploadMutation) {
      return {
        createBlobUpload: {
          method: BlobUploadMethod.Presigned,
          blobKey: "blob-key",
          alreadyUploaded: false,
          uploadUrl: "https://upload.example.com/blob",
        },
      };
    }
    if (query === setBlobMutation) {
      return { setBlob: "blob-key" };
    }
    if (query === completeBlobUploadMutation) {
      return { completeBlobUpload: "blob-key" };
    }
    throw new Error("Unexpected query");
  });

  (storage.connection as any).gql = gqlMock;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );

  await storage.set({
    key: "blob-key",
    data: new Uint8Array([1, 2, 3]),
    mime: "text/plain",
  });

  const queries = gqlMock.mock.calls.map((call) => call[0].query);
  expect(queries).toContain(setBlobMutation);
  expect(queries).not.toContain(completeBlobUploadMutation);
});

test("falls back to graphql and aborts when multipart upload fails", async () => {
  const storage = createStorage();
  const gqlMock = vi.fn(async ({ query }) => {
    if (query === workspaceBlobQuotaQuery) {
      return quotaResponse;
    }
    if (query === createBlobUploadMutation) {
      return {
        createBlobUpload: {
          method: BlobUploadMethod.Multipart,
          blobKey: "blob-key",
          alreadyUploaded: false,
          uploadId: "upload-1",
          partSize: 2,
          uploadedParts: [],
        },
      };
    }
    if (query === getBlobUploadPartUrlQuery) {
      return {
        workspace: {
          blobUploadPartUrl: {
            uploadUrl: "https://upload.example.com/part",
          },
        },
      };
    }
    if (query === abortBlobUploadMutation) {
      return { abortBlobUpload: true };
    }
    if (query === setBlobMutation) {
      return { setBlob: "blob-key" };
    }
    throw new Error("Unexpected query");
  });

  (storage.connection as any).gql = gqlMock;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 500 })),
  );

  await storage.set({
    key: "blob-key",
    data: new Uint8Array([1, 2, 3]),
    mime: "text/plain",
  });

  const queries = gqlMock.mock.calls.map((call) => call[0].query);
  expect(queries).toContain(abortBlobUploadMutation);
  expect(queries).toContain(setBlobMutation);
});
