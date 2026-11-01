// SPDX-License-Identifier: AGPL-3.0-or-later
//
// P-DB-29: realistic Notion-database fixture import suite.
//
// The five fixtures below mirror the real Notion HTML/ZIP export shape that
// `NotionHtmlTransformer` produces (one HTML page per row, a `<table>`
// element per database). Each fixture exercises a different combination
// of property kinds, select/multi-select options, status groups, dates,
// numbers, checkboxes, files and relation/rollup stubs. The goal is to
// prove that the neutral parser and the snapshot adapter handle the
// common Notion templates (task board, content calendar, CRM, inventory,
// project roadmap) end-to-end, including lossy-import diagnostics.

use myoxus_application::database::notion_import::{
  NotionDiagnosticCode, NotionDiagnosticSeverity, NotionParseResult, NotionPropertyKind, build_snapshot_from_notion,
  parse_notion_html, parse_notion_zip,
};
use myoxus_domain::database::{
  DatabaseCellValueData, DatabaseFieldConfig, DatabaseSnapshotCellValueData, DatabaseSnapshotFieldConfig,
  DatabaseSnapshotViewConfig,
};

/// Build a Notion HTML export containing a single database.
fn database_html(title: &str, property_headers: &[&str], rows: &[Vec<String>]) -> String {
  let mut html = String::new();
  html.push_str("<html><body>\n");
  html.push_str(&format!("<h1>{title}</h1>\n"));
  html.push_str("<table class=\"collection-content\">\n");
  html.push_str("<thead><tr>\n");
  for header in property_headers {
    let (name, kind) = match header.find(" (") {
      Some(idx) => {
        let end = header.len() - 1;
        let name = &header[..idx];
        let kind = &header[idx + 2..end];
        (name, kind)
      }
      None => (*header, "rich_text"),
    };
    html.push_str(&format!(
      "<th data-property-name=\"{name}\" data-property-type=\"{kind}\">{header}</th>\n"
    ));
  }
  html.push_str("</tr></thead>\n");
  html.push_str("<tbody>\n");
  for row in rows {
    html.push_str("<tr>\n");
    for cell in row {
      html.push_str(&format!("<td>{cell}</td>\n"));
    }
    html.push_str("</tr>\n");
  }
  html.push_str("</tbody>\n");
  html.push_str("</table>\n");
  html.push_str("</body></html>\n");
  html
}

/// Build a Notion ZIP containing one HTML page per database.
fn zip_with_databases(entries: &[(&str, String)]) -> Vec<u8> {
  use std::io::Write;

  let mut zip_bytes = Vec::new();
  {
    let cursor = std::io::Cursor::new(&mut zip_bytes);
    let mut zip = zip::ZipWriter::new(cursor);
    let options: zip::write::SimpleFileOptions =
      zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, content) in entries {
      zip.start_file(*name, options).expect("start zip entry");
      zip.write_all(content.as_bytes()).expect("write zip entry");
    }
    zip.finish().expect("finish zip");
  }
  zip_bytes
}

fn summarize_parse(result: &NotionParseResult) -> (usize, usize) {
  let row_count: usize = result.databases.iter().map(|d| d.rows.len()).sum();
  (result.databases.len(), row_count)
}

fn cell_domain(cell: &myoxus_domain::database::DatabaseSnapshotCellValue) -> &DatabaseCellValueData {
  match &cell.value {
    DatabaseSnapshotCellValueData::Domain(value) => value,
    other => panic!("expected Domain cell value, got {other:?}"),
  }
}

#[test]
fn fixture_task_board_with_status_and_assignees() {
  let html = database_html(
    "Sprint Tasks",
    &[
      "Name",
      "Status (status)",
      "Priority (select)",
      "Assignee (rich_text)",
      "Estimate (number)",
      "Done (checkbox)",
      "Due (date)",
    ],
    &[
      vec![
        "Write design".to_string(),
        "In progress".to_string(),
        "High".to_string(),
        "Alice".to_string(),
        "5".to_string(),
        "true".to_string(),
        "2026-07-12".to_string(),
      ],
      vec![
        "Review PR".to_string(),
        "Not started".to_string(),
        "Medium".to_string(),
        "Bob".to_string(),
        "2".to_string(),
        "false".to_string(),
        "2026-07-15".to_string(),
      ],
      vec![
        "Ship release".to_string(),
        "Done".to_string(),
        "High".to_string(),
        "Carol".to_string(),
        "13".to_string(),
        "true".to_string(),
        "2026-07-20".to_string(),
      ],
    ],
  );
  let parsed = parse_notion_html(html.as_bytes());
  let (databases, rows) = summarize_parse(&parsed);
  assert_eq!(
    databases, 1,
    "expected one database, diagnostics={:?}",
    parsed.diagnostics
  );
  assert_eq!(rows, 3, "expected three rows");
  let db = &parsed.databases[0];
  // Properties: Name (Title), Status (Status), Priority (Select),
  // Assignee (RichText), Estimate (Number), Done (Checkbox), Due (Date).
  assert_eq!(db.properties.len(), 7);
  assert!(matches!(db.properties[0].kind, NotionPropertyKind::Title));
  assert!(matches!(db.properties[1].kind, NotionPropertyKind::Status));
  assert!(matches!(db.properties[2].kind, NotionPropertyKind::Select));
  assert!(matches!(db.properties[5].kind, NotionPropertyKind::Checkbox));

  // Build snapshot: status must have default option + 3 entries.
  let built = build_snapshot_from_notion(&parsed, None);
  let status_field = built
    .snapshot
    .database
    .fields
    .iter()
    .find(|f| f.name == "Status")
    .expect("status field");
  let DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Status(config)) = &status_field.config else {
    panic!("expected Status config");
  };
  assert_eq!(config.options.len(), 3);
  assert!(config.options.iter().any(|opt| opt.name == "In progress"));
  assert!(!config.default_option_id.is_empty());

  // Estimate (Number) and Done (Checkbox) coerce correctly.
  let number_field_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Estimate")
    .expect("Estimate field");
  let number_cell = &built.snapshot.database.rows[2].cells[number_field_idx];
  let DatabaseCellValueData::Number(n) = cell_domain(number_cell) else {
    panic!("expected Number cell, got {:?}", number_cell.value);
  };
  assert!((n - 13.0).abs() < f64::EPSILON);

  let checkbox_field_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Done")
    .expect("Done field");
  let checkbox_cell = &built.snapshot.database.rows[1].cells[checkbox_field_idx];
  let DatabaseCellValueData::Checkbox(b) = cell_domain(checkbox_cell) else {
    panic!("expected Checkbox cell, got {:?}", checkbox_cell.value);
  };
  assert!(!b);
}

