use std::collections::HashSet;

use memory_indexer::{InMemoryIndex, SearchHit, SnapshotData};
use myoxus_doc_indexer::{BlockInfo, CrawlResult, ParseError, parse_doc_from_binary};
use napi_derive::napi;
use serde::Serialize;
use sqlx::Row;
use yrs::{Doc, Options, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

use super::{
  error::{Error, Result},
  storage::SqliteDocStorage,
};

// Search snapshots are derived cache data. The memory-indexer snapshot version
// is the only format version: changing the container or payload must bump it at
// the owner rather than introducing a second compatibility/version system here.
const INDEX_SNAPSHOT_MAGIC: &[u8] = b"MYOXUS_INDEX\0";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum IndexAvailability {
  Ready = 0,
  Rebuilding = 1,
  Failed = 2,
}

impl IndexAvailability {
  pub fn from_u8(value: u8) -> Self {
    match value {
      1 => Self::Rebuilding,
      2 => Self::Failed,
      _ => Self::Ready,
    }
  }

  pub fn as_str(self) -> &'static str {
    match self {
      Self::Ready => "ready",
      Self::Rebuilding => "rebuilding",
      Self::Failed => "failed",
    }
  }
}

fn encode_snapshot(snapshot: &SnapshotData) -> Result<Vec<u8>> {
  let payload = serde_json::to_vec(snapshot).map_err(|error| Error::Serialization(error.to_string()))?;
  let compressed = zstd::stream::encode_all(std::io::Cursor::new(payload), 4)
    .map_err(|error| Error::Serialization(error.to_string()))?;
  let mut encoded = Vec::with_capacity(INDEX_SNAPSHOT_MAGIC.len() + size_of::<u32>() + compressed.len());
  encoded.extend_from_slice(INDEX_SNAPSHOT_MAGIC);
  encoded.extend_from_slice(&InMemoryIndex::snapshot_version().to_le_bytes());
  encoded.extend_from_slice(&compressed);
  Ok(encoded)
}

fn decode_snapshot(encoded: &[u8]) -> Result<SnapshotData> {
  let version_offset = INDEX_SNAPSHOT_MAGIC.len();
  let payload_offset = version_offset + size_of::<u32>();
  if encoded.len() < payload_offset || &encoded[..version_offset] != INDEX_SNAPSHOT_MAGIC {
    return Err(Error::Serialization("invalid index snapshot prefix".to_string()));
  }

  let version = u32::from_le_bytes(
    encoded[version_offset..payload_offset]
      .try_into()
      .map_err(|_| Error::Serialization("invalid index snapshot version".to_string()))?,
  );
  if version != InMemoryIndex::snapshot_version() {
    return Err(Error::Serialization("unsupported index snapshot version".to_string()));
  }

  let payload = zstd::stream::decode_all(std::io::Cursor::new(&encoded[payload_offset..]))
    .map_err(|error| Error::Serialization(error.to_string()))?;
  let snapshot: SnapshotData =
    serde_json::from_slice(&payload).map_err(|error| Error::Serialization(error.to_string()))?;
  if snapshot.version != version {
    return Err(Error::Serialization(
      "index snapshot payload version mismatch".to_string(),
    ));
  }
  Ok(snapshot)
}

#[napi(object)]
#[derive(Debug, Serialize)]
pub struct NativeBlockInfo {
  pub block_id: String,
  pub flavour: String,
  pub content: Option<Vec<String>>,
  pub blob: Option<Vec<String>>,
  pub ref_doc_id: Option<Vec<String>>,
  pub ref_info: Option<Vec<String>>,
  pub parent_flavour: Option<String>,
  pub parent_block_id: Option<String>,
  pub additional: Option<String>,
}

impl From<BlockInfo> for NativeBlockInfo {
  fn from(value: BlockInfo) -> Self {
    Self {
      block_id: value.block_id,
      flavour: value.flavour,
      content: value.content,
      blob: value.blob,
      ref_doc_id: value.ref_doc_id,
      ref_info: value.ref_info,
      parent_flavour: value.parent_flavour,
      parent_block_id: value.parent_block_id,
      additional: value.additional,
    }
  }
}

#[napi(object)]
#[derive(Debug, Serialize)]
pub struct NativeCrawlResult {
  pub blocks: Vec<NativeBlockInfo>,
  pub title: String,
  pub summary: String,
}

