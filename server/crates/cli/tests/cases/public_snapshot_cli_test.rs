// SPDX-License-Identifier: AGPL-3.0-or-later
//! Binary-level contract for self-contained public HTML snapshots.

use crate::support;

use std::{collections::BTreeMap, fs, sync::Arc};

use myoxus_application::{
  doc::DocService,
  organizer::{CreateOrganizerFolder, CreateOrganizerLink, OrganizerLinkType, OrganizerService},
  workspace::WorkspaceService,
};
use myoxus_domain::{
  workspace_content_operation::{WorkspaceContentResourceKind, WorkspaceContentResourceRef},
  workspace_overview::{
    FolderOverviewSettings, OverviewOrderBy, OverviewRegisterPresentation, WorkspaceOverviewSettings,
  },
};
use myoxus_infrastructure::{doc::SqlxDocStore, workspace::SqlxWorkspaceStore};
use sha2::{Digest, Sha256};

use sqlx::postgres::PgPoolOptions;
use support::database_url;
use uuid::Uuid;

#[tokio::test]
async fn public_snapshot_uses_authoritative_visibility_external_keys_and_relative_navigation() {
  let pool = PgPoolOptions::new()
    .max_connections(2)
    .connect(&database_url())
    .await
    .expect("connect isolated test database");
  myoxus_infrastructure::migrations::run(&pool).await.expect("migrate");
  myoxus_infrastructure::branding::seed_system_theme_branding(&pool)
    .await
    .expect("seed the global theme required by public snapshot export");

  let user_id = Uuid::new_v4();
  let public_workspace = Uuid::new_v4();
  let empty_workspace = Uuid::new_v4();
  let private_workspace = Uuid::new_v4();
  let external_workspace = Uuid::new_v4();
  let fixture_pool = pool.clone();
  // A CLI owns its own DB connection. Always clean committed fixtures, including
  // assertion failures, rather than relying on the parent test transaction.
  let outcome = tokio::spawn(async move {
    let pool = fixture_pool;
    let email = format!("public-snapshot-{user_id}@test.local");
    sqlx::query("INSERT INTO users (id, email, name, email_verified_at) VALUES ($1, $2, 'Snapshot owner', now())")
      .bind(user_id)
      .bind(&email)
      .execute(&pool)
      .await
      .expect("insert snapshot owner");

    for (workspace_id, name, description, public) in [
      (public_workspace, "Snapshot workspace", "First line\nSecond line", true),
      (empty_workspace, "Empty public workspace", "", true),
      (external_workspace, "External published workspace", "", true),
      (
        private_workspace,
        "Private selected workspace",
        "Must stay absent",
        false,
      ),
    ] {
      sqlx::query(
        "INSERT INTO workspaces (id, owner_user_id, name, description, public, enable_sharing)
       VALUES ($1, $2, $3, $4, $5, true)",
      )
      .bind(workspace_id)
      .bind(user_id)
      .bind(name)
      .bind(description)
      .bind(public)
      .execute(&pool)
      .await
      .expect("insert snapshot workspace");
    }

    let public_doc = Uuid::new_v4();
    let private_doc = Uuid::new_v4();
    let local_private = Uuid::new_v4();
    let unplaced_doc = Uuid::new_v4();
    let external_doc = Uuid::new_v4();
    let system_doc = Uuid::new_v4();
    let reserved_doc = Uuid::new_v4();
    let public_key = format!("snapshot-public-{}", public_doc.simple());
    let private_key = format!("snapshot-private-{}", private_doc.simple());
    for (workspace_id, doc_id, external_id, title) in [
      (public_workspace, public_doc, public_key.as_str(), "Offline document"),
      (public_workspace, unplaced_doc, "../escape", "Unplaced public guide"),
      (public_workspace, reserved_doc, "index.html", "Reserved index document"),
      (
        public_workspace,
        local_private,
        "local-private",
        "Private folder sentinel",
      ),
      (external_workspace, external_doc, "external-guide", "External guide"),
      (
        public_workspace,
        system_doc,
        "userdata$fixture$favorite",
        "System preferences sentinel",
      ),
      (
        private_workspace,
        private_doc,
        private_key.as_str(),
        "Private selected document",
      ),
    ] {
      sqlx::query(
        "INSERT INTO docs (id, external_id, workspace_id, title, created_by, updated_by, public_mode)
       VALUES ($1, $2, $3, $4, $5, $5, 'Page')",
      )
      .bind(doc_id)
      .bind(external_id)
      .bind(workspace_id)
      .bind(title)
      .bind(user_id)
      .execute(&pool)
      .await
      .expect("insert snapshot document");
      let body = if doc_id == public_doc {
        format!("# {title}\n\nOffline body.\n\n![Overview image](overview.png)")
      } else {
        format!("# {title}\n\nOffline body.")
      };
      let payload = yjs::markdown_to_yjs(title, &body).expect("build snapshot Yjs");
      sqlx::query("INSERT INTO doc_snapshots (doc_id, workspace_id, payload, last_sequence) VALUES ($1, $2, $3, 0)")
        .bind(doc_id)
        .bind(workspace_id)
        .bind(payload)
        .execute(&pool)
        .await
        .expect("insert document snapshot");
    }

    sqlx::query("UPDATE docs SET public_mode = NULL WHERE id = $1")
      .bind(local_private)
      .execute(&pool)
      .await
      .expect("keep local document private");
    // The complete snapshot must not inherit the live register's fifty-row cap.
    let extra_docs = (0..49).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
    sqlx::query(
      "INSERT INTO docs (id,external_id,workspace_id,title,created_by,updated_by,public_mode)
      SELECT id,id::text,$2,'Paging ' || lpad(position::text,2,'0'),$3,$3,'Page'
      FROM unnest($1::uuid[]) WITH ORDINALITY AS fixture(id,position)",
    )
    .bind(&extra_docs)
    .bind(public_workspace)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
      "INSERT INTO doc_snapshots (doc_id,workspace_id,payload,last_sequence)
      SELECT id,$2,$3,0 FROM unnest($1::uuid[]) id",
    )
    .bind(&extra_docs)
    .bind(public_workspace)
    .bind(yjs::markdown_to_yjs("Paging", "Complete retained register").unwrap())
    .execute(&pool)
    .await
    .unwrap();
    let tag_id = Uuid::new_v4();
    sqlx::query(
      "INSERT INTO workspace_tags (id,workspace_id,name,slug,color_role)
      VALUES ($1,$2,'Snapshot <&> label','snapshot-label','tag.blue')",
    )
    .bind(tag_id)
    .bind(public_workspace)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
      "INSERT INTO workspace_tag_document_assignments (workspace_id,doc_id,tag_id,position)
      VALUES ($1,$2,$3,0)",
    )
    .bind(public_workspace)
    .bind(public_doc)
    .bind(tag_id)
    .execute(&pool)
    .await
    .unwrap();
    let workspaces = WorkspaceService::new(Arc::new(SqlxWorkspaceStore::new(
      pool.clone(),
      support::database_starter_catalog(),
    )));
    workspaces
      .seed_root_doc(
        public_workspace,
        user_id,
        yjs::create_initial_workspace_doc("Snapshot workspace"),
      )
      .await
      .expect("seed canonical workspace root");
    let organizer = OrganizerService::new(DocService::new(Arc::new(SqlxDocStore::new(pool.clone()))));
    for (id, parent, name) in [
      ("services", None, "Services & systems"),
      ("monitoring / nested", Some("services"), "Monitoring"),
      ("intro-only", None, "Monitoring"),
      ("private-only", None, "Private branch sentinel"),
      ("collection-only", None, "Collection branch sentinel"),
    ] {
      organizer
        .create_folder(
          public_workspace,
          CreateOrganizerFolder {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            name: name.into(),
            index: None,
          },
        )
        .await
        .expect("create canonical folder");
    }
    for (id, parent, kind, target, workspace) in [
      (
        "local",
        "monitoring / nested",
        OrganizerLinkType::Doc,
        public_key.as_str(),
        None,
      ),
      ("private", "private-only", OrganizerLinkType::Doc, "local-private", None),
      (
        "external",
        "services",
        OrganizerLinkType::Doc,
        "external-guide",
        Some(external_workspace),
      ),
      (
        "collection",
        "collection-only",
        OrganizerLinkType::Collection,
        "orthogonal",
        None,
      ),
    ] {
      organizer
        .create_link(
          public_workspace,
          CreateOrganizerLink {
            id: id.into(),
            parent_id: parent.into(),
            link_type: kind,
            target_id: target.into(),
            target_workspace_id: workspace,
            index: None,
          },
        )
        .await
        .expect("create existing resource placement");
    }
    let introduction =
      WorkspaceContentResourceRef::new(public_workspace, WorkspaceContentResourceKind::Document, &public_key).unwrap();
    let settings = WorkspaceOverviewSettings {
      introduction: Some(introduction.clone()),
      register_presentation: Some(OverviewRegisterPresentation {
        display_properties: ["tags", "title", "createdAt", "createdBy"]
          .map(|key| format!("system:{key}"))
          .into(),
        order_by: OverviewOrderBy {
          property_type: "system".into(),
          key: "title".into(),
          desc: false,
        },
      }),
      folders: BTreeMap::from([
        (
          "monitoring / nested".into(),
          FolderOverviewSettings {
            introduction: Some(introduction.clone()),
            register_presentation: Some(OverviewRegisterPresentation {
              display_properties: vec!["system:title".into(), "system:createdAt".into()],
              ..Default::default()
            }),
            ..Default::default()
          },
        ),
        (
          "intro-only".into(),
          FolderOverviewSettings {
            introduction: Some(introduction),
            ..Default::default()
          },
        ),
      ]),
      ..Default::default()
    };
    sqlx::query("UPDATE workspaces SET overview_settings = $2, overview_revision = 1 WHERE id = $1")
      .bind(public_workspace)
      .bind(serde_json::to_value(settings).unwrap())
      .execute(&pool)
      .await
      .expect("configure overview fixture");

    let template_root = tempfile::tempdir().expect("external snapshot template root");
    support::copy_feature_templates(template_root.path());
    let shipped = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../templates/html");
    for name in myoxus_public_render::HTML_CATALOG_FILES {
      let target = template_root.path().join("html").join(name);
      fs::create_dir_all(target.parent().unwrap()).unwrap();
      fs::copy(shipped.join(name), &target).unwrap();
    }
    let shell = template_root.path().join("html/public_page.html.tera");
    fs::write(
      &shell,
      fs::read_to_string(&shell)
        .unwrap()
        .replace("</body>", "<p data-snapshot-catalog>External snapshot shell</p></body>"),
    )
    .unwrap();
    let css = template_root.path().join("html/assets/public.css");
    fs::write(
      &css,
      format!(
        "{}\n/* external snapshot stylesheet */\n",
        fs::read_to_string(&css).unwrap()
      ),
    )
    .unwrap();
    let js = template_root.path().join("html/assets/public.js");
    fs::write(
      &js,
      format!("{}\n/* external snapshot script */\n", fs::read_to_string(&js).unwrap()),
    )
    .unwrap();
    let output_root = tempfile::tempdir().expect("snapshot output root");
    let storage_root = tempfile::tempdir().expect("snapshot blob root");
    let image = include_bytes!(concat!(
      env!("CARGO_MANIFEST_DIR"),
      "/../../templates/mail/assets/product-mark.png"
    ));
    let image_path = storage_root
      .path()
      .join(public_workspace.to_string())
      .join("overview.png");
    fs::create_dir_all(image_path.parent().unwrap()).unwrap();
    fs::write(&image_path, image).unwrap();
    sqlx::query(
      "INSERT INTO blobs (workspace_id,key,size,mime,status) VALUES ($1,'overview.png',$2,'image/png','completed')",
    )
    .bind(public_workspace)
    .bind(image.len() as i64)
    .execute(&pool)
    .await
    .expect("materialize introduction image");
    let output = support::cli_command()
      .env("RUN_MODE", "development")
      .env("MYOXUS__DATABASE__URL", database_url())
      .env("MYOXUS__TEMPLATES__ROOT_DIR", template_root.path())
      .env("MYOXUS__SERVER__ORIGIN", "http://source-api.invalid")
      .arg("public")
      .arg("export")
      .arg("--output-root")
      .arg(output_root.path())
      .arg("--storage-root")
      .arg(storage_root.path())
      .arg("--public-origin")
      .arg("http://snapshot.invalid")
      .arg("--skip-pagefind")
      .arg("--skip-social-cards")
      .output()
      .expect("run public snapshot export");
    assert!(
      output.status.success(),
      "public snapshot export failed:\nstdout: {}\nstderr: {}",
      String::from_utf8_lossy(&output.stdout),
      String::from_utf8_lossy(&output.stderr)
    );

    let release = fs::canonicalize(output_root.path().join("current")).expect("resolve current snapshot release");
    let public_index_path = release.join(format!("public/{public_workspace}/index.html"));
    let empty_index_path = release.join(format!("public/{empty_workspace}/index.html"));
    let private_index_path = release.join(format!("public/{private_workspace}/index.html"));
    let document_path = release.join(format!("public/{public_workspace}/{public_key}/index.html"));
    let public_index = fs::read_to_string(&public_index_path).expect("read public workspace index");
    let empty_index = fs::read_to_string(&empty_index_path).expect("read empty public workspace index");
    let document = fs::read_to_string(&document_path).expect("read public snapshot document");
    let document_urls = document.replace("&#x2F;", "/").replace("&#x2f;", "/");

    assert!(public_index.contains("<html lang=\"en\""));
    assert!(public_index.contains("First line\nSecond line"));
    assert!(public_index.contains(&format!("href=\"{public_key}/index.html\"")));
    assert!(public_index.contains("Unplaced public guide"));
    assert_eq!(
      public_index.matches("data-myoxus-role=\"public-index-link\"").count(),
      52
    );
    assert!(public_index.contains(">52 documents<") && public_index.contains("Paging 49"));
    assert!(public_index.find("Paging 01").unwrap() < public_index.find("Paging 49").unwrap());
    let columns = |html: &str| {
      html
        .split("data-register-key=\"")
        .skip(1)
        .map(|part| part.split('"').next().unwrap().to_string())
        .collect::<Vec<_>>()
    };
    assert_eq!(columns(&public_index), ["tags", "title", "createdAt"]);
    assert!(public_index.contains("Snapshot &lt;&amp;&gt; label"));
    assert!(empty_index.contains("data-myoxus-role=\"public-index-empty\""));
    assert!(!private_index_path.exists(), "private workspace must not be exported");
    assert!(
      !release
        .join(format!("public/{private_workspace}/{private_key}"))
        .exists()
    );
    assert!(document_urls.contains("href=\"../index.html\""));
    assert!(document_urls.contains("href=\"../../../theme/theme-runtime-theme.css\""));
    assert!(document_urls.contains("href=\"../../../assets/public.css\""));
    assert!(document_urls.contains("href=\"../../../favicon.ico\""));

    let folder = |id: &str| format!("~folders/{:x}", Sha256::digest(id.as_bytes()));
    let parent_dir = release.join(format!("public/{public_workspace}/{}", folder("services")));
    let nested_dir = release.join(format!("public/{public_workspace}/{}", folder("monitoring / nested")));
    let parent_html = fs::read_to_string(parent_dir.join("index.html")).expect("read parent overview");
    let nested_html = fs::read_to_string(nested_dir.join("index.html")).expect("read nested overview");
    let normalized = |html: &str| html.replace("&#x2F;", "/").replace("&#x2f;", "/");
    let public_urls = normalized(&public_index);
    let parent_urls = normalized(&parent_html);
    let nested_urls = normalized(&nested_html);
    assert_eq!(columns(&nested_html), ["title", "createdAt"]);
    assert!(!nested_html.contains("Snapshot &lt;&amp;&gt; label"));
    // Follow the actual generated route shapes through the staged files. These
    // assertions fail for missing pages, wrong depths and internal UUID fallbacks.
    let root_dir = public_index_path.parent().unwrap();
    let parent_href = format!("{}/index.html", folder("services"));
    assert!(public_urls.contains(&format!("href=\"{parent_href}\"")));
    assert_eq!(
      fs::canonicalize(root_dir.join(&parent_href)).unwrap(),
      fs::canonicalize(parent_dir.join("index.html")).unwrap()
    );
    let nested_href = format!("../{:x}/index.html", Sha256::digest(b"monitoring / nested"));
    assert!(parent_urls.contains(&format!("href=\"{nested_href}\"")));
    assert_eq!(
      fs::canonicalize(parent_dir.join(&nested_href)).unwrap(),
      fs::canonicalize(nested_dir.join("index.html")).unwrap()
    );
    let doc_href = format!("../../{public_key}/index.html");
    assert!(nested_urls.contains(&format!("href=\"{doc_href}\"")));
    assert_eq!(
      fs::canonicalize(nested_dir.join(&doc_href)).unwrap(),
      fs::canonicalize(&document_path).unwrap()
    );
    assert_eq!(
      fs::canonicalize(document_path.parent().unwrap().join("../index.html")).unwrap(),
      fs::canonicalize(&public_index_path).unwrap()
    );
    assert!(
      nested_urls.contains("<a class=\"mx-public-brand\" href=\"../../index.html\">"),
      "the folder shell's home link must return to the real workspace root"
    );
    assert!(
      parent_urls.contains(&format!(
        "href=\"http://source-api.invalid/public/{external_workspace}/external-guide\""
      )),
      "qualified references remain external even when their workspace is also exported"
    );
    assert!(
      !parent_urls.contains(&format!("href=\"../../{public_key}/index.html\"")),
      "parent register cannot absorb child documents"
    );
    assert!(nested_html.contains("<h1>Monitoring</h1>"));
    assert!(
      nested_html.contains(">Offline document</h1>"),
      "introduction uses native structured document IR"
    );
    let asset = format!(
      "public-assets/{public_workspace}/{public_doc}/{:x}/overview.png",
      Sha256::digest(b"overview.png")
    );
    assert!(public_urls.contains(&format!("src=\"../../{asset}\"")));
    assert!(nested_urls.contains(&format!("src=\"../../../../{asset}\"")));
    assert_eq!(
      fs::read(nested_dir.join(format!("../../../../{asset}"))).unwrap(),
      image
    );
    let unsafe_segment = format!("~doc-{:x}", Sha256::digest(b"../escape"));
    assert!(public_urls.contains(&format!("href=\"{unsafe_segment}/index.html\"")));
    assert!(root_dir.join(&unsafe_segment).join("index.html").is_file());
    assert!(
      !root_dir.parent().unwrap().join("escape").exists(),
      "external keys cannot traverse out of their workspace"
    );
    let folder_routes = fs::read_dir(root_dir.join("~folders")).unwrap().count();
    assert_eq!(
      folder_routes, 3,
      "only Services, Monitoring and introduction-only folders are public"
    );
    assert!(!public_index.contains("Private branch sentinel") && !public_index.contains("Collection branch sentinel"));

    assert!(document.contains("data-snapshot-catalog") && public_index.contains("data-snapshot-catalog"));
    assert_eq!(
      fs::read(release.join("assets/public.css")).unwrap(),
      fs::read(&css).unwrap()
    );
    assert_eq!(
      fs::read(release.join("assets/public.js")).unwrap(),
      fs::read(&js).unwrap()
    );
    use myoxus_public_render::HtmlRendererProvider;
    let catalog = myoxus_infrastructure::html_templates::FilesystemHtmlCatalog::new(template_root.path().join("html"));
    let manifest: serde_json::Value =
      serde_json::from_slice(&fs::read(release.join("manifest.json")).unwrap()).unwrap();
    let exported = manifest["document_routes"]
      .as_array()
      .unwrap()
      .iter()
      .filter(|doc| doc["workspace_id"] == public_workspace.to_string())
      .map(|doc| doc["doc_id"].as_str().unwrap().to_string())
      .collect::<std::collections::BTreeSet<_>>();
    assert_eq!(
      exported,
      std::collections::BTreeSet::from([
        public_doc.to_string(),
        unplaced_doc.to_string(),
        reserved_doc.to_string()
      ])
      .into_iter()
      .chain(extra_docs.iter().map(ToString::to_string))
      .collect(),
      "system payloads and private documents must not become snapshot/search artifacts"
    );
    assert_eq!(
      manifest["renderer_version"],
      catalog
        .renderer()
        .unwrap()
        .renderer_version(myoxus_application::public::PUBLIC_RENDERER_VERSION)
    );

    let theme = fs::read_to_string(release.join("theme/theme-runtime-theme.css")).expect("read snapshot theme");
    assert!(theme.contains("url('../fonts/"));
    assert!(release.join("fonts/inter-regular-latin.woff2").is_file());
    assert!(release.join("favicon.ico").is_file());

    let release_id = release.file_name().unwrap().to_str().unwrap();
    sqlx::query("UPDATE workspaces SET overview_settings = overview_settings #- '{folders,intro-only}' WHERE id = $1")
      .bind(public_workspace)
      .execute(&pool)
      .await
      .expect("remove last qualifying introduction binding");
    let activation = support::cli_command()
      .env("RUN_MODE", "development")
      .env("MYOXUS__DATABASE__URL", database_url())
      .env("MYOXUS__TEMPLATES__ROOT_DIR", template_root.path())
      .args([
        "public",
        "activate-release",
        "--release-id",
        release_id,
        "--output-root",
      ])
      .arg(output_root.path())
      .output()
      .expect("validate retained snapshot eligibility");
    assert!(
      !activation.status.success(),
      "activation must reject a folder whose last qualifying introduction disappeared"
    );
    assert!(String::from_utf8_lossy(&activation.stderr).contains("folder which is no longer public"));
    assert_eq!(
      fs::canonicalize(output_root.path().join("current")).unwrap(),
      release,
      "failed activation cannot change current"
    );
  })
  .await;

  sqlx::query("DELETE FROM workspaces WHERE id = ANY($1)")
    .bind(vec![
      public_workspace,
      empty_workspace,
      private_workspace,
      external_workspace,
    ])
    .execute(&pool)
    .await
    .expect("cleanup snapshot workspaces");
  sqlx::query("DELETE FROM users WHERE id = $1")
    .bind(user_id)
    .execute(&pool)
    .await
    .expect("cleanup snapshot owner");
  outcome.expect("snapshot contract after fixture cleanup");
}
