import { StoreExtension, type TransformerMiddleware } from "../../store/index";

import { DEFAULT_IMAGE_PROXY_ENDPOINT } from "../../consts";

export const customImageProxyMiddleware = (
  imageProxyURL: string,
): TransformerMiddleware => {
  return ({ adapterConfigs }) => {
    adapterConfigs.set("imageProxy", imageProxyURL);
  };
};

const imageProxyMiddlewareBuilder = () => {
  let middleware = customImageProxyMiddleware(DEFAULT_IMAGE_PROXY_ENDPOINT);
  return {
    get: () => middleware,
    set: (url: string) => {
      middleware = customImageProxyMiddleware(url);
    },
  };
};

/** A proxy-shaped path on another origin is still an external image source. */
export const isImageProxyURL = (
  imageUrl: string,
  proxyUrl = DEFAULT_IMAGE_PROXY_ENDPOINT,
) => {
  try {
    const endpoint = new URL(proxyUrl, globalThis.location?.href);
    const image = new URL(imageUrl, globalThis.location?.href);
    return (
      image.origin === endpoint.origin &&
      image.pathname === endpoint.pathname &&
      image.searchParams.has("url")
    );
  } catch {
    return false;
  }
};

/** Keep editor media and native source icons on the same proxy URL contract. */
export function buildImageProxyURL(imageUrl: string, proxyUrl: string) {
  if (isImageProxyURL(imageUrl, proxyUrl)) return imageUrl;
  return (
    proxyUrl +
    (proxyUrl.includes("?") ? "&" : "?") +
    "url=" +
    encodeURIComponent(imageUrl)
  );
}

const defaultImageProxyMiddlewarBuilder = imageProxyMiddlewareBuilder();

export const setImageProxyMiddlewareURL = defaultImageProxyMiddlewarBuilder.set;

export const defaultImageProxyMiddleware: TransformerMiddleware = (args) => {
  return defaultImageProxyMiddlewarBuilder.get()(args);
};

// TODO(@mirone): this should be configured when setup instead of runtime
export class ImageProxyService extends StoreExtension {
  static override key = "image-proxy";

  private _imageProxyURL = DEFAULT_IMAGE_PROXY_ENDPOINT;

  setImageProxyURL(url: string) {
    this._imageProxyURL = url;
    setImageProxyMiddlewareURL(url);
  }

  buildUrl(imageUrl: string) {
    return buildImageProxyURL(imageUrl, this.imageProxyURL);
  }

  get imageProxyURL() {
    return this._imageProxyURL;
  }
}
