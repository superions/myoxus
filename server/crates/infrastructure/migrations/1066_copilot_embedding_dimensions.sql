-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Preserve deployed vectors without padding or relabeling them as another model.
DROP INDEX idx_copilot_embeddings_hnsw;
ALTER TABLE copilot_embeddings ALTER COLUMN embedding TYPE vector;

-- Guard casts inside the expression itself: mixed-dimension rows must be safe
-- regardless of SQL predicate evaluation order. Queries use these same forms.
CREATE INDEX idx_copilot_embeddings_hnsw ON copilot_embeddings USING hnsw
  (((CASE WHEN vector_dims(embedding)=1536 THEN embedding END)::vector(1536)) vector_cosine_ops)
  WITH (m=16, ef_construction=64) WHERE vector_dims(embedding)=1536;
CREATE INDEX idx_copilot_embeddings_hnsw_768 ON copilot_embeddings USING hnsw
  (((CASE WHEN vector_dims(embedding)=768 THEN embedding END)::vector(768)) vector_cosine_ops)
  WITH (m=16, ef_construction=64) WHERE vector_dims(embedding)=768;