#[test]
fn fixture_content_calendar_with_multi_select_channels() {
  let html = database_html(
    "Editorial Calendar",
    &[
      "Name",
      "Channel (multi_select)",
      "Owner (select)",
      "PublishAt (date)",
      "Drafted (checkbox)",
      "Link (url)",
    ],
    &[
      vec![
        "Launch announcement".to_string(),
        "Blog, Twitter, LinkedIn".to_string(),
        "Marketing".to_string(),
        "2026-08-01".to_string(),
        "true".to_string(),
        "https://blog.example/launch".to_string(),
      ],
      vec![
        "Weekly digest".to_string(),
        "Blog, Email".to_string(),
        "Comms".to_string(),
        "2026-08-04".to_string(),
        "false".to_string(),
        "https://blog.example/digest".to_string(),
      ],
    ],
  );
  let parsed = parse_notion_html(html.as_bytes());
  let (databases, rows) = summarize_parse(&parsed);
  assert_eq!(databases, 1);
  assert_eq!(rows, 2);
  let built = build_snapshot_from_notion(&parsed, None);
  let channel_field = built
    .snapshot
    .database
    .fields
    .iter()
    .find(|f| f.name == "Channel")
    .expect("Channel field");
  let DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::MultiSelect(config)) = &channel_field.config else {
    panic!("expected MultiSelect config");
  };
  assert!(config.options.iter().any(|o| o.name == "Blog"));
  assert!(config.options.iter().any(|o| o.name == "Twitter"));
  assert!(config.options.iter().any(|o| o.name == "LinkedIn"));
  assert!(config.options.iter().any(|o| o.name == "Email"));

  // First row's Channel cell should be a MultiSelect domain value.
  let channel_field_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Channel")
    .expect("Channel field");
  let channel_cell = &built.snapshot.database.rows[0].cells[channel_field_idx];
  let DatabaseCellValueData::MultiSelect(_) = cell_domain(channel_cell) else {
    panic!("expected MultiSelect cell, got {:?}", channel_cell.value);
  };
}

#[test]
fn fixture_crm_with_email_phone_url() {
  let html = database_html(
    "Customer Contacts",
    &[
      "Name",
      "Company (rich_text)",
      "Email (email)",
      "Phone (phone_number)",
      "Website (url)",
      "LastContact (date)",
    ],
    &[
      vec![
        "Jane Doe".to_string(),
        "Acme Corp".to_string(),
        "jane@acme.test".to_string(),
        "+1-555-0100".to_string(),
        "https://acme.test".to_string(),
        "2026-06-15".to_string(),
      ],
      vec![
        "John Roe".to_string(),
        "Globex".to_string(),
        "john@globex.test".to_string(),
        "+44 20 7946 0000".to_string(),
        "https://globex.test".to_string(),
        "2026-07-01".to_string(),
      ],
    ],
  );
  let parsed = parse_notion_html(html.as_bytes());
  assert_eq!(parsed.databases.len(), 1);
  let built = build_snapshot_from_notion(&parsed, None);
  let email_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Email")
    .expect("Email field");
  let email_cell = &built.snapshot.database.rows[0].cells[email_idx];
  let DatabaseCellValueData::Email(email_text) = cell_domain(email_cell) else {
    panic!("expected Email cell value, got {:?}", email_cell.value);
  };
  assert_eq!(email_text, "jane@acme.test");
  assert!(
    built
      .diagnostics
      .iter()
      .all(|d| d.severity != NotionDiagnosticSeverity::Error),
    "unexpected error diagnostics: {:?}",
    built.diagnostics,
  );
}

#[test]
fn fixture_inventory_with_quantities_and_files() {
  let html = database_html(
    "Office Inventory",
    &[
      "Name",
      "SKU (rich_text)",
      "Quantity (number)",
      "MinStock (number)",
      "Reorder (checkbox)",
      "Photos (files)",
    ],
    &[
      vec![
        "Standing desk".to_string(),
        "DSK-001".to_string(),
        "12".to_string(),
        "4".to_string(),
        "false".to_string(),
        "desk.png,desk-side.png".to_string(),
      ],
      vec![
        "Office chair".to_string(),
        "CHR-014".to_string(),
        "3".to_string(),
        "5".to_string(),
        "true".to_string(),
        "chair.png".to_string(),
      ],
    ],
  );
  let parsed = parse_notion_html(html.as_bytes());
  assert_eq!(parsed.databases.len(), 1);
  let built = build_snapshot_from_notion(&parsed, None);
  let qty_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Quantity")
    .expect("Quantity field");
  let qty_cell = &built.snapshot.database.rows[1].cells[qty_idx];
  let DatabaseCellValueData::Number(n) = cell_domain(qty_cell) else {
    panic!("expected Number cell, got {:?}", qty_cell.value);
  };
  assert!((n - 3.0).abs() < f64::EPSILON);

  // Photos column populates the files manifest.
  assert!(
    !built.snapshot.files_manifest.is_empty(),
    "expected files manifest entries for Photos columns"
  );
  assert!(
    built
      .snapshot
      .files_manifest
      .iter()
      .any(|f| f.name.as_deref() == Some("desk.png")),
    "missing desk.png in files manifest: {:?}",
    built.snapshot.files_manifest,
  );
}