impl From<CrawlResult> for NativeCrawlResult {
  fn from(value: CrawlResult) -> Self {
    Self {
      blocks: value.blocks.into_iter().map(Into::into).collect(),
      title: value.title,
      summary: value.summary,
    }
  }
}

#[napi(object)]
#[derive(Debug, Serialize)]
pub struct NativeSearchHit {
  pub id: String,
  pub score: f64,
  pub terms: Vec<String>,
}

impl From<SearchHit> for NativeSearchHit {
  fn from(value: SearchHit) -> Self {
    Self {
      id: value.doc_id,
      score: value.score,
      terms: value.matched_terms.into_iter().map(|t| t.term).collect(),
    }
  }
}

#[napi(object)]
#[derive(Debug, Serialize)]
pub struct NativeMatch {
  pub start: u32,
  pub end: u32,
}

impl From<(u32, u32)> for NativeMatch {
  fn from(value: (u32, u32)) -> Self {
    Self {
      start: value.0,
      end: value.1,
    }
  }
}

impl SqliteDocStorage {
  pub async fn crawl_doc_data(&self, doc_id: &str) -> Result<NativeCrawlResult> {
    let doc_bin = self.load_doc_binary(doc_id).await?.ok_or(ParseError::DocNotFound)?;

    let result = parse_doc_from_binary(doc_bin, doc_id.to_string())?;
    Ok(result.into())
  }

  async fn load_doc_binary(&self, doc_id: &str) -> Result<Option<Vec<u8>>> {
    let snapshot = self.get_doc_snapshot(doc_id.to_string()).await?;
    let mut updates = self.get_doc_updates(doc_id.to_string()).await?;

    if snapshot.is_none() && updates.is_empty() {
      return Ok(None);
    }

    updates.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

    let mut segments = Vec::with_capacity(snapshot.as_ref().map(|_| 1).unwrap_or(0) + updates.len());
    if let Some(record) = snapshot {
      segments.push(record.bin.to_vec());
    }
    segments.extend(updates.into_iter().map(|update| update.bin.to_vec()));

    merge_updates(segments, doc_id).map(Some)
  }

  pub async fn init_index(&self) -> Result<()> {
    let snapshots = sqlx::query("SELECT index_name, data FROM idx_snapshots")
      .fetch_all(&self.pool)
      .await?;
    let has_indexed_clocks: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM indexer_sync LIMIT 1)")
      .fetch_one(&self.pool)
      .await?;

    if snapshots.is_empty() {
      if has_indexed_clocks {
        self.begin_index_rebuild().await?;
      } else {
        self.set_index_availability(IndexAvailability::Ready);
      }
      return Ok(());
    }

    // Decode the complete snapshot set before touching the in-memory index. A
    // single invalid row invalidates the set so queries can never observe a
    // mixture of old, empty, and current indexes.
    let mut decoded = Vec::with_capacity(snapshots.len());
    for row in snapshots {
      let index_name: String = row.get("index_name");
      let data: Vec<u8> = row.get("data");
      let Ok(snapshot) = decode_snapshot(&data) else {
        self.begin_index_rebuild().await?;
        return Ok(());
      };
      decoded.push((index_name, snapshot));
    }

