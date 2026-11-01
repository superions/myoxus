// SPDX-License-Identifier: AGPL-3.0-or-later
//! Static-path adapter for the native public overview projection.

use std::{
  collections::{BTreeMap, BTreeSet},
  path::Path,
  sync::Arc,
};

use anyhow::Result;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
  PublicExportArgs, PublicStaticAsset, PublicWorkspaceRoute, canonical_public_url, html_options, search_bundle_url,
  write_html,
};
use crate::services::Services;
use myoxus_application::{
  document_metadata_policy::DocumentMetadataPolicyService,
  workspace_overview::{OverviewPage, WorkspaceOverviewService, WorkspaceOverviewSource, compose_workspace_overview},
};
use myoxus_domain::entities::Workspace;
use myoxus_infrastructure::document_metadata_policy::PgDocumentMetadataPolicyRepository;
use myoxus_public_render::{
  HtmlRenderer, PublicBreadcrumb, PublicDocIr, PublicSiteShellOptions, WorkspaceIndex, WorkspaceIndexFolder,
  WorkspaceIndexItem, apply_public_asset_url, public_document_path, public_folder_path, render_workspace_index_html,
};

pub(super) type SnapshotIntroductions = BTreeMap<Uuid, (PublicDocIr, Vec<PublicStaticAsset>)>;

pub(super) fn overview_reader(services: &Services) -> WorkspaceOverviewService {
  WorkspaceOverviewService::new(
    services.workspace.clone(),
    services.doc.clone(),
    DocumentMetadataPolicyService::new(Arc::new(PgDocumentMetadataPolicyRepository::new(services.pool.clone()))),
    services.workspace_tags(),
    services.auth.clone(),
  )
}

/// Preserve existing single-component ASCII keys. The reserved namespace also keeps arbitrary
/// external keys (including dot segments, separators and oversized names) from
/// escaping staging or colliding with derived folders. Key fallbacks never use
/// internal document UUIDs.
pub(super) fn snapshot_document_segment(key: &str) -> String {
  if !key.is_empty()
    && key.len() <= 255
    && key != "."
    && key != ".."
    && !key.eq_ignore_ascii_case("index.html")
    && key
      .bytes()
      .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
  {
    key.to_string()
  } else {
    format!("~doc-{}", hex_hash(key))
  }
}

fn hex_hash(value: &str) -> String {
  format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn folder_segment(id: &str) -> String {
  format!("~folders/{}", hex_hash(id))
}

pub(super) struct SnapshotOverviewWriter<'a> {
  pub args: &'a PublicExportArgs,
  pub renderer: &'a HtmlRenderer,
  pub staging_dir: &'a Path,
  pub theme_file: &'a str,
  pub locale: &'a str,
  pub introductions: &'a SnapshotIntroductions,
  pub emitted: &'a BTreeSet<(Uuid, Uuid)>,
  pub source_origin: &'a str,
}