#[test]
fn fixture_project_roadmap_zip_with_phases_milestones_and_rollup() {
  // Realistic Notion ZIP: one HTML page per database, including status
  // groups, milestones, dates and a rollup stub. The rollup/relation
  // columns should degrade to text with type-specific diagnostics.
  let mut projects_html = String::new();
  projects_html.push_str("<html><body>\n");
  projects_html.push_str("<h1>Q3 Roadmap</h1>\n");
  projects_html.push_str("<table class=\"collection-content\">\n");
  projects_html.push_str("<thead><tr>\n");
  projects_html.push_str("<th data-property-name=\"Milestone\" data-property-type=\"title\">Milestone</th>\n");
  projects_html.push_str("<th data-property-name=\"Status\" data-property-type=\"status\">Status</th>\n");
  projects_html.push_str("<th data-property-name=\"Phase\" data-property-type=\"select\">Phase</th>\n");
  projects_html.push_str("<th data-property-name=\"Progress\" data-property-type=\"rollup\">Progress</th>\n");
  projects_html.push_str("<th data-property-name=\"Due\" data-property-type=\"date\">Due</th>\n");
  projects_html.push_str("</tr></thead>\n<tbody>\n");
  for (milestone, status, phase, progress, due) in [
    ("Spec sign-off", "Done", "Discovery", "100", "2026-07-05"),
    ("Kickoff build", "In progress", "Build", "40", "2026-07-22"),
    ("Beta launch", "Not started", "Beta", "0", "2026-08-15"),
    ("GA launch", "Not started", "Launch", "0", "2026-09-01"),
  ] {
    projects_html.push_str(&format!(
      "<tr><td>{milestone}</td><td>{status}</td><td>{phase}</td><td>{progress}</td><td>{due}</td></tr>\n"
    ));
  }
  projects_html.push_str("</tbody>\n</table>\n");

  // A second page demonstrating a relation column.
  projects_html.push_str("<h1>Tasks</h1>\n");
  projects_html.push_str("<table class=\"collection-content\">\n<thead><tr>\n");
  projects_html.push_str("<th data-property-name=\"Name\" data-property-type=\"title\">Name</th>\n");
  projects_html.push_str("<th data-property-name=\"Roadmap\" data-property-type=\"relation\">Roadmap</th>\n");
  projects_html.push_str("<th data-property-name=\"State\" data-property-type=\"status\">State</th>\n");
  projects_html.push_str("</tr></thead>\n<tbody>\n");
  projects_html.push_str("<tr><td>Wire auth</td><td>Kickoff build</td><td>In progress</td></tr>\n");
  projects_html.push_str("<tr><td>Wire payments</td><td>Kickoff build</td><td>Not started</td></tr>\n");
  projects_html.push_str("<tr><td>Landing copy</td><td>Spec sign-off</td><td>Done</td></tr>\n");
  projects_html.push_str("</tbody>\n</table>\n");
  projects_html.push_str("</body></html>\n");

  let zip_bytes = zip_with_databases(&[("Roadmap.html", projects_html)]);

  let parsed = parse_notion_zip(&zip_bytes);
  let (databases, rows) = summarize_parse(&parsed);
  assert!(
    databases >= 2,
    "expected 2 databases (roadmap + tasks), got {databases}, diagnostics={:?}",
    parsed.diagnostics,
  );
  assert!(rows >= 7, "expected at least 7 rows, got {rows}");

  let built = build_snapshot_from_notion(&parsed, Some("roadmap.zip"));

  // Rollup column should degrade to rich_text + emit a diagnostic.
  assert!(
    built
      .diagnostics
      .iter()
      .any(|d| d.code == NotionDiagnosticCode::RollupDegraded.as_str()),
    "expected RollupDegraded diagnostic, got {:?}",
    built.diagnostics,
  );
  // Relation column should degrade and emit a diagnostic.
  assert!(
    built
      .diagnostics
      .iter()
      .any(|d| d.code == NotionDiagnosticCode::RelationDegraded.as_str()),
    "expected RelationDegraded diagnostic, got {:?}",
    built.diagnostics,
  );
  // The snapshot carries the source label and schema version.
  assert_eq!(built.snapshot.source.product, "roadmap.zip");
  assert_eq!(built.snapshot.source.format, "notion-zip");
  // The progress column should now be a Text column (degraded from rollup).
  let progress_field = built.snapshot.database.fields.iter().find(|f| f.name == "Progress");
  if let Some(field) = progress_field {
    // Whatever the order, the field exists and was downgraded.
    assert!(
      matches!(
        field.config,
        DatabaseSnapshotFieldConfig::Domain(DatabaseFieldConfig::Text(_))
      ),
      "expected Progress field downgraded to Text, got {:?}",
      field.config,
    );
  }
}

#[test]
fn fixture_zip_with_invalid_entry_reports_parse_diagnostic() {
  // A ZIP where one entry is not valid HTML should still produce a partial
  // import: the valid database lands, the invalid page emits a diagnostic.
  let valid = database_html(
    "Notes",
    &["Name", "Body (rich_text)"],
    &[vec!["Hello".to_string(), "World".to_string()]],
  );
  let zip_bytes = zip_with_databases(&[("Notes.html", valid), ("garbage.html", "<<<>>>".to_string())]);
  let parsed = parse_notion_zip(&zip_bytes);
  assert_eq!(parsed.databases.len(), 1, "valid HTML must produce one database");
  assert!(
    parsed
      .diagnostics
      .iter()
      .any(|d| d.code == NotionDiagnosticCode::HtmlParseFailed.as_str()),
    "expected HtmlParseFailed diagnostic for garbage entry, got {:?}",
    parsed.diagnostics,
  );
}