    let mut index = self.index.write().await;
    for (index_name, snapshot) in decoded {
      index.load_snapshot(&index_name, snapshot);
    }
    self.set_index_availability(IndexAvailability::Ready);
    Ok(())
  }

  async fn begin_index_rebuild(&self) -> Result<()> {
    // Document, blob, and peer clocks are authoritative sync state and remain
    // untouched. Only derived index clocks are cleared so IndexerSync crawls
    // every document again. The unreadable cache row is retained until the
    // replacement transaction commits, which keeps failures diagnosable and
    // prevents a partial rebuild from being mistaken for an empty valid index.
    // Publish the fail-closed state before clearing memory. Otherwise a query
    // racing this transition could observe the new empty index as `ready`.
    self.set_index_availability(IndexAvailability::Rebuilding);
    let mut transaction = self.pool.begin().await?;
    sqlx::query("DELETE FROM indexer_sync")
      .execute(&mut *transaction)
      .await?;
    transaction.commit().await?;
    *self.index.write().await = InMemoryIndex::default();
    Ok(())
  }

  async fn persist_indexes(&self, replace_all: bool) -> Result<()> {
    // Keep the write lock through commit. Otherwise a concurrent mutation could
    // arrive after serialization and have its dirty marker cleared by this flush.
    let mut index = self.index.write().await;
    let names: HashSet<String> = if replace_all {
      index.indexes.keys().cloned().collect()
    } else {
      index
        .indexes
        .iter()
        .filter(|(_, state)| !state.dirty.is_empty() || !state.deleted.is_empty())
        .map(|(name, _)| name.clone())
        .collect()
    };
    if names.is_empty() && !replace_all {
      return Ok(());
    }

    let snapshots = names
      .iter()
      .map(|name| {
        index
          .get_snapshot_data(name)
          .map(|snapshot| encode_snapshot(&snapshot))
          .transpose()
          .map(|encoded| (name.clone(), encoded))
      })
      .collect::<Result<Vec<_>>>()?;

    let mut transaction = self.pool.begin().await?;
    if replace_all {
      sqlx::query("DELETE FROM idx_snapshots")
        .execute(&mut *transaction)
        .await?;
    }
    for (name, encoded) in snapshots {
      if let Some(encoded) = encoded {
        sqlx::query("INSERT OR REPLACE INTO idx_snapshots (index_name, data) VALUES (?, ?)")
          .bind(&name)
          .bind(encoded)
          .execute(&mut *transaction)
          .await?;
      } else if !replace_all {
        sqlx::query("DELETE FROM idx_snapshots WHERE index_name = ?")
          .bind(&name)
          .execute(&mut *transaction)
          .await?;
      }
    }
    transaction.commit().await?;

    for name in names {
      if let Some(state) = index.indexes.get_mut(&name) {
        state.dirty.clear();
        state.deleted.clear();
      }
    }
    Ok(())
  }

  pub async fn flush_index(&self) -> Result<()> {
    match self.index_availability() {
      IndexAvailability::Ready => self.persist_indexes(false).await,
      IndexAvailability::Rebuilding => Ok(()),
      IndexAvailability::Failed => Err(Error::IndexTemporarilyUnavailable("failed")),
    }
  }

  pub async fn complete_index_rebuild(&self) -> Result<()> {
    if self.index_availability() != IndexAvailability::Rebuilding {
      return Err(Error::InvalidOperation);
    }
    // `ready` is published only after one transaction has replaced the entire
    // snapshot set. A failed commit keeps native queries fail-closed.
    if let Err(error) = self.persist_indexes(true).await {
      self.set_index_availability(IndexAvailability::Failed);
      return Err(error);
    }
    self.set_index_availability(IndexAvailability::Ready);
    Ok(())
  }

  pub fn fail_index_rebuild(&self) {
    if self.index_availability() == IndexAvailability::Rebuilding {
      self.set_index_availability(IndexAvailability::Failed);
    }
  }

  pub fn index_state(&self) -> &'static str {
    self.index_availability().as_str()
  }

  fn ensure_index_query_ready(&self) -> Result<()> {
    let state = self.index_availability();
    if state == IndexAvailability::Ready {
      Ok(())
    } else {
      Err(Error::IndexTemporarilyUnavailable(state.as_str()))
    }
  }

  pub fn index_version() -> u32 {
    memory_indexer::InMemoryIndex::snapshot_version()
  }

  pub async fn fts_add(&self, index_name: &str, doc_id: &str, text: &str, index: bool) -> Result<()> {
    let mut idx = self.index.write().await;
    idx.add_doc(index_name, doc_id, text, index);
    Ok(())
  }

  pub async fn fts_delete(&self, index_name: &str, doc_id: &str) -> Result<()> {
    let mut idx = self.index.write().await;
    idx.remove_doc(index_name, doc_id);
    Ok(())
  }

  pub async fn fts_get(&self, index_name: &str, doc_id: &str) -> Result<Option<String>> {
    self.ensure_index_query_ready()?;
    let idx = self.index.read().await;
    Ok(idx.get_doc(index_name, doc_id))
  }

  pub async fn fts_search(&self, index_name: &str, query: &str) -> Result<Vec<NativeSearchHit>> {
    self.ensure_index_query_ready()?;
    let idx = self.index.read().await;
    Ok(idx.search_hits(index_name, query).into_iter().map(Into::into).collect())
  }

  pub async fn fts_get_matches(&self, index_name: &str, doc_id: &str, query: &str) -> Result<Vec<NativeMatch>> {
    self.ensure_index_query_ready()?;
    let idx = self.index.read().await;
    Ok(
      idx
        .get_matches(index_name, doc_id, query)
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }

  pub async fn fts_get_matches_for_terms(
    &self,
    index_name: &str,
    doc_id: &str,
    terms: Vec<String>,
  ) -> Result<Vec<NativeMatch>> {
    self.ensure_index_query_ready()?;
    let idx = self.index.read().await;
    Ok(
      idx
        .get_matches_for_terms(index_name, doc_id, &terms)
        .into_iter()
        .map(Into::into)
        .collect(),
    )
  }
}

