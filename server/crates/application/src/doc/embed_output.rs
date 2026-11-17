// SPDX-License-Identifier: AGPL-3.0-or-later
//! Selected embeds feed existing reading renderers, never the persisted host.
use base64::Engine;
use myoxus_domain::{document_key::DocumentKey, permission::DocAction};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{DocService, DocSpaceKind};
use crate::{
  auth::{AuthError, AuthResult},
  document_fields::context::DocumentFieldResolver,
  permission::{AccessController, DocResource, PermissionService},
  ports::blob_service::BlobService,
  public::PublicRepository,
  workspace_content_operation::redirect::WorkspaceContentRedirectService,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreparedEmbedOutput {
  workspace_id: Uuid,
  doc_id: Uuid,
  outputs: Vec<(yjs::document_embed::Definition, Option<Vec<yjs::PortableSnapshotBlock>>)>,
  dependencies: Vec<(Uuid, Uuid)>,
}
impl PreparedEmbedOutput {
  /// Only admitted output bodies can bind inline images in a public renderer.
  /// The flattened native capture already includes images nested in containers.
  pub fn image_sources(&self) -> impl Iterator<Item = &str> {
    self
      .outputs
      .iter()
      .filter_map(|(_, body)| body.as_ref())
      .flatten()
      .filter(|block| block.flavour == "myoxus:image")
      .filter_map(|block| block.props.get("sourceId").and_then(serde_json::Value::as_str))
      .filter(|source| source.starts_with("data:image/"))
      .filter(|source| crate::markdown::decode_data_image(source).is_ok())
  }

  pub fn apply(&self, snapshot: &[u8], workspace_id: Uuid, doc_id: Uuid) -> AuthResult<Vec<u8>> {
    if (workspace_id, doc_id) != (self.workspace_id, self.doc_id) {
      return Err(unavailable());
    }
    yjs::document_embed::project(snapshot, &self.outputs).map_err(|_| unavailable())
  }

  /// A captured PDF must not remain downloadable after a dependency is revoked.
  pub async fn authorize(&self, permission: &PermissionService, doc: &DocService, actor: Uuid) -> AuthResult<()> {
    for &(workspace_id, doc_id) in &self.dependencies {
      let metadata = doc.get_metadata(doc_id).await?.ok_or_else(unavailable)?;
      if metadata.workspace_id != Some(workspace_id) || metadata.deleted_at.is_some() {
        return Err(unavailable());
      }
      permission
        .assert(
          &DocResource {
            user_id: actor,
            workspace_id,
            doc_id,
          },
          DocAction::Read,
        )
        .await?;
    }
    Ok(())
  }
}

fn unavailable() -> AuthError {
  AuthError::InvalidInput("selected document output unavailable".into())
}

pub async fn authorize_render_inputs(
  inputs: &serde_json::Value,
  permission: &PermissionService,
  doc: &DocService,
  actor: Uuid,
) -> AuthResult<()> {
  if let Some(output) = inputs.get("document_embed_output") {
    let prepared: PreparedEmbedOutput = serde_json::from_value(output.clone()).map_err(|_| unavailable())?;
    prepared.authorize(permission, doc, actor).await?;
  }
  Ok(())
}

/// Borrow the current document, ACL, field and asset owners. `actor == None`
/// uses anonymous publication admission, never the containing page's publisher.
pub struct EmbedOutputContext<'a> {
  pub doc: &'a DocService,
  pub permission: &'a PermissionService,
  pub public: &'a dyn PublicRepository,
  pub fields: Option<&'a DocumentFieldResolver>,
  pub blobs: &'a BlobService,
  pub redirects: Option<&'a WorkspaceContentRedirectService>,
  pub actor: Option<Uuid>,
}
impl EmbedOutputContext<'_> {
  #[tracing::instrument(skip_all)]
  pub async fn prepare(
    &self,
    snapshot: &[u8],
    workspace_id: Uuid,
    doc_id: Uuid,
  ) -> AuthResult<Option<PreparedEmbedOutput>> {
    let definitions = yjs::document_embed::inspect(snapshot).map_err(|_| unavailable())?;
    if definitions.is_empty() {
      return Ok(None);
    }
    let mut size = 0usize;
    let mut prepared = PreparedEmbedOutput {
      workspace_id,
      doc_id,
      outputs: Vec::new(),
      dependencies: Vec::new(),
    };
    for definition in definitions {
      // Failure is deliberately neutral: no cached title, alias or body can
      // survive denied, malformed, deleted, cyclic or unavailable selections.
      let body = match self.selected_body(&definition, workspace_id, doc_id).await {
        Ok((body, source)) => {
          size = size.saturating_add(serde_json::to_vec(&body).map_err(|_| unavailable())?.len());
          if size > super::DEFAULT_DOCUMENT_EXPORT_MAX_BYTES {
            return Err(unavailable());
          }
          prepared.dependencies.push(source);
          Some(body)
        }
        Err(_) => None,
      };
      prepared.outputs.push((definition, body));
    }
    Ok(Some(prepared))
  }

  async fn admit(&self, workspace_id: Uuid, doc_id: Uuid, snapshot: &[u8]) -> AuthResult<()> {
    if let Some(user_id) = self.actor {
      self
        .permission
        .assert(
          &DocResource {
            user_id,
            workspace_id,
            doc_id,
          },
          DocAction::Read,
        )
        .await
    } else if self
      .public
      .decide_document(workspace_id, doc_id, crate::public::source_hash(snapshot))
      .await
      .map_err(|_| unavailable())?
      .allowed()
      .is_some()
    {
      Ok(())
    } else {
      Err(unavailable())
    }
  }

  async fn selected_body(
    &self,
    definition: &yjs::document_embed::Definition,
    host_workspace: Uuid,
    host_doc: Uuid,
  ) -> AuthResult<(Vec<yjs::PortableSnapshotBlock>, (Uuid, Uuid))> {
    use myoxus_domain::workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef};
    let mut workspace_id = definition
      .workspace_id
      .as_deref()
      .map(Uuid::parse_str)
      .transpose()
      .map_err(|_| unavailable())?
      .unwrap_or(host_workspace);
    let mut key = DocumentKey::parse(&definition.page_id).map_err(|_| unavailable())?;
    if let (Some(actor), Some(redirects)) = (self.actor, self.redirects) {
      let source = WorkspaceContentResourceRef::new(
        workspace_id,
        WorkspaceContentResourceKind::Document,
        definition.page_id.clone(),
      )
      .map_err(|_| unavailable())?;
      let target = redirects.resolve(actor.into(), source).await?;
      workspace_id = target.workspace_id();
      key = DocumentKey::parse(target.resource_id()).map_err(|_| unavailable())?;
    }
    let doc_id = self
      .doc
      .resolve_document_key(workspace_id, DocSpaceKind::Workspace, &key)
      .await?
      .ok_or_else(unavailable)?;
    if (workspace_id, doc_id) == (host_workspace, host_doc) {
      return Err(unavailable());
    }
    if let Some(user_id) = self.actor {
      self
        .permission
        .assert(
          &DocResource {
            user_id,
            workspace_id,
            doc_id,
          },
          DocAction::Read,
        )
        .await?;
    }
    let source = self.doc.load_full_doc_with_meta(workspace_id, doc_id).await?;
    if !source.exists {
      return Err(unavailable());
    }
    self.admit(workspace_id, doc_id, &source.payload).await?;
    let selected =
      yjs::markdown::selected_document_snapshot(&source.payload, &definition.params).map_err(|_| unavailable())?;
    let fields = yjs::document_field::content::inspect(&selected).map_err(|_| unavailable())?;
    let selected = if fields.is_empty() {
      selected
    } else {
      let context = self
        .fields
        .ok_or_else(unavailable)?
        .resolve_authorized(
          workspace_id,
          doc_id,
          super::canonical_yjs_revision(&selected).map_err(|_| unavailable())?,
          &fields.into_iter().map(|field| field.run.descriptor).collect::<Vec<_>>(),
          self.actor,
        )
        .await?;
      crate::document_fields::output::current_snapshot(&selected, &context).map_err(|_| unavailable())?
    };
    // Qualify native links with their source workspace using the existing exact
    // occurrence rewriter. Nested embeds stay at the existing one-level limit.
    let mut rewrites = yjs::extract_document_references_from_yjs(&selected)
      .map_err(|_| unavailable())?
      .occurrences
      .into_iter()
      .filter(|reference| reference.target_workspace_id.is_none())
      .map(|reference| yjs::NativeReferenceRewrite {
        position: reference.position,
        expected_id: reference.raw_target_doc_id.clone(),
        expected_workspace_id: None,
        replacement: Some(yjs::NativeReferenceReplacement {
          id: reference.raw_target_doc_id,
          workspace_id: Some(workspace_id.to_string()),
        }),
      })
      .collect::<Vec<_>>();
    let mut bytes = 0usize;
    for asset in yjs::extract_portable_asset_references(&selected).map_err(|_| unavailable())? {
      // A page's read grant does not authorize arbitrary foreign-workspace blobs.
      if asset
        .workspace_id
        .as_deref()
        .is_some_and(|id| id != workspace_id.to_string())
      {
        return Err(unavailable());
      }
      let blob = self
        .blobs
        .get_blob_bounded(
          workspace_id,
          &asset.source_key,
          (super::DEFAULT_DOCUMENT_EXPORT_MAX_BYTES - bytes) as u64,
        )
        .await?;
      bytes = bytes.saturating_add(blob.data.len());
      let mime = blob
        .content_type
        .as_deref()
        .filter(|mime| crate::markdown::image_extension_for_mime(mime).is_some())
        .ok_or_else(unavailable)?;
      let data = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&blob.data)
      );
      rewrites.push(yjs::NativeReferenceRewrite {
        position: asset.position,
        expected_id: asset.raw_source_key,
        expected_workspace_id: asset.workspace_id,
        replacement: Some(yjs::NativeReferenceReplacement {
          id: data,
          workspace_id: None,
        }),
      });
    }
    let selected = if rewrites.is_empty() {
      selected
    } else {
      yjs::rewrite_native_references(&selected, &rewrites, 0x454d424544)
        .map_err(|_| unavailable())?
        .full_state
    };
    self.admit(workspace_id, doc_id, &source.payload).await?;
    Ok((
      yjs::document_embed::body(&selected).map_err(|_| unavailable())?,
      (workspace_id, doc_id),
    ))
  }
}
