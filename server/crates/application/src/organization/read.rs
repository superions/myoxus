// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared organization discovery. Adapters retain their authorization and output
//! contracts; bounded repository reads and safe profile hydration live here.

use std::sync::Arc;

use crate::auth::AuthService;
use myoxus_domain::entities::{
  Organization, OrganizationUnit, OrganizationUnitMember, OrganizationUnitRole, OrganizationUnitStatus,
  OrganizationUnitType,
};
use myoxus_domain::ids::{OrganizationUnitId, UserId};
use myoxus_domain::repositories::{
  OrganizationRepository, OrganizationUnitMemberRepository, OrganizationUnitRepository, OrganizationUnitTypeRepository,
  RepoResult, RepositoryError,
};
use serde::Serialize;
use tracing::instrument;

#[derive(Clone)]
pub struct OrganizationReadService {
  organizations: Arc<dyn OrganizationRepository>,
  types: Arc<dyn OrganizationUnitTypeRepository>,
  units: Arc<dyn OrganizationUnitRepository>,
  members: Arc<dyn OrganizationUnitMemberRepository>,
  auth: AuthService,
}

/// Only the selected page is hydrated. Auth records (including password hashes)
/// are never retained in or serialized through this public projection.
#[derive(Debug, Clone, Serialize)]
pub struct OrganizationMemberProfile {
  pub membership: OrganizationUnitMember,
  pub email: Option<String>,
  pub name: Option<String>,
  pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserOrganizationAssignment {
  pub membership: OrganizationUnitMember,
  pub unit: OrganizationUnit,
}

#[derive(Debug, Serialize)]
pub struct OrganizationReadPage<T> {
  pub items: Vec<T>,
  pub offset: i64,
  pub limit: i64,
  pub next_offset: Option<i64>,
}

fn validate_page(offset: i64, limit: i64) -> RepoResult<()> {
  if !(1..=100).contains(&limit) || !(0..=i64::MAX - 101).contains(&offset) {
    return Err(RepositoryError::Validation(
      "offset must be nonnegative and limit must be 1..100".into(),
    ));
  }
  Ok(())
}

fn page<T>(mut items: Vec<T>, offset: i64, limit: i64) -> OrganizationReadPage<T> {
  let next_offset = (items.len() > limit as usize).then_some(offset + limit);
  items.truncate(limit as usize);
  OrganizationReadPage {
    items,
    offset,
    limit,
    next_offset,
  }
}

impl OrganizationReadService {
  pub fn new(
    organizations: Arc<dyn OrganizationRepository>,
    types: Arc<dyn OrganizationUnitTypeRepository>,
    units: Arc<dyn OrganizationUnitRepository>,
    members: Arc<dyn OrganizationUnitMemberRepository>,
    auth: AuthService,
  ) -> Self {
    Self {
      organizations,
      types,
      units,
      members,
      auth,
    }
  }

  #[instrument(skip(self), err)]
  pub async fn default_organization(&self) -> RepoResult<Organization> {
    self
      .organizations
      .get_by_key("myoxus")
      .await?
      .ok_or(RepositoryError::NotFound("organization"))
  }