fn merge_updates(mut segments: Vec<Vec<u8>>, guid: &str) -> Result<Vec<u8>> {
  if segments.is_empty() {
    return Err(ParseError::DocNotFound.into());
  }

  if segments.len() == 1 {
    return segments.pop().ok_or(ParseError::DocNotFound.into());
  }

  let mut opts = Options::default();
  opts.guid = guid.into();
  let doc = Doc::with_options(opts);
  for bin in segments.iter() {
    let update = Update::decode_v1(bin).map_err(|_| ParseError::InvalidBinary)?;
    let mut txn = doc.transact_mut();
    txn.apply_update(update).map_err(|_| ParseError::InvalidBinary)?;
  }

  let txn = doc.transact();
  Ok(txn.encode_state_as_update_v1(&StateVector::default()))
}

#[cfg(test)]
mod tests {
  use std::path::{Path, PathBuf};

  use chrono::Utc;
  use myoxus_doc_indexer::ParseError;
  use serde::Deserialize;
  use tokio::fs;
  use uuid::Uuid;
  use yrs::{Array, ClientID, Map};

  use super::{super::error::Error, *};

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct LegacyYrsFixture {
    producer: String,
    client_id: u64,
    full_update_v1: Vec<u8>,
    state_vector_v1: Vec<u8>,
    incremental_update_v1: Vec<u8>,
    expected: LegacyYrsExpected,
  }

  #[derive(Deserialize)]
  #[serde(rename_all = "camelCase")]
  struct LegacyYrsExpected {
    initial_title: String,
    initial_summary: String,
    final_title: String,
    final_summary: String,
  }

  fn legacy_yrs_0235_fixture() -> LegacyYrsFixture {
    // The checked-in wire bytes were generated once by root yrs 0.23.5 before
    // the protocol cutover. Keeping bytes instead of a second dependency makes
    // this a real backwards-compatibility test rather than a same-runtime test.
    serde_json::from_str(include_str!(
      "../../../doc-indexer/tests/fixtures/yrs-0.23.5-sequential-indexer.json"
    ))
    .expect("legacy yrs fixture must remain valid")
  }

  fn temp_workspace_dir() -> PathBuf {
    std::env::temp_dir().join(format!("myoxus-native-{}", Uuid::new_v4()))
  }

  async fn init_db(path: &Path) -> SqliteDocStorage {
    fs::create_dir_all(path.parent().unwrap()).await.unwrap();
    let storage = SqliteDocStorage::new(path.to_string_lossy().into_owned());
    storage.connect().await.unwrap();
    storage
  }

  async fn cleanup(path: &Path) {
    let _ = fs::remove_dir_all(path.parent().unwrap()).await;
  }

  #[test]
  fn legacy_yrs_0235_updates_materialize_sequentially_for_indexing() {
    let fixture = legacy_yrs_0235_fixture();
    assert_eq!(fixture.producer, "yrs 0.23.5");
    assert_eq!(fixture.client_id, 4_242_424_242);

    let state_vector =
      StateVector::decode_v1(&fixture.state_vector_v1).expect("legacy state vector must decode in the target runtime");
    assert_eq!(state_vector.get(&ClientID::new(fixture.client_id)), 48);

    let incremental = Update::decode_v1(&fixture.incremental_update_v1)
      .expect("legacy incremental update must decode in the target runtime");
    assert!(
      !incremental.delete_set().is_empty(),
      "the compatibility fixture must exercise delete-set application"
    );

    let initial = parse_doc_from_binary(fixture.full_update_v1.clone(), "legacy-yrs".into())
      .expect("legacy full update must remain indexable");
    assert_eq!(initial.title, fixture.expected.initial_title);
    assert_eq!(initial.summary, fixture.expected.initial_summary);

    let merged = merge_updates(
      vec![fixture.full_update_v1, fixture.incremental_update_v1],
      "legacy-yrs",
    )
    .expect("sequential legacy updates must merge");
    let final_state =
      parse_doc_from_binary(merged, "legacy-yrs".into()).expect("merged legacy state must remain indexable");
    assert_eq!(final_state.title, fixture.expected.final_title);
    assert_eq!(final_state.summary, fixture.expected.final_summary);
  }

