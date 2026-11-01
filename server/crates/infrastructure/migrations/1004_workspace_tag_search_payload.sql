-- SPDX-License-Identifier: AGPL-3.0-or-later

-- Workspace Tags are indexed through the structured `workspace_tags`
-- projection. An earlier application writer also appended the same Tag tokens
-- to `search_text`; lifecycle-only projection refreshes could consequently
-- leave renamed or permanently deleted Tags searchable. Rebuild that
-- non-Tag payload from the authoritative typed cell values once. Keep this
-- one-time projection aligned with `DatabaseProjectionService` rather than
-- serializing JSON keys or renderer-only fields into user search.
WITH cell_search_values AS (
  SELECT value.row_id,
         field.position,
         CASE field.field_type
           WHEN 'text' THEN value.value_json #>> '{}'
           WHEN 'rich_text' THEN value.value_json->>'plainText'
           WHEN 'number' THEN value.value_json #>> '{}'
           WHEN 'percent' THEN value.value_json #>> '{}'
           WHEN 'currency' THEN concat_ws(
             ' ',
             value.value_json->>'amount',
             value.value_json->>'currencyCode'
           )
           WHEN 'duration' THEN value.value_json->>'minutes'
           WHEN 'checkbox' THEN value.value_json #>> '{}'
           WHEN 'date' THEN value.value_json->>'start'
           WHEN 'date_time' THEN value.value_json->>'start'
           WHEN 'unique_id' THEN value.value_json->>'display'
           WHEN 'select' THEN value.value_json #>> '{}'
           WHEN 'multi_select' THEN (
             SELECT string_agg(item, ' ' ORDER BY position)
               FROM jsonb_array_elements_text(value.value_json)
                    WITH ORDINALITY AS selected(item, position)
           )
           WHEN 'status' THEN value.value_json #>> '{}'
           WHEN 'user' THEN value.value_json #>> '{}'
           WHEN 'users' THEN (
             SELECT string_agg(item, ' ' ORDER BY position)
               FROM jsonb_array_elements_text(value.value_json)
                    WITH ORDINALITY AS selected(item, position)
           )
           WHEN 'document_link' THEN value.value_json->>'docId'
           WHEN 'url' THEN value.value_json #>> '{}'
           WHEN 'email' THEN value.value_json #>> '{}'
           WHEN 'phone' THEN value.value_json #>> '{}'
           WHEN 'created_by' THEN value.value_json #>> '{}'
           WHEN 'updated_by' THEN value.value_json #>> '{}'
           ELSE NULL
         END AS search_value
    FROM workspace_database_cell_values value
    JOIN workspace_database_fields field ON field.id = value.field_id
)
UPDATE workspace_database_row_search search
   SET search_text = COALESCE(
         (
           SELECT string_agg(projected.search_value, ' ' ORDER BY projected.position)
             FROM cell_search_values projected
            WHERE projected.row_id = search.row_id
              AND projected.search_value <> ''
         ),
         ''
       ),
       updated_at = now();