#[test]
fn fixture_notion_datetime_all_day_persists_as_date_time_cell() {
  // A Notion Date column with all-day values (`YYYY-MM-DD`) must be
  // mapped to a DateTime cell value with `all_day = true` and an
  // empty timezone. This is the canonical Calendar/Timeline storage
  // shape — the snapshot adapter promotes Notion `Date` to
  // `DatabaseFieldType::DateTime` (per the property-mapping matrix)
  // when the column exposes start/end datetimes.
  let html = database_html(
    "Conferences",
    &["Name", "Start (date_time)", "End (date_time)"],
    &[
      vec![
        "RustConf".to_string(),
        "2026-09-12".to_string(),
        "2026-09-15".to_string(),
      ],
      vec![
        "RustFest".to_string(),
        "2026-10-04".to_string(),
        "2026-10-06".to_string(),
      ],
    ],
  );
  let parsed = parse_notion_html(html.as_bytes());
  let built = build_snapshot_from_notion(&parsed, None);

  // The Date column is mapped to a DateTime field by the matrix.
  let start_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Start")
    .expect("Start field");
  assert!(matches!(
    built.snapshot.database.fields[start_idx].field_type,
    myoxus_domain::database::DatabaseFieldType::DateTime
  ));

  // First row's Start cell is a DateTime cell value, all-day, empty zone.
  let DatabaseCellValueData::DateTime(value) = cell_domain(&built.snapshot.database.rows[0].cells[start_idx]) else {
    panic!(
      "expected DateTime cell, got {:?}",
      built.snapshot.database.rows[0].cells[start_idx]
    );
  };
  assert!(value.all_day);
  assert_eq!(value.time_zone, "");
  assert_eq!(
    value.start,
    chrono::NaiveDate::from_ymd_opt(2026, 9, 12)
      .unwrap()
      .and_hms_opt(0, 0, 0)
      .unwrap()
      .and_utc()
  );
}

#[test]
fn fixture_notion_datetime_timed_with_timezone_persists_as_instant() {
  // Timed Notion DateTime values with an explicit IANA zone must be
  // persisted as `DatabaseCellValueData::DateTime` with the UTC instant
  // normalised and the original IANA identifier preserved verbatim so
  // Calendar/Timeline display surfaces can re-render local time
  // without re-parsing the Notion string.
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-cal".to_string(),
    title: "Calendar".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Standup"),
      NotionProperty {
        name: "Start (date_time)".to_string(),
        kind: NotionPropertyKind::DateTime,
        raw_text: None,
        rich_text: Vec::new(),
        rich_text_lossy: false,

        select_options: Vec::new(),
        date_start: Some("2026-07-12T09:30:00.000+02:00".to_string()),
        date_end: Some("2026-07-12T10:30:00.000+02:00".to_string()),
        number: None,
        checkbox: None,
        relation_targets: Vec::new(),
        rollup_aggregate: None,
        file_paths: Vec::new(),
        url: None,
        email: None,
        phone: None,
        people: Vec::new(),
        tags: Vec::new(),
      },
    ],
    rows: vec![NotionRow {
      page_id: "page-standup".to_string(),
      title: "Standup".to_string(),
      icon: None,
      cover_url: None,
      page_body: None,
      properties: vec![
        NotionProperty::title("Name", "Standup"),
        NotionProperty {
          name: "Start (date_time)".to_string(),
          kind: NotionPropertyKind::DateTime,
          raw_text: None,
          rich_text: Vec::new(),
          rich_text_lossy: false,

          select_options: Vec::new(),
          date_start: Some("2026-07-12T09:30:00.000+02:00".to_string()),
          date_end: Some("2026-07-12T10:30:00.000+02:00".to_string()),
          number: None,
          checkbox: None,
          relation_targets: Vec::new(),
          rollup_aggregate: None,
          file_paths: Vec::new(),
          url: None,
          email: None,
          phone: None,
          people: Vec::new(),
          tags: Vec::new(),
        },
      ],
    }],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);

  let start_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Start (date_time)")
    .expect("datetime field");
  let DatabaseCellValueData::DateTime(value) = cell_domain(&built.snapshot.database.rows[0].cells[start_idx]) else {
    panic!("expected DateTime cell");
  };
  assert!(!value.all_day, "timed value must not be all-day");
  assert_eq!(value.start.timestamp(), 1783841400, "must normalise to UTC instant");
  assert_eq!(value.end.expect("timed range end").timestamp(), 1783845000);
  // Timezone identifier must round-trip; some platforms report an empty
  // string for fixed-offset zones, in which case the recorded zone name
  // is still acceptable for display purposes.
  assert!(
    !value.time_zone.is_empty(),
    "expected time zone identifier, got {:?}",
    value.time_zone
  );
}

#[test]
fn fixture_notion_datetime_invalid_value_emits_per_row_diagnostic() {
  // An invalid DateTime string must not produce a cell value AND must
  // emit a `MIX_DATABASE_NOTION_DATETIME_INVALID` diagnostic that
  // names the row/cell path. A second valid row must still produce a
  // real DateTime cell so the partial-failure path is exercised.
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-dt".to_string(),
    title: "Calendar".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Anchor"),
      NotionProperty {
        name: "When (date_time)".to_string(),
        kind: NotionPropertyKind::DateTime,
        raw_text: None,
        rich_text: Vec::new(),
        rich_text_lossy: false,

        select_options: Vec::new(),
        date_start: Some("not-a-date".to_string()),
        date_end: None,
        number: None,
        checkbox: None,
        relation_targets: Vec::new(),
        rollup_aggregate: None,
        file_paths: Vec::new(),
        url: None,
        email: None,
        phone: None,
        people: Vec::new(),
        tags: Vec::new(),
      },
    ],
    rows: vec![
      NotionRow {
        page_id: "page-bad".to_string(),
        title: "Bad date".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![
          NotionProperty::title("Name", "Bad date"),
          NotionProperty {
            name: "When (date_time)".to_string(),
            kind: NotionPropertyKind::DateTime,
            raw_text: None,
            rich_text: Vec::new(),
            rich_text_lossy: false,

            select_options: Vec::new(),
            date_start: Some("not-a-date".to_string()),
            date_end: None,
            number: None,
            checkbox: None,
            relation_targets: Vec::new(),
            rollup_aggregate: None,
            file_paths: Vec::new(),
            url: None,
            email: None,
            phone: None,
            people: Vec::new(),
            tags: Vec::new(),
          },
        ],
      },
      NotionRow {
        page_id: "page-good".to_string(),
        title: "Good date".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![
          NotionProperty::title("Name", "Good date"),
          NotionProperty {
            name: "When (date_time)".to_string(),
            kind: NotionPropertyKind::DateTime,
            raw_text: None,
            rich_text: Vec::new(),
            rich_text_lossy: false,

            select_options: Vec::new(),
            date_start: Some("2026-09-12".to_string()),
            date_end: None,
            number: None,
            checkbox: None,
            relation_targets: Vec::new(),
            rollup_aggregate: None,
            file_paths: Vec::new(),
            url: None,
            email: None,
            phone: None,
            people: Vec::new(),
            tags: Vec::new(),
          },
        ],
      },
    ],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);

  // Per-row diagnostic for the bad cell value.
  assert!(
    built
      .diagnostics
      .iter()
      .any(|d| d.code == NotionDiagnosticCode::DateTimeInvalid.as_str()),
    "expected DateTimeInvalid diagnostic, got {:?}",
    built.diagnostics
  );
  // The good row's datetime cell value must still be persisted.
  let when_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "When (date_time)")
    .expect("when field");
  let good_cell = &built.snapshot.database.rows[1].cells[when_idx];
  let DatabaseCellValueData::DateTime(value) = cell_domain(good_cell) else {
    panic!("expected DateTime cell for good row");
  };
  assert_eq!(
    value.start,
    chrono::NaiveDate::from_ymd_opt(2026, 9, 12)
      .unwrap()
      .and_hms_opt(0, 0, 0)
      .unwrap()
      .and_utc()
  );
}