impl SnapshotOverviewWriter<'_> {
  pub fn write(&self, mut source: WorkspaceOverviewSource) -> Result<Vec<PublicWorkspaceRoute>> {
    source.documents.retain(|document| {
      self
        .emitted
        .contains(&(document.reference.workspace_id(), document.doc_id))
    });
    // Reuse the captured versioned metadata and presentation for every page;
    // the live reader’s PageRequest must never truncate a retained snapshot.
    let overview = compose_workspace_overview(
      &source.organizer,
      &source.workspace.overview_settings,
      source.documents,
      true,
    )?;
    std::iter::once(&overview.root)
      .chain(&overview.folders)
      .map(|page| self.write_page(&source.workspace, page))
      .collect()
  }

  fn write_page(&self, workspace: &Workspace, page: &OverviewPage) -> Result<PublicWorkspaceRoute> {
    let is_folder = page.folder.is_some();
    let prefix = if is_folder { "../../../../" } else { "../../" };
    let workspace_href = if is_folder { "../../index.html" } else { "index.html" };
    let folder_href = |id: &str| {
      if is_folder {
        format!("../{}/index.html", hex_hash(id))
      } else {
        format!("{}/index.html", folder_segment(id))
      }
    };
    let introduction = page
      .introduction
      .as_ref()
      .and_then(|document| self.introductions.get(&document.doc_id))
      .map(|(ir, assets)| {
        let mut ir = ir.clone();
        for asset in assets {
          apply_public_asset_url(
            &mut ir,
            &asset.blob_key,
            &format!("{prefix}{}", asset.route.trim_start_matches('/')),
          );
        }
        ir
      });
    let index = WorkspaceIndex {
      document_count: page.documents.len(),
      previous_page: None,
      next_page: None,
      register_columns: myoxus_application::workspace_overview::public_register_columns(page),
      workspace_id: workspace.id,
      title: workspace.name.clone(),
      description: if is_folder {
        String::new()
      } else {
        workspace.description.clone()
      },
      folder_title: page.folder.as_ref().map(|folder| folder.name.clone()),
      introduction,
      folders: page
        .children
        .iter()
        .map(|folder| WorkspaceIndexFolder {
          title: folder.name.clone(),
          href: folder_href(&folder.id),
        })
        .collect(),
      items: page
        .documents
        .iter()
        .map(|doc| {
          let href = if doc.reference.workspace_id() == workspace.id {
            format!(
              "{}{}/index.html",
              if is_folder { "../../" } else { "" },
              snapshot_document_segment(doc.reference.resource_id())
            )
          } else {
            // A qualified reference keeps its source authority even when another
            // workspace happens to be included in this diagnostic snapshot.
            canonical_public_url(
              Some(self.source_origin),
              &public_document_path(doc.reference.workspace_id(), doc.reference.resource_id()),
            )
          };
          WorkspaceIndexItem {
            register: myoxus_application::workspace_overview::public_register_values(doc, page),
            href: Some(href),
            doc_id: doc.doc_id,
            route_key: doc.reference.resource_id().to_string(),
            title: doc.title.clone(),
            public_mode: doc.public_mode.clone().unwrap_or_else(|| "Page".into()),
          }
        })
        .collect(),
    };
    let root_route = format!("/public/{}", workspace.id);
    let route = page.folder.as_ref().map_or_else(
      || root_route.clone(),
      |folder| format!("{root_route}/{}", folder_segment(&folder.id)),
    );
    let canonical_route = page
      .folder
      .as_ref()
      .map_or_else(|| root_route, |folder| public_folder_path(workspace.id, &folder.id));
    let mut shell = PublicSiteShellOptions {
      asset_base_url: Some(format!("{prefix}assets")),
      search_bundle_url: search_bundle_url(self.args, prefix),
      toc_enabled: false,
      ..PublicSiteShellOptions::default()
    };
    if is_folder {
      shell.breadcrumbs.push(PublicBreadcrumb {
        label: workspace.name.clone(),
        href: Some(workspace_href.into()),
      });
      for (position, ancestor) in page.breadcrumbs.iter().enumerate() {
        shell.breadcrumbs.push(PublicBreadcrumb {
          label: ancestor.name.clone(),
          href: (position + 1 < page.breadcrumbs.len()).then(|| folder_href(&ancestor.id)),
        });
      }
    }
    let rendered = render_workspace_index_html(
      self.renderer,
      &index,
      &html_options(
        self.args,
        &canonical_route,
        &format!("{prefix}theme/{}", self.theme_file),
        &format!("{prefix}favicon.ico"),
        self.locale,
        shell,
      ),
    )
    .map_err(anyhow::Error::msg)?;
    write_html(self.staging_dir, &route, &rendered.html)?;
    Ok(PublicWorkspaceRoute {
      workspace_id: workspace.id,
      route,
      title: page
        .folder
        .as_ref()
        .map_or_else(|| workspace.name.clone(), |folder| folder.name.clone()),
      folder_id: page.folder.as_ref().map(|folder| folder.id.clone()),
    })
  }
}
