// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="env" />

import {
  createContext,
  type ImgHTMLAttributes,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type BrandAssetSlot = "logo" | "productMark";
export type BrandIdentitySource = "server" | "fallback" | "unavailable";
export type BrandIdentityStatus = "loading" | "ready" | "error";

export const BRAND_IDENTITY_UPDATED_EVENT = "myoxus:brand-identity-updated";

const BRAND_IDENTITY_API_PATH = "/api/branding/app-server.json";
const BRAND_IDENTITY_FALLBACK_PATH = "/style/brand-identity-fallback.json";
const FAVICON_SIZES = [32, 36, 48, 72, 96, 144, 192] as const;

export type RuntimeBrandAsset = {
  slot?: string | null;
  variant?: string | null;
  qualityClass?: string | null;
  storageKind?: string | null;
  storageKey?: string | null;
  publicUrl?: string | null;
  mime?: string | null;
  sha256?: string | null;
  byteSize?: number | null;
  widthPx?: number | null;
  heightPx?: number | null;
};

export type RuntimeAppServerBranding = {
  logo?: RuntimeBrandAsset | null;
  productMark?: RuntimeBrandAsset | null;
  faviconPack?: RuntimeBrandAsset | null;
};

type RuntimeBrandIdentityPayload =
  | RuntimeAppServerBranding
  | {
      schemaVersion?: number | null;
      appServerBranding?: RuntimeAppServerBranding | null;
    };

type RuntimeBrandIdentityEnvelope = {
  schemaVersion?: number | null;
  appServerBranding?: RuntimeAppServerBranding | null;
};

export type BrandIdentityState = {
  status: BrandIdentityStatus;
  source: BrandIdentitySource;
  schemaVersion?: number;
  appServerBranding: RuntimeAppServerBranding | null;
  error?: unknown;
};

const requestCache = new Map<string, Promise<BrandIdentityState>>();
// Undefined preserves Browser Web's same-origin contract; native shells set
// null before registration, then their already-resolved internal server path.
let serverPathPrefix: string | null | undefined;
let identityRevision = 0;

export function setBrandIdentityServerPath(
  prefix: string | null | undefined,
): void {
  if (
    prefix != null &&
    (!prefix.startsWith("/") ||
      prefix.startsWith("//") ||
      /[?#\\]/.test(prefix))
  ) {
    throw new Error("Brand identity requires an internal path prefix");
  }
  if (serverPathPrefix === prefix) return;
  serverPathPrefix = prefix;
  identityRevision++;
  notifyBrandIdentityUpdated();
}

function runtimeEnvironmentSubPath(): string | undefined {
  return typeof environment === "undefined" ? undefined : environment.subPath;
}

// All runtime asset URLs must stay same-origin/subpath-relative. Absolute URLs
// are rejected here to prevent accidental CDN or upstream-brand asset use.
function normalizeSubPath(subPath: string | undefined): string {
  if (!subPath || subPath === "/") {
    return "";
  }
  return subPath.replace(/\/+$/, "");
}

function runtimeUrl(path: string, subPath: string | undefined): string {
  return `${normalizeSubPath(subPath)}${path}`;
}

export function resolveBrandPublicUrl(
  value: string | null | undefined,
  subPath: string | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(trimmed)) return undefined;

  const prefix = normalizeSubPath(subPath);
  if (trimmed.startsWith("/")) {
    if (prefix && trimmed.startsWith(`${prefix}/`)) return trimmed;
    return `${prefix}${trimmed}`;
  }
  return `${prefix}/${trimmed.replace(/^\/+/, "")}`;
}

function readBrandingPayload(
  payload: RuntimeBrandIdentityPayload,
): Pick<BrandIdentityState, "schemaVersion" | "appServerBranding"> {
  if (isBrandingEnvelope(payload)) {
    return {
      schemaVersion: payload.schemaVersion ?? undefined,
      appServerBranding: payload.appServerBranding ?? null,
    };
  }
  return {
    appServerBranding: payload as RuntimeAppServerBranding,
  };
}

function isBrandingEnvelope(
  payload: RuntimeBrandIdentityPayload,
): payload is RuntimeBrandIdentityEnvelope {
  return Object.prototype.hasOwnProperty.call(payload, "appServerBranding");
}

async function fetchBrandingJson(
  path: string,
  subPath: string | undefined,
  prefix?: string | null,
): Promise<Pick<
  BrandIdentityState,
  "schemaVersion" | "appServerBranding"
> | null> {
  const response = await fetch(
    prefix === undefined ? runtimeUrl(path, subPath) : `${prefix}${path}`,
    {
      credentials: "same-origin",
      headers: {
        accept: "application/json",
      },
    },
  );
  if (!response.ok) return null;
  const payload = readBrandingPayload(
    (await response.json()) as RuntimeBrandIdentityPayload,
  );
  if (prefix && payload.appServerBranding) {
    // Keep the existing response shape. Only relative server assets get the
    // same native path as their JSON owner; generated fallback assets do not.
    payload.appServerBranding = Object.fromEntries(
      Object.entries(payload.appServerBranding).map(([key, asset]) => {
        const path = resolveBrandPublicUrl(asset?.publicUrl, undefined);
        const normalized = path
          ? new URL(path, "https://branding.invalid")
          : undefined;
        return [
          key,
          asset && normalized
            ? {
                ...asset,
                publicUrl: `${prefix}${normalized.pathname}${normalized.search}${normalized.hash}`,
              }
            : asset,
        ];
      }),
    );
  }
  return payload;
}

export function clearBrandIdentityCache(): void {
  requestCache.clear();
}

export function notifyBrandIdentityUpdated(): void {
  clearBrandIdentityCache();
  globalThis.dispatchEvent?.(new Event(BRAND_IDENTITY_UPDATED_EVENT));
}

export function loadBrandIdentity(
  subPath: string | undefined = runtimeEnvironmentSubPath(),
): Promise<BrandIdentityState> {
  const prefix = serverPathPrefix;
  const cacheKey = `${prefix ?? ""}:${normalizeSubPath(subPath)}`;
  const cached = requestCache.get(cacheKey);
  if (cached) return cached;

  const request = (async () => {
    if (typeof fetch !== "function") {
      return {
        status: "error",
        source: "unavailable",
        appServerBranding: null,
      } satisfies BrandIdentityState;
    }
    let serverError: unknown;
    try {
      const fromServer =
        prefix === null
          ? null
          : await fetchBrandingJson(BRAND_IDENTITY_API_PATH, subPath, prefix);
      if (fromServer?.appServerBranding) {
        return {
          status: "ready",
          source: "server",
          schemaVersion: fromServer.schemaVersion,
          appServerBranding: fromServer.appServerBranding,
        } satisfies BrandIdentityState;
      }
    } catch (err) {
      serverError = err;
      // Offline/electron/static boot states are expected to miss the API. Browser
      // Web still receives a visible unavailable state from callers; this
      // fallback is not a second branding authoring source.
    }
    try {
      const fromFallback = await fetchBrandingJson(
        BRAND_IDENTITY_FALLBACK_PATH,
        subPath,
      );
      if (fromFallback?.appServerBranding) {
        return {
          status: "ready",
          source: "fallback",
          schemaVersion: fromFallback.schemaVersion,
          appServerBranding: fromFallback.appServerBranding,
          error: serverError,
        } satisfies BrandIdentityState;
      }
    } catch (err) {
      return {
        status: "error",
        source: "unavailable",
        appServerBranding: null,
        error: err,
      } satisfies BrandIdentityState;
    }
    return {
      status: "error",
      source: "unavailable",
      appServerBranding: null,
      error: serverError,
    } satisfies BrandIdentityState;
  })();

  requestCache.set(cacheKey, request);
  return request;
}

export async function loadAppServerBranding(
  subPath: string | undefined = runtimeEnvironmentSubPath(),
): Promise<RuntimeAppServerBranding | null> {
  return (await loadBrandIdentity(subPath)).appServerBranding;
}

export async function getBrandAssetUrl(
  slot: BrandAssetSlot,
  subPath: string | undefined = runtimeEnvironmentSubPath(),
): Promise<string | undefined> {
  const identity = await loadBrandIdentity(subPath);
  const branding = identity.appServerBranding;
  const asset = slot === "productMark" ? branding?.productMark : branding?.logo;
  return resolveBrandPublicUrl(asset?.publicUrl, subPath);
}

function faviconUrlForSize(
  publicUrl: string,
  size: number,
  subPath: string | undefined,
): string | undefined {
  const resolved = resolveBrandPublicUrl(publicUrl, subPath);
  if (!resolved) return undefined;
  return resolved.replace(/favicon-\d+\.png(?=$|\?)/u, `favicon-${size}.png`);
}

function setLinkHref(
  doc: Document,
  selector: string,
  attrs: Record<string, string>,
  href: string,
) {
  let link = doc.head.querySelector(selector) as HTMLLinkElement | null;
  if (!link) {
    link = doc.createElement("link");
    Object.entries(attrs).forEach(([name, value]) => {
      link?.setAttribute(name, value);
    });
    doc.head.append(link);
  }
  link.href = href;
}

function setMetaContent(doc: Document, selector: string, content: string) {
  const meta = doc.head.querySelector(selector) as HTMLMetaElement | null;
  if (meta) {
    meta.content = content;
  }
}

export async function applyBrandIdentityDocumentMetadata(
  doc: Document = document,
  subPath: string | undefined = runtimeEnvironmentSubPath(),
): Promise<BrandIdentityState> {
  const revision = identityRevision;
  const identity = await loadBrandIdentity(subPath);
  if (revision !== identityRevision) return identity;
  const branding = identity.appServerBranding;
  const logoUrl = resolveBrandPublicUrl(branding?.logo?.publicUrl, subPath);
  const faviconUrl = resolveBrandPublicUrl(
    branding?.faviconPack?.publicUrl,
    subPath,
  );

  if (logoUrl) {
    setMetaContent(doc, 'meta[name="twitter:image"]', logoUrl);
    setMetaContent(doc, 'meta[property="og:image"]', logoUrl);
  }

  if (faviconUrl) {
    setLinkHref(
      doc,
      'link[rel="shortcut icon"], link[rel="icon"]:not([sizes])',
      { rel: "shortcut icon" },
      faviconUrl,
    );

    for (const size of FAVICON_SIZES) {
      const sizedUrl = faviconUrlForSize(faviconUrl, size, subPath);
      if (!sizedUrl) continue;
      setLinkHref(
        doc,
        `link[rel="icon"][sizes="${size}x${size}"]`,
        { rel: "icon", sizes: `${size}x${size}` },
        sizedUrl,
      );
    }
  }

  return identity;
}

const BrandIdentityContext = createContext<BrandIdentityState | null>(null);

export function BrandIdentityProvider({
  children,
  subPath = runtimeEnvironmentSubPath(),
}: {
  children: ReactNode;
  subPath?: string;
}) {
  const [state, setState] = useState<BrandIdentityState>({
    status: "loading",
    source: "unavailable",
    appServerBranding: null,
  });

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const revision = identityRevision;
      setState((current) => ({
        ...current,
        status: current.status === "ready" ? "ready" : "loading",
        ...(serverPathPrefix !== undefined
          ? { appServerBranding: null, status: "loading" as const }
          : {}),
      }));
      loadBrandIdentity(subPath)
        .then((next) => {
          if (active && revision === identityRevision) setState(next);
        })
        .catch((error) => {
          if (!active || revision !== identityRevision) return;
          setState({
            status: "error",
            source: "unavailable",
            appServerBranding: null,
            error,
          });
        });
    };

    refresh();
    globalThis.addEventListener?.(BRAND_IDENTITY_UPDATED_EVENT, refresh);
    return () => {
      active = false;
      globalThis.removeEventListener?.(BRAND_IDENTITY_UPDATED_EVENT, refresh);
    };
  }, [subPath]);

  const value = useMemo(() => state, [state]);
  return (
    <BrandIdentityContext.Provider value={value}>
      {children}
    </BrandIdentityContext.Provider>
  );
}

