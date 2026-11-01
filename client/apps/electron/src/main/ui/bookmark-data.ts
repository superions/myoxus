// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { logger } from "../logger";
import {
  fetchValidatedJson,
  fetchValidatedText,
  resolveAndValidateUrlForPreview,
} from "../security/url-safety";

const EMPTY_BOOKMARK_DATA = Object.freeze({
  title: undefined,
  description: undefined,
  icon: undefined,
  image: undefined,
});

const HTML_ATTRIBUTE =
  /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decodeHtml(value: string) {
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (entity, code: string) => {
      const normalized = code.toLowerCase();
      if (normalized.startsWith("#x")) {
        const point = Number.parseInt(normalized.slice(2), 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      }
      if (normalized.startsWith("#")) {
        const point = Number.parseInt(normalized.slice(1), 10);
        return point <= 0x10ffff ? String.fromCodePoint(point) : entity;
      }
      return ({ amp: "&", apos: "'", gt: ">", lt: "<", quot: '"' } as const)[
        normalized as "amp" | "apos" | "gt" | "lt" | "quot"
      ];
    },
  );
}

function attributesOf(tag: string) {
  const attributes = new Map<string, string>();
  for (const match of tag.matchAll(HTML_ATTRIBUTE)) {
    attributes.set(
      match[1].toLowerCase(),
      decodeHtml(match[2] ?? match[3] ?? match[4] ?? ""),
    );
  }
  return attributes;
}

function metaContent(html: string, key: string) {
  const normalizedKey = key.toLowerCase();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = attributesOf(tag);
    if (
      (attributes.get("property") ?? attributes.get("name"))?.toLowerCase() ===
      normalizedKey
    ) {
      const content = attributes.get("content")?.trim();
      if (content) return content;
    }
  }
  return undefined;
}

function documentTitle(html: string) {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1];
  const title = raw
    ? decodeHtml(raw.replace(/<[^>]*>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
    : "";
  return title || undefined;
}

function absoluteHttpUrl(value: string | undefined, base: URL) {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function faviconUrl(html: string, base: URL) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = attributesOf(tag);
    const rel = attributes.get("rel")?.toLowerCase().split(/\s+/) ?? [];
    if (rel.includes("icon")) {
      const icon = absoluteHttpUrl(attributes.get("href"), base);
      if (icon) return icon;
    }
  }
  return new URL("/favicon.ico", base).toString();
}

function statusIdForXUrl(link: string) {
  const url = new URL(link);
  const supportedHost = new Set([
    "x.com",
    "www.x.com",
    "twitter.com",
    "www.twitter.com",
  ]).has(url.hostname.toLowerCase());
  return supportedHost ? /\/status\/(\d+)/.exec(url.pathname)?.[1] : undefined;
}

export async function getBookmarkDataByLink(link: string) {
  try {
    await resolveAndValidateUrlForPreview(link);
  } catch {
    return EMPTY_BOOKMARK_DATA;
  }

  const statusId = statusIdForXUrl(link);
  if (statusId) {
    try {
      const payload = (await fetchValidatedJson(
        `https://api.fxtwitter.com/status/${statusId}`,
      )) as {
        tweet?: {
          author?: { avatar_url?: string; banner_url?: string; name?: string };
          media?: { photos?: Array<{ url?: string }> };
          text?: string;
        };
      };
      const tweet = payload.tweet;
      return {
        title: tweet?.author?.name,
        icon: tweet?.author?.avatar_url,
        description: tweet?.text,
        image: tweet?.media?.photos?.[0]?.url ?? tweet?.author?.banner_url,
      };
    } catch (error) {
      logger.error("getBookmarkDataByLink", error);
      return EMPTY_BOOKMARK_DATA;
    }
  }

  try {
    const preview = await fetchValidatedText(link, {
      maxBytes: 2 * 1024 * 1024,
      maxRedirects: 3,
      timeoutMs: 6000,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36",
    });

    return {
      title:
        metaContent(preview.body, "og:title") ?? documentTitle(preview.body),
      description:
        metaContent(preview.body, "og:description") ??
        metaContent(preview.body, "description"),
      icon: faviconUrl(preview.body, preview.url),
      image: absoluteHttpUrl(
        metaContent(preview.body, "og:image"),
        preview.url,
      ),
    };
  } catch {
    return EMPTY_BOOKMARK_DATA;
  }
}
