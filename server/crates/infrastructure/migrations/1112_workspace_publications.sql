-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Receipts outlive their target workspace and are deleted with their operation.
ALTER TABLE workspace_content_operations ADD UNIQUE (id,kind);
CREATE TABLE workspace_content_publications (
  operation_id uuid PRIMARY KEY,
  kind varchar(32) NOT NULL,
  FOREIGN KEY (operation_id,kind) REFERENCES workspace_content_operations(id,kind) ON DELETE CASCADE,
  target_workspace_id uuid NOT NULL,
  source_workspace_id uuid,
  source_folder_id varchar(512),
  manifest_hash varchar(64),
  preview_revision varchar(128),
  resource_count integer CHECK (resource_count > 0),
  organizer_revision varchar(128) CHECK (organizer_revision <> '' AND organizer_revision !~ '[[:cntrl:]]'),
  organizer_sequence bigint,
  entry_id varchar(512) CHECK (entry_id <> '' AND entry_id !~ '[[:cntrl:]]'),
  diagnostic_instance_id varchar(256) NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((source_workspace_id IS NOT NULL) = (kind IN ('move','extract_folder'))),
  CHECK ((source_folder_id IS NOT NULL) = (kind = 'extract_folder')),
  CHECK (kind <> 'extract_folder' OR source_workspace_id <> target_workspace_id),
  CHECK ((resource_count IS NOT NULL) = (kind <> 'link')),
  CHECK ((manifest_hash IS NOT NULL) = (kind <> 'link')),
  CHECK (kind NOT IN ('move','copy') OR manifest_hash ~ '^[0-9A-Fa-f]{64}$'),
  CHECK (kind <> 'link' OR preview_revision IS NULL),
  CHECK ((organizer_revision IS NOT NULL) = (kind = 'link')),
  CHECK ((entry_id IS NOT NULL) = (kind = 'link')),
  CHECK (kind = 'link' OR organizer_sequence IS NULL),
  CHECK (kind = 'extract_folder' OR (length(diagnostic_instance_id) BETWEEN 1 AND 128 AND diagnostic_instance_id !~ '[[:cntrl:]]'))
);

INSERT INTO workspace_content_publications(kind,operation_id,target_workspace_id,organizer_revision,organizer_sequence,entry_id,diagnostic_instance_id,committed_at)
SELECT 'link',operation_id,target_workspace_id,organizer_revision,organizer_sequence,entry_id,diagnostic_instance_id,committed_at
FROM workspace_content_link_publications;
DROP TABLE workspace_content_link_publications;

INSERT INTO workspace_content_publications(kind,operation_id,target_workspace_id,manifest_hash,preview_revision,resource_count,diagnostic_instance_id,committed_at)
SELECT 'copy',operation_id,target_workspace_id,manifest_hash,preview_revision,object_count,diagnostic_instance_id,committed_at
FROM workspace_content_copy_publications;
DROP TABLE workspace_content_copy_publications;

INSERT INTO workspace_content_publications(kind,operation_id,target_workspace_id,source_workspace_id,manifest_hash,preview_revision,resource_count,diagnostic_instance_id,committed_at)
SELECT 'move',operation_id,target_workspace_id,source_workspace_id,manifest_hash,preview_revision,resource_count,diagnostic_instance_id,committed_at
FROM workspace_content_move_publications;
DROP TABLE workspace_content_move_publications;

INSERT INTO workspace_content_publications(kind,operation_id,target_workspace_id,source_workspace_id,source_folder_id,manifest_hash,preview_revision,resource_count,diagnostic_instance_id,committed_at)
SELECT 'extract_folder',operation_id,target_workspace_id,source_workspace_id,source_folder_id,manifest_hash,preview_revision,resource_count,diagnostic_instance_id,published_at
FROM workspace_content_extract_publications;
DROP TABLE workspace_content_extract_publications;
