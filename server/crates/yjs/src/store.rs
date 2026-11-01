//! In-memory Yjs document store for real-time collaboration.
//!
//! [`YjsDocStore`] maintains a map of space IDs to [`YjsDoc`] instances.
//! [`YjsDoc`] wraps a `yrs::Doc` behind a `tokio::sync::RwLock`, allowing
//! concurrent readers and serialised writers for applying incremental updates
//! and encoding full document state vectors.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

#[derive(Clone)]
pub struct YjsDoc {
  inner: Arc<RwLock<Doc>>,
}

impl YjsDoc {
  pub fn new() -> Self {
    Self {
      inner: Arc::new(RwLock::new(Doc::new())),
    }
  }

  pub fn from_state(state: &[u8]) -> Result<Self, yrs::error::Error> {
    let doc = Doc::new();
    {
      let mut txn = doc.transact_mut();
      let update = <Update as Decode>::decode_v1(state)?;
      txn.apply_update(update)?;
    }
    Ok(Self {
      inner: Arc::new(RwLock::new(doc)),
    })
  }

  pub async fn apply_update(&self, update: &[u8]) -> Result<(), yrs::error::Error> {
    let doc = self.inner.write().await;
    let mut txn = doc.transact_mut();
    let update = <Update as Decode>::decode_v1(update)?;
    txn.apply_update(update)?;
    Ok(())
  }

  pub async fn get_state(&self) -> Vec<u8> {
    let doc = self.inner.read().await;
    let txn = doc.transact();
    txn.encode_state_as_update_v1(&StateVector::default())
  }

  pub async fn get_state_diff(&self, state_vector: &[u8]) -> Result<Vec<u8>, yrs::encoding::read::Error> {
    let doc = self.inner.read().await;
    let txn = doc.transact();
    let sv = <StateVector as Decode>::decode_v1(state_vector)?;
    Ok(txn.encode_state_as_update_v1(&sv))
  }
}

impl Default for YjsDoc {
  fn default() -> Self {
    Self::new()
  }
}

pub struct YjsStore {
  docs: Arc<RwLock<HashMap<String, YjsDoc>>>,
}

impl YjsStore {
  pub fn new() -> Self {
    Self {
      docs: Arc::new(RwLock::new(HashMap::new())),
    }
  }

  pub async fn get_or_create_doc(&self, doc_id: &str) -> YjsDoc {
    let mut docs = self.docs.write().await;
    docs.entry(doc_id.to_string()).or_insert_with(YjsDoc::new).clone()
  }

  pub async fn load_doc(&self, doc_id: &str, state: &[u8]) -> Result<YjsDoc, yrs::error::Error> {
    let mut docs = self.docs.write().await;
    let doc = YjsDoc::from_state(state)?;
    docs.insert(doc_id.to_string(), doc.clone());
    Ok(doc)
  }

  pub async fn remove_doc(&self, doc_id: &str) {
    let mut docs = self.docs.write().await;
    docs.remove(doc_id);
  }
}

impl Default for YjsStore {
  fn default() -> Self {
    Self::new()
  }
}

pub type SharedYjsStore = Arc<YjsStore>;
