import {
  type Container,
  createIdentifier,
} from "@virgultum/core/primitives/di";
import { Bound } from "@virgultum/core/primitives/gfx";
import {
  type AttachmentBlockModel,
  type ImageBlockProps,
  MAX_IMAGE_WIDTH,
} from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import { FileSizeLimitProvider } from "@virgultum/core/services";
import {
  readImageSize,
  transformModel,
  withTempBlobData,
} from "@virgultum/core/utils";
import { type BlockStdScope, StdIdentifier } from "@virgultum/core/runtime";
import { Extension, type ExtensionType } from "@virgultum/core/store";

import { getAttachmentBlob } from "./utils";

export type AttachmentEmbedConfig = {
  name: string;
  /**
   * Check if the attachment can be turned into embed view.
   */
  check: (model: AttachmentBlockModel, maxFileSize: number) => boolean;
  /**
   * The action will be executed when the 「Turn into embed view」 button is clicked.
   */
  action?: (
    model: AttachmentBlockModel,
    std: BlockStdScope,
  ) => Promise<void> | void;
  /**
   * Mounts the embed view into an editor-owned anchor and returns its cleanup.
   */
  mount?: (
    anchor: HTMLElement,
    model: AttachmentBlockModel,
    blobUrl: string,
  ) => () => void;

  /**
   * Should show status when turned on.
   */
  shouldShowStatus?: boolean;

  /**
   * Should block type conversion be required.
   */
  shouldBeConverted?: boolean;
};

// Single embed config.
export const AttachmentEmbedConfigIdentifier =
  createIdentifier<AttachmentEmbedConfig>(
    "MyoxusAttachmentEmbedConfigIdentifier",
  );

export function AttachmentEmbedConfigExtension(
  configs: AttachmentEmbedConfig[] = embedConfig,
): ExtensionType {
  return {
    setup: (di) => {
      configs.forEach((option) => {
        di.addImpl(AttachmentEmbedConfigIdentifier(option.name), () => option);
      });
    },
  };
}

// A embed config map.
export const AttachmentEmbedConfigMapIdentifier = createIdentifier<
  Map<string, AttachmentEmbedConfig>
>("MyoxusAttachmentEmbedConfigMapIdentifier");

export const AttachmentEmbedProvider = createIdentifier<AttachmentEmbedService>(
  "MyoxusAttachmentEmbedProvider",
);

export class AttachmentEmbedService extends Extension {
  private get _maxFileSize() {
    return this.std.get(FileSizeLimitProvider).maxFileSize;
  }

  get keys() {
    return this.configs.keys();
  }

  get values() {
    return this.configs.values();
  }

  get configs(): Map<string, AttachmentEmbedConfig> {
    return this.std.get(AttachmentEmbedConfigMapIdentifier);
  }

  constructor(private readonly std: BlockStdScope) {
    super();
  }

  static override setup(di: Container) {
    di.addImpl(AttachmentEmbedConfigMapIdentifier, (provider) =>
      provider.getAll(AttachmentEmbedConfigIdentifier),
    );
    di.addImpl(AttachmentEmbedProvider, this, [StdIdentifier]);
  }

  // Converts to embed view.
  convertTo(model: AttachmentBlockModel, maxFileSize = this._maxFileSize) {
    const config = this.values.find((config) =>
      config.check(model, maxFileSize),
    );

    if (config?.action) {
      config.action(model, this.std)?.catch(console.error);
      return;
    }

    model.store.updateBlock(model, { embed: true });
  }

  embedded(model: AttachmentBlockModel, maxFileSize = this._maxFileSize) {
    return this.values.some((config) => config.check(model, maxFileSize));
  }

  getMount(model: AttachmentBlockModel, maxFileSize = this._maxFileSize) {
    return (
      this.values.find((config) => config.check(model, maxFileSize))?.mount ??
      null
    );
  }

  shouldShowStatus(
    model: AttachmentBlockModel,
    maxFileSize = this._maxFileSize,
  ) {
    return (
      this.values.find((config) => config.check(model, maxFileSize))
        ?.shouldShowStatus ?? false
    );
  }

  shouldBeConverted(
    model: AttachmentBlockModel,
    maxFileSize = this._maxFileSize,
  ) {
    return (
      this.values.find((config) => config.check(model, maxFileSize))
        ?.shouldBeConverted ?? false
    );
  }
}