  fn synthetic_document_update() -> Vec<u8> {
    let doc = Doc::new();
    let blocks = doc.get_or_insert_map("blocks");
    doc.get_or_insert_map("meta");

    {
      let mut txn = doc.transact_mut();
      let page = blocks.insert(&mut txn, "page", yrs::MapPrelim::default());
      page.insert(&mut txn, "id", "page");
      page.insert(&mut txn, "flavour", "myoxus:page");
      page.insert(&mut txn, "title", yrs::TextPrelim::new("Storage Fixture"));
      let page_children = page.insert(&mut txn, "children", yrs::ArrayPrelim::default());
      page_children.push_back(&mut txn, "note");

      let note = blocks.insert(&mut txn, "note", yrs::MapPrelim::default());
      note.insert(&mut txn, "id", "note");
      note.insert(&mut txn, "flavour", "myoxus:note");
      note.insert(&mut txn, "prop:displayMode", "page");
      let note_children = note.insert(&mut txn, "children", yrs::ArrayPrelim::default());
      note_children.push_back(&mut txn, "paragraph");

      let paragraph = blocks.insert(&mut txn, "paragraph", yrs::MapPrelim::default());
      paragraph.insert(&mut txn, "id", "paragraph");
      paragraph.insert(&mut txn, "flavour", "myoxus:paragraph");
      paragraph.insert(&mut txn, "text", yrs::TextPrelim::new("Persisted through SQLite."));
      paragraph.insert(&mut txn, "children", yrs::ArrayPrelim::default());
    }

    doc.transact().encode_state_as_update_v1(&StateVector::default())
  }

  #[test]
  fn current_snapshot_container_roundtrips_and_rejects_invalid_boundaries() {
    let mut index = InMemoryIndex::default();
    index.add_doc("doc:title", "doc-1", "Durable search", true);
    let snapshot = index.get_snapshot_data("doc:title").unwrap();
    let encoded = encode_snapshot(&snapshot).unwrap();

    assert!(encoded.starts_with(INDEX_SNAPSHOT_MAGIC));
    let decoded = decode_snapshot(&encoded).unwrap();
    let mut restored = InMemoryIndex::default();
    restored.load_snapshot("doc:title", decoded);
    assert_eq!(
      restored.get_doc("doc:title", "doc-1").as_deref(),
      Some("Durable search")
    );

    let mut wrong_magic = encoded.clone();
    wrong_magic[0] ^= 0xff;
    assert!(matches!(decode_snapshot(&wrong_magic), Err(Error::Serialization(_))));

    let mut wrong_version = encoded.clone();
    wrong_version[INDEX_SNAPSHOT_MAGIC.len()..INDEX_SNAPSHOT_MAGIC.len() + size_of::<u32>()]
      .copy_from_slice(&InMemoryIndex::snapshot_version().wrapping_add(1).to_le_bytes());
    assert!(matches!(decode_snapshot(&wrong_version), Err(Error::Serialization(_))));
    assert!(matches!(
      decode_snapshot(&encoded[..INDEX_SNAPSHOT_MAGIC.len()]),
      Err(Error::Serialization(_))
    ));
  }

