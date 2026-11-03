// SPDX-License-Identifier: AGPL-3.0-or-later
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
}
export type NativeAsset = { asset: string; sha256: string };
export type PreparedNativePayload = NativeAsset & {
  kind: "yjs" | "snapshot";
  title: string;
  description?: string | null;
  assets?: (NativeAsset & { source: string; mime: string })[];
};
export type PreparedNativeBundle = NativeBundleManifest & {
  defaultLocale: string;
  contents: Record<string, PreparedNativePayload>;
};
/** The discriminator describes actual prepared bytes, never their old ZIP suffix.
 * Each read creates a private snapshot so asset rebinding cannot edit the source. */
export type NativeTemplateContent =
  | { kind: "yjs"; bytes: Uint8Array }
  | {
      kind: "snapshot";
      snapshot: ReturnType<typeof DocSnapshotSchema.parse>;
      assets: Map<string, Blob>;
    };

const normalizeLocale = (locale: string) =>
  locale.trim().replaceAll("_", "-").toLowerCase();

async function readAsset(
  asset: NativeAsset,
  load: (asset: string) => Promise<Uint8Array>,
) {
  if (!/^(?:payloads|assets)\/[a-f0-9]{64}\.[a-z.]+$/.test(asset.asset))
    throw new Error("Invalid prepared native asset path");
  const bytes = await load(asset.asset);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (hash !== asset.sha256)
    throw new Error("Native payload checksum mismatch");
  return bytes;
}

/** Choose the locale once, verify its direct payload/assets, and bind them before
 * entering the existing native creation lifecycle. ZIP readers are build-only. */
export async function readNativeTemplateBundle(
  bundle: PreparedNativeBundle,
  initialLocale: string,
  load: (asset: string) => Promise<Uint8Array>,
) {
  const requested = normalizeLocale(initialLocale);
  const locale = [
    requested,
    requested.split("-")[0],
    bundle.defaultLocale,
  ].find((candidate) => Object.hasOwn(bundle.contents, candidate));
  if (!locale) throw new Error("Native default payload is unavailable");
  const selected = bundle.contents[locale];
  const bytes = await readAsset(selected, load);
  let content: NativeTemplateContent;
  if (selected.kind === "yjs") {
    content = { kind: "yjs", bytes };
  } else if (selected.kind === "snapshot") {
    const snapshot = DocSnapshotSchema.parse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    if (snapshot.blocks.flavour !== "myoxus:page")
      throw new Error("A native template snapshot requires a page");
    const aliases = new Map<string, string>();
    const assets = new Map<string, Blob>();
    for (const asset of selected.assets ?? []) {
      const data = await readAsset(asset, load);
      const key = `assets/${asset.sha256}`;
      for (const alias of [asset.source, asset.source.slice(7)].flatMap(
        (path) => [path, path.replace(/\.[^/.]+$/, "")],
      )) {
        if (aliases.has(alias) && aliases.get(alias) !== key)
          throw new Error("Ambiguous native snapshot asset");
        aliases.set(alias, key);
      }
      assets.set(key, new Blob([new Uint8Array(data)], { type: asset.mime }));
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
          block.props.sourceId = asset;
        }
      }
      block.children.forEach(visit);
    };
    visit(snapshot.blocks);
    if (pageCount !== 1)
      throw new Error("A native template snapshot requires exactly one page");
    content = { kind: "snapshot", snapshot, assets };
  } else {
    throw new Error("Unknown prepared native payload type");
  }
  return {
    manifest: bundle,
    locale,
    content,
    title: selected.title,
    description: selected.description ?? bundle.description,
  };
}