  #[instrument(skip(self), err)]
  pub async fn unit_types_page(
    &self,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<OrganizationReadPage<OrganizationUnitType>> {
    validate_page(offset, limit)?;
    let org = self.default_organization().await?;
    Ok(page(
      self
        .types
        .list_page(org.id, include_inactive, offset, limit + 1)
        .await?,
      offset,
      limit,
    ))
  }

  /// Existing unpaged GraphQL/CLI contracts exhaust pages rather than truncate.
  #[instrument(skip(self), err)]
  pub async fn unit_types(&self, include_inactive: bool) -> RepoResult<Vec<OrganizationUnitType>> {
    let mut all = Vec::new();
    let mut offset = 0;
    loop {
      let p = self.unit_types_page(include_inactive, offset, 100).await?;
      all.extend(p.items);
      match p.next_offset {
        Some(next) => offset = next,
        None => return Ok(all),
      }
    }
  }

  async fn hydrate_members(
    &self,
    memberships: Vec<OrganizationUnitMember>,
  ) -> RepoResult<Vec<OrganizationMemberProfile>> {
    let ids = memberships.iter().map(|m| m.user_id).collect::<Vec<_>>();
    let profiles = self
      .auth
      .store
      .get_users_by_ids(&ids)
      .await
      .map_err(|e| RepositoryError::Storage(e.to_string()))?;
    Ok(
      memberships
        .into_iter()
        .map(|membership| {
          let user = profiles.get(&membership.user_id);
          OrganizationMemberProfile {
            email: user.map(|u| u.email.clone()),
            name: user.and_then(|u| u.name.clone()),
            avatar_url: user.and_then(|u| u.avatar_url.clone()),
            membership,
          }
        })
        .collect(),
    )
  }

  #[instrument(skip(self), err)]
  pub async fn unit_members_page(
    &self,
    unit: OrganizationUnitId,
    role: Option<OrganizationUnitRole>,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<OrganizationReadPage<OrganizationMemberProfile>> {
    validate_page(offset, limit)?;
    let unit_row = self
      .units
      .get_by_id(unit)
      .await?
      .ok_or(RepositoryError::NotFound("organization_unit"))?;
    if !include_inactive && unit_row.status != OrganizationUnitStatus::Active {
      return Err(RepositoryError::Conflict("ORGANIZATION_UNIT_INACTIVE"));
    }
    let p = page(
      self.members.list_members_page(unit, role, offset, limit + 1).await?,
      offset,
      limit,
    );
    Ok(OrganizationReadPage {
      items: self.hydrate_members(p.items).await?,
      offset: p.offset,
      limit: p.limit,
      next_offset: p.next_offset,
    })
  }

  #[instrument(skip(self), err)]
  pub async fn unit_members(
    &self,
    unit: OrganizationUnitId,
    role: Option<OrganizationUnitRole>,
  ) -> RepoResult<Vec<OrganizationMemberProfile>> {
    let mut all = Vec::new();
    let mut offset = 0;
    loop {
      let p = page(
        self.members.list_members_page(unit, role, offset, 101).await?,
        offset,
        100,
      );
      all.extend(self.hydrate_members(p.items).await?);
      match p.next_offset {
        Some(next) => offset = next,
        None => return Ok(all),
      }
    }
  }

  #[instrument(skip(self), err)]
  pub async fn user_memberships_page(
    &self,
    user: UserId,
    include_inactive: bool,
    offset: i64,
    limit: i64,
  ) -> RepoResult<OrganizationReadPage<UserOrganizationAssignment>> {
    validate_page(offset, limit)?;
    let p = page(
      self
        .members
        .list_for_user_page(user, include_inactive, offset, limit + 1)
        .await?,
      offset,
      limit,
    );
    let ids = p.items.iter().map(|m| m.unit_id).collect::<Vec<_>>();
    let units = self
      .units
      .get_by_ids(&ids)
      .await?
      .into_iter()
      .map(|u| (u.id, u))
      .collect::<std::collections::HashMap<_, _>>();
    let items = p
      .items
      .into_iter()
      .map(|membership| {
        let unit = units
          .get(&membership.unit_id)
          .cloned()
          .ok_or(RepositoryError::NotFound("organization_unit"))?;
        Ok(UserOrganizationAssignment { membership, unit })
      })
      .collect::<RepoResult<Vec<_>>>()?;
    Ok(OrganizationReadPage {
      items,
      offset: p.offset,
      limit: p.limit,
      next_offset: p.next_offset,
    })
  }

  /// Preserve Admin's diagnostic assignments and OU-name ordering.
  #[instrument(skip(self), err)]
  pub async fn user_memberships(&self, user: UserId) -> RepoResult<Vec<UserOrganizationAssignment>> {
    let mut all = Vec::new();
    let mut offset = 0;
    loop {
      let p = self.user_memberships_page(user, true, offset, 100).await?;
      all.extend(p.items);
      match p.next_offset {
        Some(next) => offset = next,
        None => return Ok(all),
      }
    }
  }
}