  #[tokio::test]
  async fn corrupt_cache_rebuild_is_fail_closed_and_commits_atomically() {
    let base = temp_workspace_dir();
    fs::create_dir_all(&base).await.unwrap();
    let db_path = base.join("storage.db");
    let corrupt = b"not-a-current-index-snapshot".to_vec();

    let storage = init_db(&db_path).await;
    sqlx::query("INSERT INTO idx_snapshots (index_name, data) VALUES (?, ?)")
      .bind("doc:title")
      .bind(&corrupt)
      .execute(&storage.pool)
      .await
      .unwrap();
    storage
      .set_doc_indexed_clock("demo-doc".to_string(), Utc::now().naive_utc(), 5)
      .await
      .unwrap();
    sqlx::query(r#"INSERT INTO snapshots (doc_id, data, updated_at) VALUES (?, ?, ?)"#)
      .bind("demo-doc")
      .bind(synthetic_document_update())
      .bind(Utc::now().naive_utc())
      .execute(&storage.pool)
      .await
      .unwrap();
    storage.close().await;

    let rebuilding = init_db(&db_path).await;
    assert_eq!(rebuilding.index_availability(), IndexAvailability::Rebuilding);
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM indexer_sync")
        .fetch_one(&rebuilding.pool)
        .await
        .unwrap(),
      0
    );
    let persisted_corrupt: Vec<u8> = sqlx::query_scalar("SELECT data FROM idx_snapshots WHERE index_name = ?")
      .bind("doc:title")
      .fetch_one(&rebuilding.pool)
      .await
      .unwrap();
    assert_eq!(persisted_corrupt, corrupt);
    assert!(matches!(
      rebuilding.fts_search("doc:title", "Durable").await,
      Err(Error::IndexTemporarilyUnavailable("rebuilding"))
    ));

    rebuilding
      .fts_add("doc:title", "demo-doc", "Durable search", true)
      .await
      .unwrap();
    rebuilding.complete_index_rebuild().await.unwrap();
    assert_eq!(rebuilding.index_availability(), IndexAvailability::Ready);
    assert_eq!(rebuilding.fts_search("doc:title", "Durable").await.unwrap().len(), 1);
    let current: Vec<u8> = sqlx::query_scalar("SELECT data FROM idx_snapshots WHERE index_name = ?")
      .bind("doc:title")
      .fetch_one(&rebuilding.pool)
      .await
      .unwrap();
    assert!(current.starts_with(INDEX_SNAPSHOT_MAGIC));
    rebuilding.close().await;

    let restored = init_db(&db_path).await;
    assert_eq!(restored.index_availability(), IndexAvailability::Ready);
    assert_eq!(restored.fts_search("doc:title", "Durable").await.unwrap().len(), 1);
    assert_eq!(
      sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM snapshots WHERE doc_id = 'demo-doc'")
        .fetch_one(&restored.pool)
        .await
        .unwrap(),
      1
    );
    restored.close().await;
    cleanup(&db_path).await;
  }

  #[tokio::test]
  async fn persisted_snapshot_is_crawled_with_semantic_content() {
    let base = temp_workspace_dir();
    fs::create_dir_all(&base).await.unwrap();
    let db_path = base.join("storage.db");

    let storage = init_db(&db_path).await;
    let update = synthetic_document_update();
    sqlx::query(r#"INSERT INTO snapshots (doc_id, data, updated_at) VALUES (?, ?, ?)"#)
      .bind("demo-doc")
      .bind(update)
      .bind(Utc::now().naive_utc())
      .execute(&storage.pool)
      .await
      .unwrap();

    let result = storage.crawl_doc_data("demo-doc").await.unwrap();

    assert_eq!(result.title, "Storage Fixture");
    assert_eq!(result.summary, "Persisted through SQLite.");
    assert_eq!(result.blocks.len(), 2);
    assert!(
      result
        .blocks
        .iter()
        .any(|block| block.block_id == "page" && block.flavour == "myoxus:page")
    );
    assert!(result.blocks.iter().any(|block| {
      block.block_id == "paragraph"
        && block.flavour == "myoxus:paragraph"
        && block.content.as_deref() == Some(&["Persisted through SQLite.".to_string()])
    }));

    storage.close().await;
    cleanup(&db_path).await;
  }

  #[tokio::test]
  async fn missing_doc_returns_error() {
    let base = temp_workspace_dir();
    fs::create_dir_all(&base).await.unwrap();
    let db_path = base.join("storage.db");

    let storage = init_db(&db_path).await;

    let err = storage.crawl_doc_data("absent-doc").await.unwrap_err();
    assert!(matches!(err, Error::Parse(ParseError::DocNotFound)));

    storage.close().await;
    cleanup(&db_path).await;
  }
}
