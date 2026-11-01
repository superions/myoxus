// SPDX-License-Identifier: AGPL-3.0-or-later
import JSZip from "jszip";
import { DocSnapshotSchema, type BlockSnapshot } from "@virgultum/editor/store";

export interface NativeBundleManifest {
  template_id: string;
  version: string;
  title: string;
  description?: string | null;
  locale?: string | null;
  category?: string | null;
  tags?: string[];
  checksum?: string | null;
  title_policy?: "template" | "template-date" | "date";
  purpose?: "template" | "guide";
  localized_contents?: Partial<
    Record<
      string,
      {
        path: string;
        sha256: string;
        title: string;
        description?: string | null;
      }
    >
  >;
}

const normalizeLocale = (locale: string) =>
  locale.trim().replaceAll("_", "-").toLowerCase();

async function checksum(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode the existing single-document Snapshot export without creating a page.
 * Asset bytes are checked and rebound before the normal native import publishes it.
 */
export async function readNativeTemplateSnapshot(bytes: Uint8Array) {
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const files = Object.values(archive.files).filter((file) => !file.dir);
  if (
    bytes.length > 50 * 1024 * 1024 ||
    files.length > 256 ||
    files.some(
      (file) =>
        file.unsafeOriginalName !== file.name ||
        file.name.startsWith("/") ||
        file.name.includes("\\") ||
        file.name
          .split("/")
          .some((part) => !part || part === "." || part === ".."),
    )
  ) {
    throw new Error("Invalid native snapshot archive");
  }
  const documents = files.filter((file) =>
    file.name.endsWith(".snapshot.json"),
  );
  if (documents.length !== 1)
    throw new Error("A native template snapshot requires exactly one page");
  const snapshot = DocSnapshotSchema.parse(
    JSON.parse(await documents[0].async("string")),
  );
  if (snapshot.blocks.flavour !== "myoxus:page")
    throw new Error("A native template snapshot requires a page");
  const aliases = new Map<string, { key: string; blob: Blob }>();
  const assets = new Map<string, Blob>();
  let total = 0;
  for (const file of files.filter((file) => file.name.startsWith("assets/"))) {
    const data = await file.async("uint8array");
    total += data.length;
    if (data.length > 50 * 1024 * 1024 || total > 200 * 1024 * 1024)
      throw new Error("Native snapshot assets exceed archive limits");
    const key = `assets/${await checksum(data)}`;
    const extension = file.name.split(".").at(-1)?.toLowerCase();
    const mime =
      (
        {
          webp: "image/webp",
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          svg: "image/svg+xml",
        } as Record<string, string>
      )[extension ?? ""] ?? "application/octet-stream";
    const asset = {
      key,
      blob: new Blob([new Uint8Array(data)], { type: mime }),
    };
    for (const alias of [file.name, file.name.slice(7)].flatMap((path) => [
      path,
      path.replace(/\.[^/.]+$/, ""),
    ])) {
      if (aliases.has(alias) && aliases.get(alias)!.key !== key)
        throw new Error("Ambiguous native snapshot asset");
      aliases.set(alias, asset);
    }
    assets.set(key, asset.blob);
  }
  let pageCount = 0;
  const visit = (block: BlockSnapshot) => {
    if (block.flavour === "myoxus:page") pageCount++;
    if (
      ["myoxus:image", "myoxus:attachment", "myoxus:bookmark"].includes(
        block.flavour,
      )
    ) {
      const source = block.props.sourceId;
      if (
        typeof source === "string" &&
        source &&
        !/^(?:https?:|data:)/.test(source)
      ) {
        const asset = aliases.get(source.replace(/^\//, ""));
        if (!asset) throw new Error("Native snapshot asset is missing");
        block.props.sourceId = asset.key;
      }
    }
    block.children.forEach(visit);
  };
  visit(snapshot.blocks);
  if (pageCount !== 1)
    throw new Error("A native template snapshot requires exactly one page");
  return { snapshot, assets };
}

/** Read committed native bytes. The returned locale identifies the captured variant;
 * a later UI-language change must never invoke this to replace a shared source.
 * Native document instantiation remains owned by the existing editor consumer.
 */
export async function readNativeTemplateBundle(
  bytes: Uint8Array,
  initialLocale: string,
) {
  const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const manifestFile = archive.file("manifest.json");
  const defaultFile = archive.file("content.template.zip");
  if (!manifestFile || !defaultFile)
    throw new Error("Incomplete native template bundle");
  const manifest: NativeBundleManifest = JSON.parse(
    await manifestFile.async("string"),
  );
  if (
    !manifest.template_id ||
    !manifest.version ||
    !manifest.title ||
    (manifest.purpose !== undefined &&
      !["template", "guide"].includes(manifest.purpose)) ||
    (manifest.title_policy !== undefined &&
      !["template", "template-date", "date"].includes(manifest.title_policy))
  ) {
    throw new Error("Invalid native template manifest");
  }
  const content = await defaultFile.async("uint8array");
  if (manifest.checksum && (await checksum(content)) !== manifest.checksum) {
    throw new Error("Native default payload checksum mismatch");
  }
  const variants = new Map<string, Uint8Array>();
  const paths = new Set<string>();
  const locales = new Set<string>();
  for (const [locale, variant] of Object.entries(
    manifest.localized_contents ?? {},
  )) {
    if (!variant) throw new Error("Invalid native locale payload");
    const file = archive.file(variant.path);
    if (
      !file ||
      file.unsafeOriginalName !== variant.path ||
      !variant.title ||
      !locale ||
      paths.has(variant.path) ||
      locales.has(normalizeLocale(locale)) ||
      variant.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      variant.path.includes("\\")
    ) {
      throw new Error("Invalid native locale payload");
    }
    const payload = await file.async("uint8array");
    if ((await checksum(payload)) !== variant.sha256) {
      throw new Error("Native locale payload checksum mismatch");
    }
    if (
      manifest.locale &&
      normalizeLocale(locale) === normalizeLocale(manifest.locale) &&
      (await checksum(payload)) !== (await checksum(content))
    ) {
      throw new Error("Conflicting native default locale payload");
    }
    variants.set(locale, payload);
    paths.add(variant.path);
    locales.add(normalizeLocale(locale));
  }
  if (
    Object.entries(archive.files).some(
      ([path, file]) =>
        !file.dir &&
        !["manifest.json", "content.template.zip", "preview.svg"].includes(
          path,
        ) &&
        !paths.has(path) &&
        (variants.size > 0 ||
          path.startsWith("localized/") ||
          path.endsWith(".template.zip")) &&
        !path.startsWith("__MACOSX/") &&
        !path
          .split("/")
          .some((part) => part === ".DS_Store" || part.startsWith("._")),
    )
  ) {
    throw new Error("Undeclared native locale payload");
  }
  const requested = normalizeLocale(initialLocale);
  let locale = manifest.locale ?? initialLocale;
  for (const candidate of [requested, requested.split("-")[0]]) {
    const matched = [...variants.keys()].find(
      (key) => normalizeLocale(key) === candidate,
    );
    if (matched) {
      locale = matched;
      break;
    }
    if (manifest.locale && normalizeLocale(manifest.locale) === candidate) {
      locale = manifest.locale;
      break;
    }
  }
  const localized = manifest.localized_contents?.[locale];
  return {
    manifest,
    locale,
    content: variants.get(locale) ?? content,
    title: localized?.title ?? manifest.title,
    description: localized?.description ?? manifest.description,
  };
}