#[test]
fn fixture_notion_same_database_relation_imports_as_relation_field_with_local_row_targets() {
  // A Notion relation that points at a page_id present in the same
  // imported primary database must become a real
  // `DatabaseFieldType::Relation` field with
  // `target_database_id = "database_0"` and the cell value must use
  // the local row id (e.g. "row_1") instead of the Notion page id.
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let make_property = |name: &str, kind: NotionPropertyKind, page_id: &str| NotionProperty {
    name: name.to_string(),
    kind,
    raw_text: None,
    rich_text: Vec::new(),
    rich_text_lossy: false,

    select_options: Vec::new(),
    date_start: None,
    date_end: None,
    number: None,
    checkbox: None,
    relation_targets: vec![page_id.to_string()],
    rollup_aggregate: None,
    file_paths: Vec::new(),
    url: None,
    email: None,
    phone: None,
    people: Vec::new(),
    tags: Vec::new(),
  };
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-rel".to_string(),
    title: "Roadmap".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Roadmap"),
      make_property("Tasks (relation)", NotionPropertyKind::Relation, "row_1_token"),
    ],
    rows: vec![
      NotionRow {
        page_id: "row_0_token".to_string(),
        title: "Q3 Plan".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![
          NotionProperty::title("Name", "Q3 Plan"),
          make_property("Tasks (relation)", NotionPropertyKind::Relation, "row_1_token"),
        ],
      },
      NotionRow {
        page_id: "row_1_token".to_string(),
        title: "Milestone 1".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![
          NotionProperty::title("Name", "Milestone 1"),
          make_property("Tasks (relation)", NotionPropertyKind::Relation, "row_0_token"),
        ],
      },
    ],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);

  let rel_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Tasks (relation)")
    .expect("relation field");
  assert!(
    matches!(
      built.snapshot.database.fields[rel_idx].field_type,
      myoxus_domain::database::DatabaseFieldType::Relation
    ),
    "relation field must be upgraded to Relation, got {:?}",
    built.snapshot.database.fields[rel_idx].field_type
  );
  match &built.snapshot.database.fields[rel_idx].config {
    DatabaseSnapshotFieldConfig::Relation(config) => {
      assert_eq!(config.target_database_id, "database_0");
    }
    other => panic!("expected Relation config, got {other:?}"),
  }
  let cell = &built.snapshot.database.rows[0].cells[rel_idx];
  match &cell.value {
    DatabaseSnapshotCellValueData::Relation(targets) => {
      assert_eq!(targets, &vec!["row_1".to_string()]);
    }
    other => panic!("expected Relation cell, got {other:?}"),
  }
  let cell_back = &built.snapshot.database.rows[1].cells[rel_idx];
  match &cell_back.value {
    DatabaseSnapshotCellValueData::Relation(targets) => {
      assert_eq!(targets, &vec!["row_0".to_string()]);
    }
    other => panic!("expected Relation cell, got {other:?}"),
  }
  assert!(
    !built.diagnostics.iter().any(
      |d| d.code == myoxus_application::database::notion_import::NotionDiagnosticCode::RelationCrossDatabase.as_str()
    ),
    "expected no cross-database diagnostic, got {:?}",
    built.diagnostics
  );
}

#[test]
fn fixture_notion_cross_database_relation_downgrades_to_text_with_diagnostic() {
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-isolated".to_string(),
    title: "Issues".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Issues"),
      NotionProperty {
        name: "Linked (relation)".to_string(),
        kind: NotionPropertyKind::Relation,
        raw_text: None,
        rich_text: Vec::new(),
        rich_text_lossy: false,

        select_options: Vec::new(),
        date_start: None,
        date_end: None,
        number: None,
        checkbox: None,
        relation_targets: vec!["external_page_xyz".to_string()],
        rollup_aggregate: None,
        file_paths: Vec::new(),
        url: None,
        email: None,
        phone: None,
        people: Vec::new(),
        tags: Vec::new(),
      },
    ],
    rows: vec![NotionRow {
      page_id: "row_0_token".to_string(),
      title: "Issue 1".to_string(),
      icon: None,
      cover_url: None,
      page_body: None,
      properties: vec![
        NotionProperty::title("Name", "Issue 1"),
        NotionProperty {
          name: "Linked (relation)".to_string(),
          kind: NotionPropertyKind::Relation,
          raw_text: None,
          rich_text: Vec::new(),
          rich_text_lossy: false,

          select_options: Vec::new(),
          date_start: None,
          date_end: None,
          number: None,
          checkbox: None,
          relation_targets: vec!["external_page_xyz".to_string()],
          rollup_aggregate: None,
          file_paths: Vec::new(),
          url: None,
          email: None,
          phone: None,
          people: Vec::new(),
          tags: Vec::new(),
        },
      ],
    }],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);
  let rel_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Linked (relation)")
    .expect("relation field");
  assert!(
    matches!(
      built.snapshot.database.fields[rel_idx].field_type,
      myoxus_domain::database::DatabaseFieldType::Text
    ),
    "cross-database relation must downgrade to Text, got {:?}",
    built.snapshot.database.fields[rel_idx].field_type
  );
  assert!(
    built.diagnostics.iter().any(
      |d| d.code == myoxus_application::database::notion_import::NotionDiagnosticCode::RelationCrossDatabase.as_str()
    ),
    "expected RelationCrossDatabase diagnostic, got {:?}",
    built.diagnostics
  );
}