export function useBrandIdentity(): BrandIdentityState {
  const context = useContext(BrandIdentityContext);
  const [state, setState] = useState<BrandIdentityState>({
    status: "loading",
    source: "unavailable",
    appServerBranding: null,
  });

  useEffect(() => {
    if (context) return;
    let active = true;
    const refresh = () => {
      const revision = identityRevision;
      if (serverPathPrefix !== undefined)
        setState({
          status: "loading",
          source: "unavailable",
          appServerBranding: null,
        });
      loadBrandIdentity()
        .then((next) => {
          if (active && revision === identityRevision) setState(next);
        })
        .catch((error) => {
          if (!active || revision !== identityRevision) return;
          setState({
            status: "error",
            source: "unavailable",
            appServerBranding: null,
            error,
          });
        });
    };
    refresh();
    globalThis.addEventListener?.(BRAND_IDENTITY_UPDATED_EVENT, refresh);
    return () => {
      active = false;
      globalThis.removeEventListener?.(BRAND_IDENTITY_UPDATED_EVENT, refresh);
    };
  }, [context]);

  return context ?? state;
}

export type BrandAssetImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src"
> & {
  slot?: BrandAssetSlot;
  fallback?: ReactNode;
};

function staticBrandAssetUrl(
  slot: BrandAssetSlot,
  subPath: string | undefined = runtimeEnvironmentSubPath(),
): string {
  const fileName = slot === "productMark" ? "product-mark.svg" : "logo.svg";
  return runtimeUrl(`/style/${fileName}`, subPath);
}

export function BrandAssetImage({
  slot = "logo",
  alt,
  fallback,
  onError,
  ...imgProps
}: BrandAssetImageProps) {
  const identity = useBrandIdentity();
  const [failedAssetUrl, setFailedAssetUrl] = useState<string | null>(null);
  const branding = identity.appServerBranding;
  const asset = slot === "productMark" ? branding?.productMark : branding?.logo;
  const assetUrl = resolveBrandPublicUrl(
    asset?.publicUrl,
    runtimeEnvironmentSubPath(),
  );
  const loadFailed = assetUrl ? failedAssetUrl === assetUrl : false;

  const imageAlt =
    alt ?? (slot === "productMark" ? "Myoxus Product Mark" : "Myoxus Logo");

  if (loadFailed || !assetUrl) {
    if (fallback !== undefined) return fallback;
    return (
      <img
        {...imgProps}
        alt={imageAlt}
        src={staticBrandAssetUrl(slot, runtimeEnvironmentSubPath())}
        onError={onError}
      />
    );
  }

  return (
    <img
      {...imgProps}
      alt={imageAlt}
      src={assetUrl}
      onError={(event) => {
        setFailedAssetUrl(assetUrl);
        onError?.(event);
      }}
    />
  );
}
