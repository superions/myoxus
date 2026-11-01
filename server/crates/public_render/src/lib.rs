//! Standalone public HTML rendering for Myoxus documents.
//!
//! The renderer consumes Yjs-derived [`PublicDocIr`] and emits standalone HTML.
//! It does not depend on the Web/Admin bundles, editor runtime, sync, workspace
//! engine or hydration.

pub mod assets;
pub mod catalog;
pub use catalog::{HTML_CATALOG_FILES, HtmlRenderer, HtmlRendererProvider};
pub mod highlight;
pub mod html;
pub mod ir;
pub mod preview;
pub mod response_pages;
pub mod seo;
pub mod site_shell;
pub mod social_card;

#[cfg(test)]
mod preview_tests;

pub use assets::{
  AssetResolution, PrivateAssetManifestEntry, PublicAssetCandidate, apply_private_asset_paths, apply_public_asset_url,
  is_external_asset_source, resolve_asset_candidates,
};
pub use html::{
  HtmlRenderOptions, HtmlRenderOutput, PrivateHtmlRenderOptions, render_document_html, render_private_document_html,
  render_workspace_index_html,
};
pub use ir::{
  AssetRef, Block, CalloutAppearance, Document, DocumentBadge, InlineText, NativeTableIdentity,
  PreviewProjectionLimits, PublicDocIr, PublicList, PublicListItem, PublicListKind, RenderDiagnostic, WorkspaceIndex,
  WorkspaceIndexFolder, WorkspaceIndexItem, WorkspaceRegisterValue, document_excerpt_from_yjs, document_from_yjs,
  document_from_yjs_for_editing,
};
pub use preview::{
  PreparedPreviewContext, PreviewAsset, PreviewAssetKind, PreviewFont, PreviewOutput, PreviewOutputFormat,
  PreviewOutputPair, PreviewPolicy, PreviewRenderError, PreviewTheme, render_page_preview, render_page_preview_pair,
};
pub use seo::{SeoMetadata, build_document_seo, build_workspace_seo};
pub use site_shell::{
  PublicAdjacentPage, PublicBreadcrumb, PublicSiteShellOptions, TocEntry, public_document_path, public_folder_path,
};
pub use social_card::{SocialCardFonts, SocialCardInput, SocialCardTheme, render_social_card_png};