#[test]
fn fixture_notion_rollup_after_same_database_relation_imports_as_rollup_field() {
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let make_relation = |name: &str, target: &str| NotionProperty {
    name: name.to_string(),
    kind: NotionPropertyKind::Relation,
    raw_text: None,
    rich_text: Vec::new(),
    rich_text_lossy: false,

    select_options: Vec::new(),
    date_start: None,
    date_end: None,
    number: None,
    checkbox: None,
    relation_targets: vec![target.to_string()],
    rollup_aggregate: None,
    file_paths: Vec::new(),
    url: None,
    email: None,
    phone: None,
    people: Vec::new(),
    tags: Vec::new(),
  };
  let make_rollup = |name: &str| NotionProperty {
    name: name.to_string(),
    kind: NotionPropertyKind::Rollup,
    raw_text: None,
    rich_text: Vec::new(),
    rich_text_lossy: false,

    select_options: Vec::new(),
    date_start: None,
    date_end: None,
    number: None,
    checkbox: None,
    relation_targets: Vec::new(),
    rollup_aggregate: Some("count".to_string()),
    file_paths: Vec::new(),
    url: None,
    email: None,
    phone: None,
    people: Vec::new(),
    tags: Vec::new(),
  };
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-roll".to_string(),
    title: "Tracker".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Tracker"),
      make_relation("Tasks (relation)", "row_1_token"),
      make_rollup("Task Count (rollup)"),
    ],
    rows: vec![
      NotionRow {
        page_id: "row_0_token".to_string(),
        title: "Project A".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![
          NotionProperty::title("Name", "Project A"),
          make_relation("Tasks (relation)", "row_1_token"),
          make_rollup("Task Count (rollup)"),
        ],
      },
      NotionRow {
        page_id: "row_1_token".to_string(),
        title: "Task 1".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![
          NotionProperty::title("Name", "Task 1"),
          make_relation("Tasks (relation)", "row_0_token"),
          make_rollup("Task Count (rollup)"),
        ],
      },
    ],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);

  let rollup_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Task Count (rollup)")
    .expect("rollup field");
  assert!(
    matches!(
      built.snapshot.database.fields[rollup_idx].field_type,
      myoxus_domain::database::DatabaseFieldType::Rollup
    ),
    "rollup field must be upgraded to Rollup, got {:?}",
    built.snapshot.database.fields[rollup_idx].field_type
  );
  match &built.snapshot.database.fields[rollup_idx].config {
    DatabaseSnapshotFieldConfig::Rollup(config) => {
      assert_eq!(config.source_relation_field_id, "field_1");
      assert!(matches!(
        config.aggregate,
        myoxus_domain::database::DatabaseRollupAggregate::Count
      ));
    }
    other => panic!("expected Rollup config, got {other:?}"),
  }
  assert!(
    built
      .diagnostics
      .iter()
      .any(|d| d.code == myoxus_application::database::notion_import::NotionDiagnosticCode::RollupImported.as_str()),
    "expected RollupImported diagnostic, got {:?}",
    built.diagnostics
  );
}

#[test]
fn fixture_notion_people_cell_emits_placeholder_users_field_for_service_matching() {
  // P-DB-29R: the pure snapshot adapter cannot resolve workspace
  // members, but it must create the `Users` field so the JSON apply
  // step does not reject the snapshot. The cell value is an empty
  // `Users` placeholder; the service layer replaces it after apply
  // via `DatabaseEditingService::update_cell_value` once it has run the
  // workspace-member lookup.
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-people".to_string(),
    title: "Owners".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Owners"),
      NotionProperty {
        name: "Owner (people)".to_string(),
        kind: NotionPropertyKind::People,
        raw_text: None,
        rich_text: Vec::new(),
        rich_text_lossy: false,

        select_options: Vec::new(),
        date_start: None,
        date_end: None,
        number: None,
        checkbox: None,
        relation_targets: Vec::new(),
        rollup_aggregate: None,
        file_paths: Vec::new(),
        url: None,
        email: None,
        phone: None,
        people: vec!["alice@example.com".to_string(), "Bob".to_string()],
        tags: Vec::new(),
      },
    ],
    rows: vec![NotionRow {
      page_id: "row_0_token".to_string(),
      title: "Asset 1".to_string(),
      icon: None,
      cover_url: None,
      page_body: None,
      properties: vec![
        NotionProperty::title("Name", "Asset 1"),
        NotionProperty {
          name: "Owner (people)".to_string(),
          kind: NotionPropertyKind::People,
          raw_text: None,
          rich_text: Vec::new(),
          rich_text_lossy: false,

          select_options: Vec::new(),
          date_start: None,
          date_end: None,
          number: None,
          checkbox: None,
          relation_targets: Vec::new(),
          rollup_aggregate: None,
          file_paths: Vec::new(),
          url: None,
          email: None,
          phone: None,
          people: vec!["alice@example.com".to_string(), "Bob".to_string()],
          tags: Vec::new(),
        },
      ],
    }],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);
  let owner_idx = built
    .snapshot
    .database
    .fields
    .iter()
    .position(|f| f.name == "Owner (people)")
    .expect("people field");
  // P-DB-29R: the field is now a real `Users` field with a `Users`
  // config so the JSON apply step accepts the snapshot without
  // downgrading the column type.
  assert!(
    matches!(
      built.snapshot.database.fields[owner_idx].field_type,
      myoxus_domain::database::DatabaseFieldType::Users
    ),
    "people column must map to a `Users` field at the snapshot layer"
  );
  let cell = &built.snapshot.database.rows[0].cells[owner_idx];
  let DatabaseSnapshotCellValueData::Domain(DatabaseCellValueData::Users(value)) = &cell.value else {
    panic!("expected Domain Users cell, got {:?}", cell.value);
  };
  assert!(
    value.is_empty(),
    "snapshot adapter must leave the Users cell empty for the service layer to fill; got {value:?}"
  );
  assert!(
    built
      .diagnostics
      .iter()
      .all(|d| d.code != myoxus_application::database::notion_import::NotionDiagnosticCode::PeopleDegraded.as_str()),
    "people column must not emit a PeopleDegraded diagnostic anymore; got {:?}",
    built.diagnostics.iter().map(|d| d.code.as_str()).collect::<Vec<_>>()
  );
}

