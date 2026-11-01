export type PageSize = {
  width: number;
  height: number;
};

export type PDFMeta = {
  pageCount: number;
  maxSize: PageSize;
  pageSizes: PageSize[];
};

export type PageSizeOpts = {
  pageNum: number;
};

export type RenderPageOpts = {
  pageNum: number;
  scale?: number;
} & PageSize;

export type RenderedPage = {
  bitmap: ImageBitmap;
};

export type TextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TextLayerContent = {
  items: TextItem[];
  physWidth: number;
  physHeight: number;
};

export type ScreenAnnotation = {
  type: "Link";
  url: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

// Lightweight text strings per page — used for full-document find/search indexing
export type TextStrings = string[];
