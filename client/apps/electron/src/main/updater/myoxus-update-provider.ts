// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CustomPublishOptions } from "builder-util-runtime";
import { Provider, type ResolvedUpdateFileInfo } from "electron-updater";

import {
  type DesktopReleaseChannel,
  type DesktopUpdateTarget,
  findUpdateManifestAsset,
  FORGEJO_RELEASE_FEED,
  type MyoxusUpdateInfo,
  parseUpdateManifest,
  parseReleasePayload,
  selectForgejoRelease,
} from "./update-manifest";

type CustomProviderArguments = ConstructorParameters<
  NonNullable<CustomPublishOptions["updateProvider"]>
>;

type MyoxusProviderOptions = CustomPublishOptions & {
  channel: DesktopReleaseChannel;
  feedUrl: string;
  target: DesktopUpdateTarget;
};

export class MyoxusUpdateProvider extends Provider<MyoxusUpdateInfo> {
  static configFeed({
    channel,
    feedUrl = FORGEJO_RELEASE_FEED,
    target,
  }: {
    channel: DesktopReleaseChannel;
    feedUrl?: string;
    target: DesktopUpdateTarget;
  }): CustomPublishOptions {
    return {
      provider: "custom",
      channel,
      feedUrl,
      target,
      updateProvider: MyoxusUpdateProvider,
    };
  }

  private readonly options: MyoxusProviderOptions;

  constructor(
    options: CustomPublishOptions,
    _updater: CustomProviderArguments[1],
    runtimeOptions: CustomProviderArguments[2],
  ) {
    super(runtimeOptions);
    this.options = options as MyoxusProviderOptions;
  }

  get feedUrl(): URL {
    return new URL(this.options.feedUrl);
  }

  async getLatestVersion(): Promise<MyoxusUpdateInfo> {
    const releases: ReturnType<typeof parseReleasePayload> = [];
    // Exhaust the same repository before selecting by semver, not API order.
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error("Forgejo release feed exceeds 100 pages");
      const url = this.feedUrl;
      url.searchParams.set("page", String(page));
      url.searchParams.set("limit", "50");
      const payload = await this.httpRequest(url, {
        accept: "application/json",
        "cache-control": "no-cache",
      });
      if (!payload) throw new Error("Forgejo release feed returned no data");
      const entries = parseReleasePayload(payload);
      releases.push(...entries);
      if (entries.length < 50) break;
    }

    const release = selectForgejoRelease(
      JSON.stringify(releases),
      this.options.channel,
      this.feedUrl,
      this.options.target,
    );
    const manifestAsset = findUpdateManifestAsset(release);
    const manifestUrl = new URL(manifestAsset.browser_download_url);
    const manifestPayload = await this.httpRequest(manifestUrl, {
      accept: "application/yaml, text/yaml, text/plain",
      "cache-control": "no-cache",
    });
    if (!manifestPayload) {
      throw new Error(`Update manifest ${manifestUrl} returned no data`);
    }

    return parseUpdateManifest(
      manifestPayload,
      release,
      this.options.channel,
      this.options.target,
      this.feedUrl,
    );
  }

  resolveFiles(updateInfo: MyoxusUpdateInfo): ResolvedUpdateFileInfo[] {
    return updateInfo.files.map((file) => ({
      url: new URL(file.url),
      info: file,
    }));
  }
}