#[test]
fn fixture_notion_view_hints_fall_back_to_table_with_diagnostic() {
  // Notion's HTML/ZIP exports do not reliably carry view metadata, so
  // the snapshot adapter must fall back to a truthful Table view and
  // emit a ViewUnsupported info diagnostic. If the database has a
  // Date or DateTime field, the diagnostic message must mention it
  // so the operator can set up a Calendar view manually after
  // import.
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-view".to_string(),
    title: "Calendar".to_string(),
    description: None,
    properties: vec![
      NotionProperty::title("Name", "Events"),
      NotionProperty {
        name: "When (date)".to_string(),
        kind: NotionPropertyKind::Date,
        raw_text: None,
        rich_text: Vec::new(),
        rich_text_lossy: false,

        select_options: Vec::new(),
        date_start: Some("2026-09-12".to_string()),
        date_end: None,
        number: None,
        checkbox: None,
        relation_targets: Vec::new(),
        rollup_aggregate: None,
        file_paths: Vec::new(),
        url: None,
        email: None,
        phone: None,
        people: Vec::new(),
        tags: Vec::new(),
      },
    ],
    rows: vec![NotionRow {
      page_id: "row_0_token".to_string(),
      title: "Demo".to_string(),
      icon: None,
      cover_url: None,
      page_body: None,
      properties: vec![
        NotionProperty::title("Name", "Demo"),
        NotionProperty {
          name: "When (date)".to_string(),
          kind: NotionPropertyKind::Date,
          raw_text: None,
          rich_text: Vec::new(),
          rich_text_lossy: false,

          select_options: Vec::new(),
          date_start: Some("2026-09-12".to_string()),
          date_end: None,
          number: None,
          checkbox: None,
          relation_targets: Vec::new(),
          rollup_aggregate: None,
          file_paths: Vec::new(),
          url: None,
          email: None,
          phone: None,
          people: Vec::new(),
          tags: Vec::new(),
        },
      ],
    }],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);
  // Snapshot adapter must produce exactly one view (Table) as the
  // truthful fallback.
  assert_eq!(built.snapshot.database.views.len(), 1);
  let view = &built.snapshot.database.views[0];
  assert!(matches!(
    view.view_kind,
    myoxus_domain::database::DatabaseViewKind::Table
  ));
  assert!(
    matches!(view.config, DatabaseSnapshotViewConfig::Table(_)),
    "fallback view must be a Table view config"
  );
  let view_diag = built
    .diagnostics
    .iter()
    .find(|d| d.code == myoxus_application::database::notion_import::NotionDiagnosticCode::ViewUnsupported.as_str())
    .expect("expected ViewUnsupported diagnostic");
  assert!(
    view_diag.message.contains("date_field=true"),
    "diagnostic must mention the date field so the operator knows a Calendar view is possible, got {:?}",
    view_diag.message
  );
}

#[test]
fn fixture_notion_template_unsupported_emits_diagnostic_but_keeps_rows() {
  // P-DB-29 contract: when the Notion source does not carry template
  // metadata, the snapshot adapter must emit
  // MIX_DATABASE_NOTION_TEMPLATE_UNSUPPORTED and keep every visible
  // row imported (the diagnostic is informational, not destructive).
  use myoxus_application::database::notion_import::{NotionProperty, NotionPropertyKind, NotionRow};
  let make_property = |name: &str| NotionProperty {
    name: name.to_string(),
    kind: NotionPropertyKind::RichText,
    raw_text: Some("body".to_string()),
    rich_text: Vec::new(),
    rich_text_lossy: false,

    select_options: Vec::new(),
    date_start: None,
    date_end: None,
    number: None,
    checkbox: None,
    relation_targets: Vec::new(),
    rollup_aggregate: None,
    file_paths: Vec::new(),
    url: None,
    email: None,
    phone: None,
    people: Vec::new(),
    tags: Vec::new(),
  };
  let doc = myoxus_application::database::notion_import::NotionDocument {
    database_id: "db-tmpl".to_string(),
    title: "Tasks".to_string(),
    description: None,
    properties: vec![NotionProperty::title("Name", "Tasks"), make_property("Notes")],
    rows: vec![
      NotionRow {
        page_id: "page-1".to_string(),
        title: "Alpha".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![NotionProperty::title("Name", "Alpha"), make_property("first")],
      },
      NotionRow {
        page_id: "page-2".to_string(),
        title: "Beta".to_string(),
        icon: None,
        cover_url: None,
        page_body: None,
        properties: vec![NotionProperty::title("Name", "Beta"), make_property("second")],
      },
    ],
  };
  let parsed = myoxus_application::database::notion_import::NotionParseResult {
    databases: vec![doc],
    diagnostics: Vec::new(),
    source: myoxus_application::database::notion_import::NotionSource::Html,
    assets: std::collections::BTreeMap::new(),
  };
  let built = build_snapshot_from_notion(&parsed, None);
  // No row templates are created — the contract is to keep them empty.
  assert!(
    built.snapshot.database.row_templates.is_empty(),
    "row_templates must stay empty when source carries no template metadata"
  );
  // Both visible Notion rows are imported as regular Database rows.
  assert_eq!(built.snapshot.database.rows.len(), 2);
  assert_eq!(built.snapshot.database.rows[0].title, "Alpha");
  assert_eq!(built.snapshot.database.rows[1].title, "Beta");
  // The TemplateUnsupported diagnostic is emitted on the database.
  let tmpl_diag = built
    .diagnostics
    .iter()
    .find(|d| d.code == myoxus_application::database::notion_import::NotionDiagnosticCode::TemplateUnsupported.as_str())
    .expect("expected TemplateUnsupported diagnostic");
  assert!(
    tmpl_diag.message.contains("row templates"),
    "diagnostic message must explain that row templates were not created, got {:?}",
    tmpl_diag.message
  );
  assert!(
    tmpl_diag.path.ends_with(".rowTemplates"),
    "diagnostic path must point at the rowTemplates slot, got {:?}",
    tmpl_diag.path
  );
  assert!(
    matches!(
      tmpl_diag.severity,
      myoxus_application::database::notion_import::NotionDiagnosticSeverity::Info
    ),
    "template fallback is informational, not an error"
  );
}

