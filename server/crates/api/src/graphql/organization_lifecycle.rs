// SPDX-License-Identifier: AGPL-3.0-or-later
//! GraphQL projection for the authoritative organization-unit lifecycle.

use async_graphql::{Error, ErrorExtensions, ID, SimpleObject};
use chrono::{DateTime, Utc};

use myoxus_application::organization::OrganizationUnitLifecycleError;
use myoxus_domain::entities::{OrganizationUnitDeletionBlocker, OrganizationUnitDeletionPreview};

use super::organization::OrganizationUnitStatusEnum;

#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitDeletionBlockerType {
  pub code: String,
  pub count: i64,
}

impl From<OrganizationUnitDeletionBlocker> for OrganizationUnitDeletionBlockerType {
  fn from(blocker: OrganizationUnitDeletionBlocker) -> Self {
    Self {
      code: blocker.code.as_str().to_string(),
      count: blocker.count,
    }
  }
}

#[derive(SimpleObject, Clone)]
pub struct OrganizationUnitDeletionPreviewType {
  pub id: ID,
  pub name: String,
  pub status: OrganizationUnitStatusEnum,
  pub updated_at: DateTime<Utc>,
  pub deletable: bool,
  pub blockers: Vec<OrganizationUnitDeletionBlockerType>,
}

impl From<OrganizationUnitDeletionPreview> for OrganizationUnitDeletionPreviewType {
  fn from(preview: OrganizationUnitDeletionPreview) -> Self {
    Self {
      id: ID(preview.id.to_string()),
      name: preview.name,
      status: preview.status.into(),
      updated_at: preview.updated_at,
      deletable: preview.deletable,
      blockers: preview.blockers.into_iter().map(Into::into).collect(),
    }
  }
}

pub(crate) fn map_lifecycle_error(error: OrganizationUnitLifecycleError) -> Error {
  let code = error.code();
  Error::new(error.to_string()).extend_with(|_, extensions| {
    extensions.set("code", code);
  })
}
