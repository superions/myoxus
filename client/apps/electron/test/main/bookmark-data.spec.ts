// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import * as dns from "node:dns/promises";
import { EventEmitter } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import type { LookupOptions } from "node:net";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { getBookmarkDataByLink } from "../../src/main/ui/bookmark-data";

const { httpsGet } = vi.hoisted(() => ({ httpsGet: vi.fn() }));

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("node:https", () => ({ get: httpsGet }));
vi.mock("../../src/main/logger", () => ({
  logger: { error: vi.fn() },
}));

const lookup = vi.mocked(dns.lookup);
const emptyBookmark = {
  title: undefined,
  description: undefined,
  icon: undefined,
  image: undefined,
};

function mockHttpsResponse({
  body = "",
  headers = {},
  inspectRequest,
  statusCode = 200,
}: {
  body?: string;
  headers?: IncomingHttpHeaders;
  inspectRequest?: (url: URL, options: RequestOptions) => void;
  statusCode?: number;
}) {
  const request = Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
    setTimeout: vi.fn(),
  });
  httpsGet.mockImplementationOnce((url, options, onResponse) => {
    inspectRequest?.(url, options);
    const response = Object.assign(new EventEmitter(), {
      headers,
      resume: vi.fn(),
      statusCode,
    }) as unknown as IncomingMessage;
    onResponse(response);
    queueMicrotask(() => {
      if (body) response.emit("data", body);
      response.emit("end");
    });
    return request;
  });
  return request;
}

describe("bookmark link preview SSRF boundary", () => {
  beforeEach(() => {
    lookup.mockReset();
    httpsGet.mockReset();
  });

  test.each([
    "http://127.0.0.1/internal",
    "http://10.1.2.3/internal",
    "http://169.254.169.254/latest/meta-data",
    "http://192.0.2.1/documentation",
    "http://[::1]/internal",
    "http://[fc00::1]/internal",
    "http://[fe80::1]/internal",
    "http://[2001:db8::1]/documentation",
  ])("rejects private or local literal %s before preview I/O", async (link) => {
    await expect(getBookmarkDataByLink(link)).resolves.toEqual(emptyBookmark);
    expect(httpsGet).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  test("rejects a hostname when any resolved address is private", async () => {
    lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ] as never);

    await expect(
      getBookmarkDataByLink("https://mixed-address.example/article"),
    ).resolves.toEqual(emptyBookmark);
    expect(httpsGet).not.toHaveBeenCalled();
  });

  test("revalidates a redirect target and blocks its private resolution", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }] as never);
    mockHttpsResponse({
      headers: { location: "https://redirect.example/private" },
      statusCode: 302,
    });

    await expect(
      getBookmarkDataByLink("https://public.example/article"),
    ).resolves.toEqual(emptyBookmark);
    expect(httpsGet).toHaveBeenCalledOnce();
  });

  test("blocks DNS rebinding when the same host changes before a follow-up request", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "192.168.1.20", family: 4 }] as never);
    mockHttpsResponse({
      headers: { location: "/article" },
      statusCode: 302,
    });

    await expect(
      getBookmarkDataByLink("https://rebind.example/article"),
    ).resolves.toEqual(emptyBookmark);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(httpsGet).toHaveBeenCalledOnce();
  });

  test("returns parsed preview fields after the validated public path", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
      ] as never);
    mockHttpsResponse({
      body: `<!doctype html><html><head>
        <meta content="Public article &amp; notes" property="og:title">
        <meta name="description" content="Description">
        <meta property="og:image" content="/cover.png">
        <link href="/site-icon.png" rel="shortcut icon">
      </head></html>`,
      headers: { "content-type": "text/html; charset=utf-8" },
      inspectRequest: (_url, options) => {
        const lookupCallback = vi.fn();
        options.lookup?.(
          "public.example",
          { all: false } as LookupOptions,
          lookupCallback,
        );
        expect(lookupCallback).toHaveBeenCalledWith(null, "93.184.216.34", 4);
      },
    });

    await expect(
      getBookmarkDataByLink("https://public.example/article"),
    ).resolves.toEqual({
      title: "Public article & notes",
      description: "Description",
      icon: "https://public.example/site-icon.png",
      image: "https://public.example/cover.png",
    });
  });

  test("pins the X status JSON socket to the validated API address", async () => {
    lookup
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as never)
      .mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }] as never);
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    });
    httpsGet.mockImplementationOnce((url, options, onResponse) => {
      expect(url).toMatchObject({
        hostname: "api.fxtwitter.com",
        pathname: "/status/123456",
      });
      const lookupCallback = vi.fn();
      options.lookup(
        "api.fxtwitter.com",
        { all: false } as LookupOptions,
        lookupCallback,
      );
      expect(lookupCallback).toHaveBeenCalledWith(null, "1.1.1.1", 4);
      const response = Object.assign(new EventEmitter(), {
        resume: vi.fn(),
        statusCode: 200,
      });
      onResponse(response);
      queueMicrotask(() => {
        response.emit(
          "data",
          JSON.stringify({
            tweet: {
              author: { name: "Author", avatar_url: "avatar" },
              text: "Status text",
              media: { photos: [{ url: "photo" }] },
            },
          }),
        );
        response.emit("end");
      });
      return request;
    });

    await expect(
      getBookmarkDataByLink("https://x.com/author/status/123456"),
    ).resolves.toEqual({
      title: "Author",
      description: "Status text",
      icon: "avatar",
      image: "photo",
    });
    expect(httpsGet).toHaveBeenCalledOnce();
  });
});