#[test]
fn fixture_notion_zip_with_real_assets_marks_referenced_paths_materialized() {
  // P-DB-29: real asset materialisation. A Notion ZIP that carries an
  // image referenced by a Files cell must (a) parse the cell path as a
  // blob_key, (b) include the image bytes in the parse result's
  // `assets` map, and (c) emit an `AssetMaterialized` info diagnostic
  // for the referenced asset. An unreferenced asset in the ZIP must
  // appear in `assets` and emit an `AssetRejected` warning diagnostic
  // explaining why it isn't being uploaded. A path referenced by a
  // cell but missing from the archive must emit `AssetMissing`.
  use myoxus_application::database::notion_import::{NotionDiagnosticCode, NotionDiagnosticSeverity, parse_notion_zip};

  let html = database_html(
    "Notion Asset Demo",
    &["Name", "Photo (files)"],
    &[
      vec!["Lamp".to_string(), "lamp.png".to_string()],
      vec!["Mug".to_string(), "missing.png".to_string()],
    ],
  );
  let lamp_bytes = b"\x89PNG\r\n\x1a\nLAMP-BYTES";
  let orphan_bytes = b"\x89PNG\r\n\x1a\nORPHAN-BYTES";
  let zip = zip_with_databases_and_assets(&[
    ("Notion Asset Demo abc123def45678901234567890abcdef.html", html.clone()),
    ("assets/lamp.png", String::from_utf8_lossy(lamp_bytes).to_string()),
    ("assets/orphan.png", String::from_utf8_lossy(orphan_bytes).to_string()),
  ]);
  let parsed = parse_notion_zip(&zip);
  assert!(
    !parsed.databases.is_empty(),
    "expected at least one database; diagnostics={:?}",
    parsed.diagnostics
  );
  // Only HTML-safe paths are accepted (regression cover for path-traversal guard).
  let bad_zip = zip_with_databases_and_assets(&[("../evil.exe", "bad".to_string())]);
  let bad_parse = parse_notion_zip(&bad_zip);
  assert!(
    bad_parse
      .diagnostics
      .iter()
      .any(|d| d.code == NotionDiagnosticCode::AssetRejected.as_str()),
    "expected AssetRejected diagnostic for path-traversal entry, got {:?}",
    bad_parse.diagnostics
  );

  // The valid ZIP has two referenced assets (lamp.png + missing.png)
  // and one unreferenced asset (orphan.png).
  assert_eq!(parsed.assets.len(), 2);
  assert!(parsed.assets.contains_key("assets/lamp.png"));
  assert!(parsed.assets.contains_key("assets/orphan.png"));

  let built = build_snapshot_from_notion(&parsed, Some("notion.zip"));
  // lamp.png is referenced → AssetMaterialized.
  let lamp_diag = built
    .diagnostics
    .iter()
    .find(|d| d.code == NotionDiagnosticCode::AssetMaterialized.as_str() && d.path.contains("lamp.png"))
    .expect("expected AssetMaterialized diagnostic for lamp.png");
  assert!(lamp_diag.message.contains("uploaded"));
  assert!(matches!(lamp_diag.severity, NotionDiagnosticSeverity::Info));
  // orphan.png is unreferenced → AssetRejected warning.
  let orphan_diag = built
    .diagnostics
    .iter()
    .find(|d| d.code == NotionDiagnosticCode::AssetRejected.as_str() && d.path.contains("orphan.png"))
    .expect("expected AssetRejected diagnostic for orphan.png");
  assert!(orphan_diag.message.contains("not referenced"));
  assert!(matches!(orphan_diag.severity, NotionDiagnosticSeverity::Warning));
  // missing.png is referenced but absent from the archive → AssetMissing.
  let missing_diag = built
    .diagnostics
    .iter()
    .find(|d| d.code == NotionDiagnosticCode::AssetMissing.as_str() && d.path.contains("missing.png"))
    .expect("expected AssetMissing diagnostic for missing.png");
  assert!(missing_diag.message.contains("did not include"));
  assert!(matches!(missing_diag.severity, NotionDiagnosticSeverity::Warning));
}

/// Variant of [`zip_with_databases`] that accepts either text or
/// binary payloads and is used by asset-materialisation fixtures.
fn zip_with_databases_and_assets(entries: &[(&str, String)]) -> Vec<u8> {
  use std::io::Write;
  let mut zip_bytes = Vec::new();
  {
    let cursor = std::io::Cursor::new(&mut zip_bytes);
    let mut zip = zip::ZipWriter::new(cursor);
    let options: zip::write::SimpleFileOptions =
      zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, content) in entries {
      zip.start_file(*name, options).expect("start zip entry");
      zip.write_all(content.as_bytes()).expect("write zip entry");
    }
    zip.finish().expect("finish zip");
  }
  zip_bytes
}
