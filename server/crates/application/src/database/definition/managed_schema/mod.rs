// SPDX-License-Identifier: AGPL-3.0-or-later

//! Native installation, structural verification, pinned-edge planning and
//! committed reconciliation retain one Definition persistence boundary.
mod installation;
mod planning;
mod reconcile;
mod verification;

pub(crate) use installation::{install_source_metadata, install_source_metadata_at};
pub use reconcile::{DatabaseManagedInitializationReport, DatabaseManagedReconciliation, reconcile_managed_database};
pub(in crate::database::definition) use verification::assert_metadata_lifecycle_edit;
pub(in crate::database) use verification::assert_structure_edit;
pub(crate) use verification::{expected_state_at, structural_value};