const embedConfig: AttachmentEmbedConfig[] = [
  {
    name: "image",
    shouldBeConverted: true,
    check: (model) =>
      model.store.schema.flavourSchemaMap.has("myoxus:image") &&
      model.props.type.startsWith("image/"),
    async action(model, std) {
      const component = std.view.getBlock(model.id);
      if (!component) return;

      await turnIntoImageBlock(model);
    },
  },
  {
    name: "pdf",
    shouldShowStatus: true,
    check: (model, maxFileSize) =>
      model.props.type === "application/pdf" && model.props.size <= maxFileSize,
    action: (model) => {
      const bound = Bound.deserialize(model.props.xywh);
      bound.w = EMBED_CARD_WIDTH.pdf;
      bound.h = EMBED_CARD_HEIGHT.pdf;
      model.store.updateBlock(model, {
        embed: true,
        style: "pdf",
        xywh: bound.serialize(),
      });
    },
    mount: (anchor, _, blobUrl) => {
      const doc = anchor.ownerDocument;
      const iframe = doc.createElement("iframe");
      iframe.style.width = "100%";
      iframe.style.minHeight = "480px";
      iframe.style.colorScheme = "auto";
      iframe.src = `${blobUrl}#toolbar=0`;
      iframe.loading = "lazy";
      iframe.setAttribute("scrolling", "no");
      iframe.setAttribute("frameborder", "no");
      iframe.setAttribute("allowTransparency", "");
      iframe.allowFullscreen = true;
      iframe.setAttribute("type", "application/pdf");
      iframe.setAttribute("credentialless", "");
      const mask = doc.createElement("div");
      mask.className = "myoxus-attachment-embed-event-mask";
      anchor.replaceChildren(iframe, mask);
      return () => anchor.replaceChildren();
    },
  },
  {
    name: "video",
    shouldShowStatus: true,
    check: (model, maxFileSize) =>
      model.props.type.startsWith("video/") && model.props.size <= maxFileSize,
    action: (model) => {
      const bound = Bound.deserialize(model.props.xywh);
      bound.w = EMBED_CARD_WIDTH.video;
      bound.h = EMBED_CARD_HEIGHT.video;
      model.store.updateBlock(model, {
        embed: true,
        style: "video",
        xywh: bound.serialize(),
      });
    },
    mount: (anchor, _, blobUrl) => {
      const video = anchor.ownerDocument.createElement("video");
      video.style.display = "flex";
      video.style.objectFit = "cover";
      video.style.backgroundSize = "cover";
      video.style.width = "100%";
      video.style.height = "100%";
      video.src = blobUrl;
      video.setAttribute("width", "100%");
      video.setAttribute("height", "100%");
      video.controls = true;
      anchor.replaceChildren(video);
      return () => anchor.replaceChildren();
    },
  },
  {
    name: "audio",
    check: (model, maxFileSize) =>
      model.props.type.startsWith("audio/") && model.props.size <= maxFileSize,
    mount: (anchor, _, blobUrl) => {
      const audio = anchor.ownerDocument.createElement("audio");
      audio.style.margin = "4px";
      audio.src = blobUrl;
      audio.controls = true;
      anchor.replaceChildren(audio);
      return () => anchor.replaceChildren();
    },
  },
];

/**
 * Turn the attachment block into an image block.
 */
async function turnIntoImageBlock(model: AttachmentBlockModel) {
  if (!model.store.schema.flavourSchemaMap.has("myoxus:image")) {
    console.error("The image flavour is not supported!");
    return;
  }

  const sourceId = model.props.sourceId;
  if (!sourceId) return;

  const { saveAttachmentData, getImageData } = withTempBlobData();
  saveAttachmentData(sourceId, { name: model.props.name });

  let imageSize = model.props.sourceId
    ? getImageData(model.props.sourceId)
    : undefined;

  const bounds = model.xywh
    ? Bound.fromXYWH(model.deserializedXYWH)
    : undefined;

  if (bounds) {
    if (!imageSize?.width || !imageSize?.height) {
      const blob = await getAttachmentBlob(model);
      if (blob) {
        imageSize = await readImageSize(blob);
      }
    }

    if (imageSize?.width && imageSize?.height) {
      const p = imageSize.height / imageSize.width;
      imageSize.width = Math.min(imageSize.width, MAX_IMAGE_WIDTH);
      imageSize.height = imageSize.width * p;
      bounds.w = imageSize.width;
      bounds.h = imageSize.height;
    }
  }

  const others = bounds ? { xywh: bounds.serialize() } : undefined;

  const imageProp: Partial<ImageBlockProps> = {
    sourceId,
    caption: model.props.caption,
    size: model.props.size,
    ...imageSize,
    ...others,
  };
  transformModel(model, "myoxus:image", imageProp);
}
