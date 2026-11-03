#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Consuming loader failures in the isolated test-build.sh database and mount.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readZip, writeZip } from "../zip-archive.mjs";
import YAML from "yaml";
import { parse, print, separateOperations } from "graphql";
import { createHash, randomUUID } from "node:crypto";

const [api, postgres, root] = process.argv.slice(2);
const archiveBytes = (archive, name) => {
  const entry = archive.get(name);
  assert(entry && !entry.directory, `Missing archive file: ${name}`);
  return entry.data;
};
const archiveText = (archive, name) =>
  archiveBytes(archive, name).toString("utf8");
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 60000 });
// Loader recovery restarts can change Docker's ephemeral published port.
const apiOrigin = () => `http://${docker("port", api, "3001/tcp").trim()}`;
const curl = (...args) =>
  execFileSync("curl", args, { encoding: "utf8", timeout: 60000 });
const sleep = () => new Promise((resolve) => setTimeout(resolve, 250));
const revisions = () =>
  docker(
    "exec",
    postgres,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "myoxus",
    "-d",
    "myoxus",
    "-Atc",
    "SELECT e.slug,r.id,r.version,r.checksum,r.state,r.manifest_json FROM template_catalog_entries e JOIN template_revisions r ON r.template_id=e.id WHERE e.slug IN ('meeting-focus','meeting-agenda','meeting-register') ORDER BY e.slug,r.version",
  );
const pdfBundles = () =>
  docker(
    "exec",
    postgres,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "myoxus",
    "-d",
    "myoxus",
    "-Atc",
    "SELECT t.id,t.slug,t.version,t.created_by,t.manifest,f.file_path,f.blob_key,f.content_hash FROM pdf_templates t JOIN pdf_template_files f ON f.template_id=t.id ORDER BY t.slug,f.file_path",
  );
const beforePdf = pdfBundles();
const before = revisions();

const sql = (query) =>
  docker(
    "exec",
    postgres,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "myoxus",
    "-d",
    "myoxus",
    "-Atc",
    query,
  );
const documentStates = () =>
  sql(
    "SELECT e.slug,r.version,r.checksum,r.state,r.manifest_json,r.id FROM template_catalog_entries e JOIN template_revisions r ON r.template_id=e.id ORDER BY e.slug,r.version",
  );
async function startHealthy() {
  docker("start", api);
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      docker("exec", api, "myoxus-cli", "container", "health");
      return;
    } catch (error) {
      const running = docker("inspect", "-f", "{{.State.Running}}", api).trim();
      if (running !== "true" || attempt === 119) {
        const logs = spawnSync("docker", ["logs", "--tail", "60", api], {
          encoding: "utf8",
          timeout: 60000,
        });
        process.stderr.write(logs.stdout ?? "");
        process.stderr.write(logs.stderr ?? "");
      }
      assert.equal(running, "true", "catalog startup exited");
      if (attempt === 119) throw error;
      await sleep();
    }
  }
}
const catalogPath = join(root, "templates/features/catalog.yaml");
const catalog = YAML.parse(readFileSync(catalogPath, "utf8"));
const basePin = catalog.base;
const baseRelative = `features/${basePin.id}/${basePin.version}.myoxus.zip`;
const basePath = join(root, "templates", baseRelative);
const baseBytes = readFileSync(basePath);
assert.equal(
  createHash("sha256").update(baseBytes).digest("hex"),
  basePin.sha256,
);
const baseArchive = await readZip(baseBytes);
const baseManifest = YAML.parse(archiveText(baseArchive, "manifest.yaml"));
const image = docker("inspect", "-f", "{{.Image}}", api).trim();
const nativeCli = (...args) =>
  docker(
    "run",
    "--rm",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--entrypoint",
    "/usr/local/bin/myoxus-cli",
    "-v",
    `${root}:/fixture:rw`,
    image,
    ...args,
  );
const nativeSourceSet = () =>
  docker(
    "run",
    "--rm",
    "--entrypoint",
    "/usr/local/bin/myoxus-cli",
    "-v",
    `${join(root, "templates")}:/opt/myoxus/templates:ro`,
    image,
    "templates",
    "validate-source-set",
    "--root",
    "/opt/myoxus/templates",
  );
// The image owns its independent expectation outside this read-only mount.
// Mounted auxiliary metadata is deliberately not another active pointer.
nativeSourceSet();
for (const family of ["databases", "assistants", "documents"]) {
  assert.equal(
    existsSync(join(root, "templates", family)),
    false,
    `bundled ${family} must have no loose runtime source tree`,
  );
}
const nativeComponent = async (kind) => {
  const component = baseManifest.components.find(
    (component) => component.kind === kind,
  );
  assert(component, `missing actual native component ${kind}`);
  return YAML.parse(archiveText(baseArchive, component.path));
};
const databaseCatalog = await nativeComponent("databaseCatalog");
const nativeDefinitionDocuments = new WeakMap();
const nativeDefinition = async (entry) => {
  const reference = entry.definitions.find(
    (reference) => reference.version === entry.current,
  );
  const component = baseManifest.components.find(
    (component) => component.kind === "databaseCatalog",
  );
  const parent = component.path.slice(0, component.path.lastIndexOf("/") + 1);
  const document = YAML.parseDocument(
    archiveText(baseArchive, parent + reference.path),
  );
  assert.equal(document.errors.length, 0);
  const definition = document.toJS();
  nativeDefinitionDocuments.set(definition, document);
  return definition;
};
const source = await nativeDefinition(
  databaseCatalog.templates.find(
    (entry) => entry.id === "myoxus.database.simple_task_list",
  ),
);
const originalSource = structuredClone(source);
source.id = "myoxus.database.fixture.packaged_task_list";
delete source.supported_predecessors;
for (const variant of source.variants) variant.spec.id = source.id;
const marker = "Packaged mounted task list",
  fieldMarker = "Packaged mounted Task";
source.variants[0].spec.name = marker;
source.variants[0].spec.fields[0].name = fieldMarker;
source.variants[0].spec.metadata.import_mappings[0].columnMappings[0].sourceHeader =
  fieldMarker;
const extraDatabaseId = "myoxus.database.fixture.packaged_extra";
const blankEntry = databaseCatalog.templates.find(
  (entry) => entry.id === "myoxus.database.blank",
);
const extraDatabase = await nativeDefinition(blankEntry);
extraDatabase.id = extraDatabaseId;
delete extraDatabase.supported_predecessors;
for (const variant of extraDatabase.variants) {
  variant.spec.id = extraDatabaseId;
  variant.spec.name = "Packaged extra Database";
}
const fixtureSource = join(root, "feature-fixture/source");
mkdirSync(join(fixtureSource, "databases"), { recursive: true });
mkdirSync(join(fixtureSource, "assistants"), { recursive: true });
const projectEntry = databaseCatalog.templates.find(
  (entry) =>
    entry.id ===
    databaseCatalog.system_sources.find(
      (entry) => entry.role === "projectDefault",
    ).template_id,
);
const extraProject = await nativeDefinition(projectEntry);
extraProject.id = "myoxus.project.fixture.packaged_project";
delete extraProject.supported_predecessors;
for (const variant of extraProject.variants) {
  variant.spec.id = extraProject.id;
  variant.spec.name = "Packaged independent Project";
  const metadataRole = variant.spec.roles.find(
    (role) => role.role_key === "project.template",
  );
  assert(
    metadataRole,
    "external Project retains its native template identity role",
  );
  metadataRole.config.templateId = extraProject.id;
}
assert(
  extraProject.task_core,
  "managed external Project requires the native platform Task core",
);
const definitions = [extraDatabase, source, extraProject];
const entries = definitions.map((definition) => {
  const original = databaseCatalog.templates.find(
    (entry) =>
      entry.id ===
      (definition === source
        ? originalSource.id
        : definition === extraProject
          ? projectEntry.id
          : blankEntry.id),
  );
  const reference = original.definitions.find(
    (reference) => reference.version === original.current,
  );
  // Mutate only authored fixture identity/copy in the native YAML tree. JS
  // number serialization would collapse native f64 samples such as 0.0 to 0.
  const document = nativeDefinitionDocuments.get(definition);
  document.set("id", definition.id);
  document.delete("supported_predecessors");
  definition.variants.forEach((variant, index) => {
    document.setIn(["variants", index, "spec", "id"], variant.spec.id);
    // Retained definitions may carry a strict redundant manifest assertion;
    // its identity must describe this cloned native source as well.
    if (variant.spec.manifest)
      document.setIn(
        ["variants", index, "spec", "manifest", "id"],
        variant.spec.id,
      );
    document.setIn(["variants", index, "spec", "name"], variant.spec.name);
    const metadataRole = variant.spec.roles.findIndex(
      (role) => role.role_key === "project.template",
    );
    if (metadataRole >= 0)
      document.setIn(
        [
          "variants",
          index,
          "spec",
          "roles",
          metadataRole,
          "config",
          "templateId",
        ],
        definition.id,
      );
  });
  if (definition === source) {
    document.setIn(["variants", 0, "spec", "fields", 0, "name"], fieldMarker);
    document.setIn(
      [
        "variants",
        0,
        "spec",
        "metadata",
        "import_mappings",
        0,
        "columnMappings",
        0,
        "sourceHeader",
      ],
      fieldMarker,
    );
  }
  const bytes = document.toString(),
    relative = `${definition.id}/${definition.version}.yaml`;
  mkdirSync(join(fixtureSource, "databases", definition.id), {
    recursive: true,
  });
  writeFileSync(join(fixtureSource, "databases", relative), bytes);
  const entry = {
    ...structuredClone(original),
    id: definition.id,
    definitions: [
      {
        ...reference,
        path: relative,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    ],
  };
  // This clone owns its identities; base Update references cannot be inherited.
  delete entry.updates;
  return entry;
});
// Retain the fixture Project's actual native predecessor and exact structural
// edge. Only the identity-bearing YAML nodes change; sample f64 bytes survive.
const projectHistory = await nativeDefinition({
  ...projectEntry,
  current: "1.0.0",
});
const projectHistoryDocument = nativeDefinitionDocuments.get(projectHistory);
projectHistoryDocument.set("id", extraProject.id);
projectHistoryDocument.delete("supported_predecessors");
projectHistory.variants.forEach((variant, index) => {
  projectHistoryDocument.setIn(
    ["variants", index, "spec", "id"],
    extraProject.id,
  );
  if (variant.spec.manifest)
    projectHistoryDocument.setIn(
      ["variants", index, "spec", "manifest", "id"],
      extraProject.id,
    );
  projectHistoryDocument.setIn(
    ["variants", index, "spec", "name"],
    "Packaged independent Project",
  );
  const role = variant.spec.roles.findIndex(
    (role) => role.role_key === "project.template",
  );
  assert(role >= 0, "retained Project has its native template identity role");
  projectHistoryDocument.setIn(
    ["variants", index, "spec", "roles", role, "config", "templateId"],
    extraProject.id,
  );
});
const projectHistoryBytes = projectHistoryDocument.toString();
const projectHistoryPath = `${extraProject.id}/${projectHistory.version}.yaml`;
writeFileSync(
  join(fixtureSource, "databases", projectHistoryPath),
  projectHistoryBytes,
);
const projectCatalogEntry = entries.find(
  (entry) => entry.id === extraProject.id,
);
const historyReference = projectEntry.definitions.find(
  (reference) => reference.version === projectHistory.version,
);
assert(historyReference, "fixture retains an actual native source definition");
projectCatalogEntry.definitions.push({
  ...historyReference,
  path: projectHistoryPath,
  sha256: createHash("sha256").update(projectHistoryBytes).digest("hex"),
});
const projectUpdatePath = `${extraProject.id}/updates/${projectHistory.version}-to-${extraProject.version}.yaml`;
const projectUpdate = {
  format_version: 1,
  template_id: extraProject.id,
  source: {
    version: projectHistory.version,
    sha256: projectCatalogEntry.definitions[1].sha256,
  },
  target: {
    version: extraProject.version,
    sha256: projectCatalogEntry.definitions[0].sha256,
  },
  operations: [],
};
const projectUpdateBytes = YAML.stringify(projectUpdate);
mkdirSync(dirname(join(fixtureSource, "databases", projectUpdatePath)), {
  recursive: true,
});
writeFileSync(
  join(fixtureSource, "databases", projectUpdatePath),
  projectUpdateBytes,
);
projectCatalogEntry.updates = [
  {
    from: projectHistory.version,
    to: extraProject.version,
    path: projectUpdatePath,
    sha256: createHash("sha256").update(projectUpdateBytes).digest("hex"),
  },
];
const sourceDatabaseCatalog = {
  ...databaseCatalog,
  templates: entries,
};
// Optional providers declare no system roles; the native canonical encoding
// omits this empty optional list rather than serializing an explicit [].
delete sourceDatabaseCatalog.system_sources;
writeFileSync(
  join(fixtureSource, "databases/catalog.yaml"),
  YAML.stringify(sourceDatabaseCatalog),
);
const assistantCatalog = await nativeComponent("assistantCatalog");
const originalPackage = assistantCatalog.packages.find((entry) =>
  entry.defaultFor.includes("projectCreation"),
);
const originalPackageRef = originalPackage.definitions.find(
  (ref) => ref.version === originalPackage.current,
);
const assistantComponent = baseManifest.components.find(
  (component) => component.kind === "assistantCatalog",
);
const assistantParent = assistantComponent.path.slice(
  0,
  assistantComponent.path.lastIndexOf("/") + 1,
);
const extraPackage = YAML.parse(
  archiveText(baseArchive, assistantParent + originalPackageRef.path),
);
extraPackage.id = "myoxus.assistant.fixture.packaged_project";
extraPackage.name = {
  en: "Packaged extra Project",
  de: "Paketiertes Zusatzprojekt",
  fr: "Projet supplémentaire",
  es: "Proyecto adicional",
};
const projectAction = extraPackage.components.find(
  (component) => component.action.kind === "createProject",
);
assert(
  projectAction,
  "external assistant requires a native Project creation action",
);
projectAction.action.templateId = extraProject.id;
const artworkStep = extraPackage.presentation.steps.find((step) =>
  step.groups.some((group) => group.role === "content"),
);
const artworkGroup = artworkStep.groups.find(
  (group) => group.role === "content",
);
const artworkGroupKey = `group/${artworkStep.id}/${artworkGroup.id}`;
const extraArtworkBytes = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160" viewBox="0 0 320 160"><rect x="8" y="8" width="304" height="144" fill="#eeeeee"/><path d="M24 48H296M112 48V136M208 48V136" stroke="#444444" fill="none"/><rect x="32" y="64" width="64" height="24" fill="#888888"/><rect x="128" y="96" width="64" height="24" fill="#888888"/><rect x="224" y="64" width="64" height="24" fill="#888888"/></svg>',
);
mkdirSync(join(fixtureSource, "artwork"), { recursive: true });
writeFileSync(join(fixtureSource, "artwork/project.svg"), extraArtworkBytes);
const extraArtworkMetadata = {
  mediaType: "image/svg+xml",
  width: 320,
  height: 160,
  alternative: {
    en: "Project tasks arranged in three columns",
    de: "Projektaufgaben in drei Spalten",
    fr: "Tâches du projet réparties en trois colonnes",
    es: "Tareas del proyecto organizadas en tres columnas",
  },
  caption: {
    en: "An independent Project with native views",
    de: "Ein eigenständiges Projekt mit nativen Ansichten",
    fr: "Un projet indépendant avec des vues natives",
    es: "Un proyecto independiente con vistas nativas",
  },
};
const extraPackageRelative = `${extraPackage.id}/${extraPackage.version}.yaml`;
const extraPackageBytes = YAML.stringify(extraPackage);
mkdirSync(join(fixtureSource, "assistants", extraPackage.id), {
  recursive: true,
});
writeFileSync(
  join(fixtureSource, "assistants", extraPackageRelative),
  extraPackageBytes,
);
writeFileSync(
  join(fixtureSource, "assistants/catalog.yaml"),
  YAML.stringify({
    ...assistantCatalog,
    packages: [
      {
        id: extraPackage.id,
        current: extraPackage.version,
        defaultFor: [],
        definitions: [
          {
            version: extraPackage.version,
            path: extraPackageRelative,
            sha256: createHash("sha256")
              .update(extraPackageBytes)
              .digest("hex"),
          },
        ],
      },
    ],
  }),
);
const documentExport = baseManifest.exports.find(
  (entry) => entry.id === "document.meeting-agenda",
);
const documentComponent = baseManifest.components.find(
  (component) => component.id === documentExport?.source.component,
);
assert(
  documentComponent,
  "current native Document source is captured by the release",
);
const documentBytes = archiveBytes(baseArchive, documentComponent.path);
const documentArchive = await readZip(documentBytes);
const documentManifest = JSON.parse(
  archiveText(documentArchive, "manifest.json"),
);
documentManifest.template_id = "packaged-fixture-document";
documentManifest.version = "1.0.0";
documentArchive.set("manifest.json", {
  data: Buffer.from(JSON.stringify(documentManifest)),
  directory: false,
});
writeFileSync(
  join(fixtureSource, "document.zip"),
  await writeZip(documentArchive),
);
const taskCoreExport = baseManifest.exports.find(
  (entry) =>
    entry.source.export ===
    `${extraProject.task_core.id}@${extraProject.task_core.version}`,
);
assert(
  taskCoreExport,
  "external Project pins an actual platform Task core export",
);
const linkedDocumentExport = baseManifest.exports.find(
  (entry) => entry.document && !entry.document.newWorkspaceDefault,
);
assert(
  linkedDocumentExport,
  "manual Library association requires an actual platform Document export",
);
const linkedDocumentComponent = baseManifest.components.find(
  (component) => component.id === linkedDocumentExport.source.component,
);
// Internal child sources need not be public platform exports. Clone their
// content under fixture identities, without claiming another bundle's ownership.
const documentBindings = await Promise.all(
  extraPackage.components
    .filter((component) => component.action.kind === "createDocument")
    .map(async (component) => {
      const key = `component/${component.id}`;
      const links = baseManifest.links.filter(
        (link) =>
          link.kind === "documentComponent" &&
          link.from.component === assistantComponent.id &&
          link.from.export ===
            `${originalPackage.id}@${originalPackageRef.version}` &&
          link.from.key === key,
      );
      assert.equal(links.length, 1, `native child ${key} requires one source`);
      assert.equal(links[0].to.scope, "local");
      const reference = links[0].to.reference;
      const source = baseManifest.components.find(
        (entry) => entry.id === reference.component,
      );
      assert.equal(source?.kind, "documentTemplate");
      const id = `native-child-${component.id}`;
      const path = `${id}.zip`;
      const childArchive = await readZip(
        archiveBytes(baseArchive, source.path),
      );
      const childManifest = JSON.parse(
        archiveText(childArchive, "manifest.json"),
      );
      childManifest.template_id = `packaged-fixture-${id}`;
      childArchive.set("manifest.json", {
        data: Buffer.from(JSON.stringify(childManifest)),
        directory: false,
      });
      const childBytes = await writeZip(childArchive);
      writeFileSync(join(fixtureSource, path), childBytes);
      return {
        source: { id, kind: "documentTemplate", path },
        link: {
          kind: "documentComponent",
          from: {
            component: "assistants",
            export: `${extraPackage.id}@${extraPackage.version}`,
            key,
          },
          to: {
            scope: "local",
            reference: {
              component: id,
              export: `${childManifest.template_id}@${childManifest.version}`,
            },
          },
        },
        descriptor: {
          componentId: component.id,
          templateId: childManifest.template_id,
          version: childManifest.version,
          digest: createHash("sha256").update(childBytes).digest("hex"),
        },
      };
    }),
);
const featureSource = {
  formatVersion: 1,
  id: "example.packaged.fixture",
  version: "1.0.0",
  capabilities: { database: 1, assistant: 1, documentTemplate: 1, artwork: 1 },
  components: [
    {
      id: "databases",
      kind: "databaseCatalog",
      path: "databases/catalog.yaml",
    },
    {
      id: "assistants",
      kind: "assistantCatalog",
      path: "assistants/catalog.yaml",
    },
    { id: "document", kind: "documentTemplate", path: "document.zip" },
    ...documentBindings.map((binding) => binding.source),
    {
      id: "project-preview",
      kind: "artwork",
      path: "artwork/project.svg",
      artwork: extraArtworkMetadata,
    },
  ],
  links: [
    ...documentBindings.map((binding) => binding.link),
    {
      kind: "schema",
      from: {
        component: "assistants",
        export: `${extraPackage.id}@${extraPackage.version}`,
        key: `component/${projectAction.id}`,
      },
      to: {
        scope: "local",
        reference: {
          component: "databases",
          export: `${extraProject.id}@${extraProject.version}`,
        },
      },
    },
    ...[extraProject.version, projectHistory.version].map((version) => ({
      kind: "taskCore",
      from: {
        component: "databases",
        export: `${extraProject.id}@${version}`,
      },
      to: { scope: "platform", bundle: basePin, export: taskCoreExport.id },
    })),
    {
      kind: "artwork",
      from: {
        component: "assistants",
        export: `${extraPackage.id}@${extraPackage.version}`,
        key: artworkGroupKey,
      },
      to: {
        scope: "local",
        reference: { component: "project-preview", export: "project-preview" },
      },
    },
    {
      kind: "documentSource",
      from: {
        component: "assistants",
        export: `${extraPackage.id}@${extraPackage.version}`,
        key: artworkGroupKey,
      },
      to: {
        scope: "platform",
        bundle: basePin,
        export: linkedDocumentExport.id,
      },
    },
  ],
  exports: [
    {
      id: "project-preview",
      source: { component: "project-preview", export: "project-preview" },
    },
    ...definitions.map((definition) => ({
      id: definition.id,
      source: {
        component: "databases",
        export: `${definition.id}@${definition.version}`,
      },
    })),
    {
      id: extraPackage.id,
      source: {
        component: "assistants",
        export: `${extraPackage.id}@${extraPackage.version}`,
      },
      contexts: extraPackage.contexts,
    },
    {
      id: "fixture.document",
      source: {
        component: "document",
        export: `${documentManifest.template_id}@${documentManifest.version}`,
      },
      document: { newWorkspaceDefault: false },
    },
  ],
};
writeFileSync(
  join(fixtureSource, "manifest.yaml"),
  YAML.stringify(featureSource),
);
nativeCli(
  "templates",
  "feature-bundle",
  "pack",
  "--root",
  "/fixture/feature-fixture/source",
  "--manifest",
  "manifest.yaml",
  "--output",
  "/fixture/feature-fixture/packed",
  "--platform",
  `/fixture/templates/${baseRelative}`,
);
const optionalBytes = readFileSync(
  join(root, "feature-fixture/packed", featureSource.id, "1.0.0.myoxus.zip"),
);
const optionalPin = {
  id: featureSource.id,
  version: featureSource.version,
  sha256: createHash("sha256").update(optionalBytes).digest("hex"),
};
const optionalRelative = `features/${optionalPin.id}/${optionalPin.version}.myoxus.zip`;
const optionalPath = join(root, "templates", optionalRelative);
mkdirSync(join(root, "templates/features", optionalPin.id), {
  recursive: true,
});
writeFileSync(optionalPath, optionalBytes);
catalog.optional.push(optionalPin);
docker("stop", "-t", "30", api);
writeFileSync(catalogPath, YAML.stringify(catalog));
nativeSourceSet();
// File admission/publication and native child registration have different commit
// boundaries. Fail only this new optional revision after a valid pointer is active.
const registrationCatalog = readFileSync(catalogPath);
const registrationDocuments = documentStates();
const registrationDefaultsQuery =
  "SELECT to_jsonb(p) FROM template_default_policies p ORDER BY template_id";
const registrationDefaults = sql(registrationDefaultsQuery);
const registrationContentQuery = `SELECT jsonb_build_object(
  'workspaces',(SELECT jsonb_agg(to_jsonb(w) ORDER BY id) FROM workspaces w),
  'databases',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM workspace_databases d),
  'rows',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM workspace_database_rows r),
  'cells',(SELECT jsonb_agg(to_jsonb(c) ORDER BY row_id,field_id) FROM workspace_database_cell_values c),
  'docs',(SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM docs d),
  'snapshots',(SELECT jsonb_agg(jsonb_build_array(workspace_id,doc_id,last_sequence,md5(payload)) ORDER BY workspace_id,doc_id) FROM doc_snapshots),
  'updates',(SELECT jsonb_agg(jsonb_build_array(id,workspace_id,doc_id,sequence,md5(payload)) ORDER BY id) FROM doc_updates),
  'instances',(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM workspace_template_instances i));`;
const registrationContent = sql(registrationContentQuery);
const registrationPdf = pdfBundles();
const childIdentity = documentManifest.template_id;
assert.equal(
  sql(
    `SELECT count(*) FROM template_revisions r JOIN template_catalog_entries e ON e.id=r.template_id WHERE e.slug='${childIdentity}';`,
  ).trim(),
  "0",
  "fault targets a genuinely new optional child",
);
const registrationFault = `packaged_child_${randomUUID().replaceAll("-", "")}`;
const registrationMarker = `B05_CHILD_REGISTRATION_${registrationFault}`;
let stagedChildId;
try {
  sql(`CREATE FUNCTION ${registrationFault}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.version='${documentManifest.version}' AND EXISTS (
        SELECT 1 FROM template_catalog_entries e WHERE e.id=NEW.template_id AND e.slug='${childIdentity}'
      ) THEN RAISE EXCEPTION '${registrationMarker}'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER ${registrationFault} BEFORE INSERT ON template_revisions FOR EACH ROW EXECUTE FUNCTION ${registrationFault}();`);
  const since = new Date().toISOString();
  docker("start", api);
  for (let attempt = 0; attempt < 120; attempt++) {
    if (docker("inspect", "-f", "{{.State.Running}}", api).trim() === "false")
      break;
    assert(
      attempt < 119,
      "child registration fault did not stop startup within its existing bound",
    );
    await sleep();
  }
  assert.notEqual(
    docker("inspect", "-f", "{{.State.ExitCode}}", api).trim(),
    "0",
    "child registration failure must exit startup unsuccessfully",
  );
  const logs = spawnSync("docker", ["logs", "--since", since, api], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(logs.status, 0, "read child registration failure diagnostics");
  assert(
    (logs.stdout + logs.stderr).includes(registrationMarker),
    "startup must fail at the scoped new-child revision insert, not another owner",
  );
  assert.deepEqual(
    readFileSync(catalogPath),
    registrationCatalog,
    "native registration failure must retain the valid active file pointer",
  );
  assert.deepEqual(
    readFileSync(optionalPath),
    optionalBytes,
    "failed registration must leave immutable optional archive bytes reusable",
  );
  assert.equal(
    documentStates(),
    registrationDocuments,
    "failed child registration must not change existing native revisions or published selection",
  );
  assert.equal(
    sql(registrationDefaultsQuery),
    registrationDefaults,
    "failed child registration must not change default policies",
  );
  assert.equal(
    sql(registrationContentQuery),
    registrationContent,
    "failed child registration must not provision or alter workspace content",
  );
  assert.equal(
    pdfBundles(),
    registrationPdf,
    "failed document registration must not alter PDF assets",
  );
  stagedChildId = sql(
    `SELECT id FROM template_catalog_entries WHERE slug='${childIdentity}';`,
  ).trim();
} finally {
  sql(
    `DROP TRIGGER IF EXISTS ${registrationFault} ON template_revisions; DROP FUNCTION IF EXISTS ${registrationFault}();`,
  );
}
await startHealthy();
assert.deepEqual(
  readFileSync(catalogPath),
  registrationCatalog,
  "retry uses the same validated file selection",
);
assert.deepEqual(
  readFileSync(optionalPath),
  optionalBytes,
  "retry uses the same immutable archive",
);
assert.equal(
  sql(
    `SELECT count(*) FROM template_revisions r JOIN template_catalog_entries e ON e.id=r.template_id WHERE e.slug='${childIdentity}' AND r.version='${documentManifest.version}' AND r.state='published';`,
  ).trim(),
  "1",
  "retry registers the optional child exactly once",
);
if (stagedChildId)
  assert.equal(
    sql(
      `SELECT id FROM template_catalog_entries WHERE slug='${childIdentity}';`,
    ).trim(),
    stagedChildId,
    "retry reuses any staged native catalog identity",
  );
const ownerId = randomUUID(),
  sessionId = randomUUID();
sql(
  `INSERT INTO users(id,email,name,status,email_verified_at) VALUES ('${ownerId}','packaged-db-${ownerId}@example.test','Packaged Database owner','active',now()); INSERT INTO sessions(id,user_id,csrf_token,expires_at,refresh_after) VALUES ('${sessionId}','${ownerId}','packaged-fixture',now()+interval '2 hours',now()+interval '1 hour');`,
);
function gql(query, variables = {}) {
  const response = JSON.parse(
    curl(
      "-fsS",
      `${apiOrigin()}/graphql`,
      "-H",
      "Content-Type: application/json",
      "-H",
      `Cookie: affine_session=${sessionId}`,
      "-H",
      "x-csrf-token: packaged-fixture",
      "--data-binary",
      JSON.stringify({ query, variables }),
    ),
  );
  assert.equal(response.errors, undefined, JSON.stringify(response.errors));
  return response.data;
}
const workspaceId = gql("mutation { auth { createWorkspace { id } } }").auth
  .createWorkspace.id;
const list = () =>
  gql(
    "query($workspaceId:String!){workspace(id:$workspaceId){databaseStarterTemplates{id name}}}",
    { workspaceId },
  ).workspace.databaseStarterTemplates;
assert.equal(
  list().find((entry) => entry.id === source.id).name,
  marker,
  "startup must select the mounted catalog",
);
assert.equal(
  list().find((entry) => entry.id === originalSource.id).name,
  originalSource.variants[0].spec.name,
  "optional fixture cannot replace mandatory native source metadata",
);
assert.deepEqual(
  list()
    .slice(-3)
    .map((entry) => entry.id),
  [extraDatabaseId, source.id, extraProject.id],
  "optional native offering is appended after the required base",
);
const tenth = gql(
  "mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id title} managedSchema{readiness} fields{name} rowCount}}",
  {
    input: {
      workspaceId,
      templateId: extraDatabaseId,
      title: "Native tenth file-authored Database",
      includeSampleRows: false,
    },
  },
).createDatabaseFromTemplate;
assert.equal(tenth.database.title, "Native tenth file-authored Database");
assert.equal(tenth.managedSchema, null, "free Generic copies remain unbound");
assert.equal(tenth.fields.length, 1);
assert.equal(tenth.rowCount, 0);
// Exercise the retained full native variant matrix, not only the default plan.
const nativeEnum = (value) =>
  value.replace(/(^|_)([a-z])/g, (_, separator, letter) =>
    letter.toUpperCase(),
  );
for (const variant of extraProject.variants) {
  const actual = gql(
    "mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id} managedSchema{readiness templateId templateVersion variant{priority complexity structure}} views{name viewKind} rowCount}}",
    {
      input: {
        workspaceId,
        templateId: extraProject.id,
        title: "Packaged native variant",
        includeSampleRows: false,
        priorityPreset: nativeEnum(variant.priority),
        complexityPreset: nativeEnum(variant.complexity),
        structurePreset: nativeEnum(variant.structure),
      },
    },
  ).createDatabaseFromTemplate;
  assert.equal(actual.managedSchema.readiness, "Ready");
  assert.equal(actual.managedSchema.templateId, extraProject.id);
  assert.equal(actual.managedSchema.templateVersion, extraProject.version);
  assert.deepEqual(actual.managedSchema.variant, {
    priority: nativeEnum(variant.priority),
    complexity: nativeEnum(variant.complexity),
    structure: nativeEnum(variant.structure),
  });
  assert.deepEqual(
    actual.views.map((view) => ({ name: view.name, kind: view.viewKind })),
    variant.spec.views.map((view) => ({
      name: view.name,
      kind: nativeEnum(view.kind),
    })),
  );
  assert.equal(
    actual.rowCount,
    0,
    "variant creation never adds implicit sample content",
  );
}

// Changing the mounted bytes after startup cannot change list or creation.
writeFileSync(optionalPath, "invalid archive bytes after capture");
let installed;
try {
  assert.equal(list().find((entry) => entry.id === source.id).name, marker);
  installed = gql(
    "mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id title} fields{name} rowCount}}",
    {
      input: {
        workspaceId,
        templateId: source.id,
        title: "Packaged source instance",
        includeSampleRows: true,
      },
    },
  ).createDatabaseFromTemplate;
  assert.equal(
    installed.fields[0].name,
    fieldMarker,
    "creation must consume the same captured source as listing",
  );
  assert(installed.rowCount > 0, "starter samples must be persisted");
} finally {
  writeFileSync(optionalPath, optionalBytes);
}
// Exercise the actual generated-client documents through production admission.
// A reduced hand-written query misses complexity failures in nested descriptors.
const clientOperations = separateOperations(
  parse(
    readFileSync(
      new URL(
        "../../../client/libs/graphql/src/graphql/database.gql",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const clientPackages = gql(print(clientOperations.assistantPackages), {
  workspaceId,
  context: "ProjectCreation",
}).workspace.assistantPackages;
assert(clientPackages.some((entry) => entry.identity.id === extraPackage.id));
assert.deepEqual(
  clientPackages.find((entry) => entry.identity.id === extraPackage.id)
    .documentComponents,
  documentBindings.map((binding) => binding.descriptor),
  "cloned native document actions preserve their exact platform source closure",
);
const linkedSources = () =>
  gql(
    "query($workspaceId:String!){workspace(id:$workspaceId){assistantPackages(context:ProjectCreation){identity{id} documentSources{step group templateId version digest}}}}",
    { workspaceId },
  ).workspace.assistantPackages.find(
    (entry) => entry.identity.id === extraPackage.id,
  ).documentSources;
const expectedLinkedSources = [
  {
    step: artworkStep.id,
    group: artworkGroup.id,
    templateId: linkedDocumentComponent.nativeIdentity.id,
    version: linkedDocumentComponent.nativeIdentity.version,
    digest: linkedDocumentComponent.sha256,
  },
];
assert.deepEqual(
  linkedSources(),
  expectedLinkedSources,
  "manual Library association preserves the exact platform Document pin and native group",
);

const packageIdentities = new Set(
  clientPackages.map(
    (entry) => `${entry.identity.id}@${entry.identity.version}`,
  ),
);
const optionalArchive = await readZip(optionalBytes);
const optionalManifest = YAML.parse(
  archiveText(optionalArchive, "manifest.yaml"),
);
assert.equal(
  archiveText(optionalArchive, `databases/${projectUpdatePath}`),
  projectUpdateBytes,
  "native delivery preserves the exact pinned Update bytes",
);
assert.equal(
  archiveText(optionalArchive, `databases/${projectHistoryPath}`),
  projectHistoryBytes,
  "the native source endpoint is retained byte-for-byte",
);
assert.equal(
  optionalManifest.files[`databases/${projectUpdatePath}`],
  projectCatalogEntry.updates[0].sha256,
  "the delivery inventory contains the native Update pin",
);
assert(
  !optionalArchive.has(`databases/${extraProject.task_core.path}`),
  "external archive must not copy the pinned platform Task core",
);
const capturedProject = YAML.parse(
  archiveText(
    optionalArchive,
    `databases/${extraProject.id}/${extraProject.version}.yaml`,
  ),
);
assert.deepEqual(
  capturedProject,
  extraProject,
  "packing preserves all external Project variants and native Views",
);
const expectedArtwork = [
  ...baseManifest.links,
  ...optionalManifest.links,
].filter(
  (link) => link.kind === "artwork" && packageIdentities.has(link.from.export),
);
const artworks = clientPackages.flatMap((entry) => entry.artwork);
const externalArtwork = clientPackages.find(
  (entry) => entry.identity.id === extraPackage.id,
).artwork;
assert.equal(externalArtwork.length, 1);
assert.deepEqual(
  {
    step: externalArtwork[0].step,
    group: externalArtwork[0].group,
    alternative: externalArtwork[0].alternative,
    caption: externalArtwork[0].caption,
  },
  {
    step: artworkStep.id,
    group: artworkGroup.id,
    alternative: extraArtworkMetadata.alternative,
    caption: extraArtworkMetadata.caption,
  },
  "external preview is resolved through its actual native group with all authored locales",
);

assert.equal(
  artworks.length,
  expectedArtwork.length,
  "actual descriptor projection must consume every admitted Project artwork slot",
);
for (const artwork of artworks) {
  assert.match(artwork.url, /^\/api\/templates\/features\//);
  const componentId = artwork.url.split("/").at(-1);
  const external = artwork.url.includes(
    `/${optionalPin.id}/${optionalPin.version}/${optionalPin.sha256}/`,
  );
  const component = (
    external ? optionalManifest : baseManifest
  ).components.find(
    (component) => component.kind === "artwork" && component.id === componentId,
  );
  assert(
    component,
    "descriptor artwork identifies an actual native archive component",
  );
  const originalBytes = archiveBytes(
    external ? optionalArchive : baseArchive,
    component.path,
  );
  assert.equal(
    createHash("sha256").update(originalBytes).digest("hex"),
    artwork.digest,
  );
  assert.equal(artwork.width, component.artwork.width);
  assert.equal(artwork.height, component.artwork.height);
  // Artwork includes binary WebP beyond execFileSync's default stdout limit.
  const response = await fetch(`${apiOrigin()}${artwork.url}`, {
    headers: { Cookie: `affine_session=${sessionId}` },
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type")?.split(";")[0].trim(),
    component.artwork.mediaType,
  );
  assert.match(response.headers.get("cache-control"), /private, no-cache/i);
  assert.match(response.headers.get("vary"), /Cookie/i);
  assert.equal(response.headers.get("etag"), `"${artwork.digest}"`);
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()),
    originalBytes,
    "asset handler serves byte-exact captured artwork",
  );
  const status = (authenticated) =>
    curl(
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      `${apiOrigin()}${artwork.url}`,
      "-H",
      `If-None-Match: "${artwork.digest}"`,
      ...(authenticated ? ["-H", `Cookie: affine_session=${sessionId}`] : []),
    );
  assert.equal(
    status(true),
    "304",
    "authorized native conditional request revalidates its pin",
  );
  assert.equal(
    status(false),
    "401",
    "conditional asset requests cannot bypass current session authorization",
  );
}
const homePresentation = gql(print(clientOperations.assistantPresentation), {
  workspaceId,
  context: "TaskHome",
}).workspace.assistantPresentation;
assert(
  homePresentation.descriptor,
  "the actual Home consumer receives a descriptor",
);
assert.equal(homePresentation.unavailableReason, null);
const packages = () =>
  gql(
    "query($workspaceId:String!){workspace(id:$workspaceId){assistantPackages(context:ProjectCreation){identity{id version digest} name{en}}}}",
    { workspaceId },
  ).workspace.assistantPackages;
const extraDescriptor = packages().find(
  (value) => value.identity.id === extraPackage.id,
);
assert(
  extraDescriptor,
  "packaged mounted extra package must be exposed without code edits",
);
assert.equal(extraDescriptor.name.en, extraPackage.name.en);
const answers = {
  name: { kind: "text", value: "Packaged configured Project" },
  overview: {
    kind: "text",
    value: "Native confirmation from a delivered file",
  },
  samples: { kind: "boolean", value: false },
};
const countBeforePackage = sql(
  `SELECT count(*) FROM workspace_databases WHERE workspace_id='${workspaceId}';`,
);
const prepared = gql(print(clientOperations.prepareProjectAssistant), {
  workspaceId,
  input: { identity: extraDescriptor.identity, answers },
}).workspace.prepareProjectAssistant;
assert.equal(
  sql(
    `SELECT count(*) FROM workspace_databases WHERE workspace_id='${workspaceId}';`,
  ),
  countBeforePackage,
  "package preparation must not write",
);
assert.equal(prepared.includeSampleRows, false);
assert.equal(prepared.counts.sampleRows, 0);
assert.equal(prepared.executionAvailable, true);
assert.equal(prepared.folder, null, "unselected documents require no folder");
assert.deepEqual(prepared.documents, [], "document creation remains explicit");
assert.equal(
  prepared.templateId,
  extraProject.id,
  "external native action prepares its own managed schema",
);
const confirmationInput = {
  workspaceId,
  templateId: prepared.templateId,
  title: prepared.title,
  description: prepared.description,
  includeSampleRows: prepared.includeSampleRows,
  priorityPreset: prepared.priority,
  complexityPreset: prepared.complexity,
  structurePreset: prepared.structure,
  assistantConfirmation: {
    requestId: randomUUID(),
    locale: prepared.locale,
    clientVersion: prepared.clientVersion,
    identity: extraDescriptor.identity,
    answers,
    planDigest: prepared.planDigest,
  },
};
const readConfiguredSetup = () =>
  gql(
    "query($workspaceId:String!,$requestId:ID!){workspace(id:$workspaceId){projectSetup(requestId:$requestId){requestId status reservedDatabaseId folderId placementComplete documents{componentId externalId created placed}}}}",
    {
      workspaceId,
      requestId: confirmationInput.assistantConfirmation.requestId,
    },
  ).workspace.projectSetup;
for (const inconsistent of [
  { description: "Conflicting native description" },
  { includeSampleRows: true },
  {
    priorityPreset:
      prepared.priority === "ThreeStep" ? "FiveStep" : "ThreeStep",
  },
  {
    complexityPreset:
      prepared.complexity === "ThreeStep" ? "FiveStep" : "ThreeStep",
  },
  {
    structurePreset:
      prepared.structure === "TasksOnly" ? "Phases" : "TasksOnly",
  },
]) {
  assert.throws(
    () =>
      gql(
        "mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id}}}",
        { input: { ...confirmationInput, ...inconsistent } },
      ),
    /MIX_DATABASE_QUERY_INVALID/,
    "conflicting native arguments must fail before the package writer",
  );
  assert.equal(
    sql(
      `SELECT count(*) FROM workspace_databases WHERE workspace_id='${workspaceId}';`,
    ),
    countBeforePackage,
    "contradictory confirmation must allocate no content",
  );
  assert.equal(
    readConfiguredSetup(),
    null,
    "contradictory native arguments must not accept the reviewed request",
  );
}

// Discovery/preparation remain the captured immutable snapshot after mount edits.
writeFileSync(optionalPath, "invalid archive bytes after capture");
let configured;
try {
  assert(packages().some((value) => value.identity.id === extraPackage.id));
  assert.deepEqual(
    linkedSources(),
    expectedLinkedSources,
    "mount edits cannot reinterpret an admitted manual Document association",
  );
  configured = gql(
    "mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id title} initialViewId rowCount}}",
    {
      input: confirmationInput,
    },
  ).createDatabaseFromTemplate;
  assert.equal(configured.database.title, prepared.title);
  assert.equal(
    sql(
      `SELECT managed_installation->>'templateId' FROM workspace_databases WHERE id='${configured.database.id}';`,
    ).trim(),
    extraProject.id,
    "confirmation installs the external Project identity",
  );
  assert.equal(
    configured.rowCount,
    prepared.counts.phases +
      prepared.counts.milestones +
      prepared.counts.explicitTasks,
    "sample opt-out preserves only the explicitly reviewed native setup rows",
  );
  for (const [kind, expected] of [
    ["phase", prepared.counts.phases],
    ["milestone", prepared.counts.milestones],
    ["task", prepared.counts.explicitTasks],
  ]) {
    assert.equal(
      sql(
        `SELECT count(*) FROM workspace_database_rows WHERE database_id='${configured.database.id}' AND row_kind='${kind}';`,
      ).trim(),
      String(expected),
      `the native receipt publishes exactly the reviewed ${kind} rows`,
    );
  }
  assert(configured.initialViewId, "native chosen View must be acknowledged");
  assert.equal(
    sql(
      `SELECT count(*) FROM workspace_database_views WHERE id='${configured.initialViewId}' AND database_id='${configured.database.id}';`,
    ).trim(),
    "1",
  );
  assert.deepEqual(readConfiguredSetup(), {
    requestId: confirmationInput.assistantConfirmation.requestId,
    status: "Ready",
    reservedDatabaseId: configured.database.id,
    folderId: null,
    placementComplete: true,
    documents: [],
  });
  const replayed = gql(
    "mutation($input:CreateDatabaseFromTemplateInput!){createDatabaseFromTemplate(input:$input){database{id title} initialViewId rowCount}}",
    { input: confirmationInput },
  ).createDatabaseFromTemplate;
  assert.deepEqual(
    replayed,
    configured,
    "same accepted request reuses the native Project, View and scaffold",
  );
  assert.equal(
    Number(
      sql(
        `SELECT count(*) FROM workspace_databases WHERE workspace_id='${workspaceId}';`,
      ).trim(),
    ),
    Number(countBeforePackage.trim()) + 1,
    "accepted replay must not allocate another Project",
  );
} finally {
  writeFileSync(optionalPath, optionalBytes);
}
const databaseId = installed.database.id;
const installedState = () =>
  sql(
    `SELECT jsonb_build_object('root',(SELECT to_jsonb(d) FROM workspace_databases d WHERE id='${databaseId}'),'fields',(SELECT jsonb_agg(to_jsonb(f) ORDER BY position) FROM workspace_database_fields f WHERE database_id='${databaseId}'),'views',(SELECT jsonb_agg(to_jsonb(v) ORDER BY position) FROM workspace_database_views v WHERE database_id='${databaseId}'),'rows',(SELECT jsonb_agg(to_jsonb(r) ORDER BY position) FROM workspace_database_rows r WHERE database_id='${databaseId}'),'cells',(SELECT jsonb_agg(to_jsonb(c) ORDER BY row_id,field_id) FROM workspace_database_cell_values c WHERE database_id='${databaseId}'),'row_templates',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM workspace_database_row_templates t WHERE database_id='${databaseId}'),'profile',(SELECT to_jsonb(p) FROM database_profiles p WHERE database_id='${databaseId}'));`,
  );
const beforeDocuments = documentStates();
const registeredDocumentIdentities = beforeDocuments
  .trim()
  .split("\n")
  .map((line) => line.split("|").slice(0, 2).join("@"));
for (const component of baseManifest.components.filter(
  (component) => component.kind === "documentTemplate",
)) {
  const identity = `${component.nativeIdentity.id}@${component.nativeIdentity.version}`;
  assert.equal(
    registeredDocumentIdentities.filter((registered) => registered === identity)
      .length,
    1,
    `actual release native Document must be registered exactly once: ${identity}`,
  );
}
assert.equal(
  registeredDocumentIdentities.filter(
    (identity) =>
      identity ===
      `${documentManifest.template_id}@${documentManifest.version}`,
  ).length,
  1,
);
const beforeInstalled = installedState();
async function rejected(relative, change, reason) {
  docker("stop", "-t", "30", api);
  const file = join(root, "templates", relative);
  const original = readFileSync(file);
  const originalCatalog = readFileSync(catalogPath);
  const since = new Date().toISOString();
  try {
    await change(file, original);
    docker("start", api);
    for (let attempt = 0; attempt < 120; attempt++) {
      if (docker("inspect", "-f", "{{.State.Running}}", api).trim() === "false")
        break;
      assert(
        attempt < 119,
        `invalid ${relative} did not fail before activation`,
      );
      await sleep();
    }
    const result = spawnSync("docker", ["logs", "--since", since, api], {
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, "could not read loader diagnostics");
    const logs = (result.stdout + result.stderr).replaceAll("/./", "/");
    const [owner, ...parts] = relative.split("/");
    if (owner === "features") {
      assert.match(
        logs,
        /Feature|feature/,
        "failure must identify the Feature owner",
      );
    } else {
      assert(
        (owner === "html"
          ? logs.includes("HTML template catalog:")
          : logs.includes(`/opt/myoxus/templates/${owner}`)) &&
          logs.includes(parts.join("/")),
        `failure must identify the owning root and ${relative}`,
      );
    }
    assert.match(logs, reason);
    assert.equal(
      installedState(),
      beforeInstalled,
      `failed ${relative} changed installed Database data`,
    );
    assert.equal(
      revisions(),
      before,
      `failed ${relative} changed published content`,
    );
    assert.equal(
      documentStates(),
      beforeDocuments,
      `failed ${relative} changed immutable Document revisions`,
    );
    assert.equal(
      pdfBundles(),
      beforePdf,
      `failed ${relative} changed stored PDF bundles`,
    );
  } finally {
    // Restore exact fixture bytes; a failed assertion must not leave the owned
    // API running against a mutated input during test-build.sh cleanup.
    if (docker("inspect", "-f", "{{.State.Running}}", api).trim() === "true")
      docker("stop", "-t", "30", api);
    rmSync(file, { force: true });
    writeFileSync(file, original);
    writeFileSync(catalogPath, originalCatalog);
  }
}
// Mandatory base selection is independently pinned by the actual image.
// Loose source files cannot rescue a missing/corrupt required archive.
for (const relative of Object.keys(baseManifest.files).filter((path) =>
  /^(databases|assistants|documents)\//.test(path),
)) {
  const target = join(root, "templates", relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, archiveBytes(baseArchive, relative));
}
await rejected(
  baseRelative,
  (file) => unlinkSync(file),
  /No such file|not found/i,
);
await rejected(
  baseRelative,
  (file) => writeFileSync(file, "invalid archive bytes"),
  /SHA-256 mismatch/,
);
await rejected(
  baseRelative,
  (file) => {
    unlinkSync(file);
    symlinkSync("/opt/myoxus/config/default.yaml", file);
  },
  /path escapes root|symlink/,
);
// A complete alternate base is valid under an explicit source-development
// expectation, but cannot replace the image's independent packaged base.
const forged = await readZip(baseBytes);
const forgedManifest = structuredClone(baseManifest);
forgedManifest.id = "example.forged.base";
forged.set("manifest.yaml", {
  data: Buffer.from(YAML.stringify(forgedManifest)),
  directory: false,
});
const forgedBytes = await writeZip(forged);
const forgedPin = {
  id: forgedManifest.id,
  version: forgedManifest.version,
  sha256: createHash("sha256").update(forgedBytes).digest("hex"),
};
const forgedRoot = join(root, "feature-fixture/forged");
const forgedRelative = `features/${forgedPin.id}/${forgedPin.version}.myoxus.zip`;
mkdirSync(dirname(join(forgedRoot, forgedRelative)), { recursive: true });
writeFileSync(join(forgedRoot, forgedRelative), forgedBytes);
const forgedCatalog = {
  formatVersion: 1,
  base: forgedPin,
  optional: [],
  retained: [],
};
writeFileSync(
  join(forgedRoot, "features/catalog.yaml"),
  YAML.stringify(forgedCatalog),
);
writeFileSync(
  join(forgedRoot, "release.yaml"),
  YAML.stringify({ formatVersion: 1, base: forgedPin }),
);
nativeCli(
  "templates",
  "validate-source-set",
  "--root",
  "/fixture/feature-fixture/forged",
  "--release-manifest",
  "/fixture/feature-fixture/forged/release.yaml",
);
mkdirSync(dirname(join(root, "templates", forgedRelative)), {
  recursive: true,
});
writeFileSync(join(root, "templates", forgedRelative), forgedBytes);
await rejected(
  "features/catalog.yaml",
  (file) => writeFileSync(file, YAML.stringify(forgedCatalog)),
  /invalid Feature release selection|exact.*base|base.*pin/i,
);
rmSync(join(root, "templates/features", forgedPin.id), { recursive: true });
await rejected(
  "features/catalog.yaml",
  (file) => {
    const changed = structuredClone(catalog);
    changed.base = optionalPin;
    writeFileSync(file, YAML.stringify(changed));
  },
  /invalid Feature release selection|exact.*base|base.*pin/i,
);
await rejected(
  "features/catalog.yaml",
  (file) => {
    const changed = structuredClone(catalog);
    changed.base.sha256 = "0".repeat(64);
    writeFileSync(file, YAML.stringify(changed));
  },
  /invalid Feature release selection|exact.*base|base.*pin/i,
);
for (const family of ["databases", "assistants", "documents"]) {
  rmSync(join(root, "templates", family), { recursive: true });
}
await rejected(
  optionalRelative,
  (file) => unlinkSync(file),
  /No such file|not found/i,
);
await rejected(
  optionalRelative,
  (file) => writeFileSync(file, "invalid immutable package"),
  /SHA-256 mismatch/,
);
await rejected(
  optionalRelative,
  (file) => {
    unlinkSync(file);
    symlinkSync("/opt/myoxus/config/default.yaml", file);
  },
  /path escapes root|symlink/,
);

// Only failing optional fixture candidates are repinned, so inner archive/native
// admission is exercised without changing the artifact-owned mandatory base.
async function changeOptional(file, change) {
  const archive = await readZip(optionalBytes);
  const manifest = YAML.parse(archiveText(archive, "manifest.yaml"));
  await change(archive, manifest);
  archive.set("manifest.yaml", {
    data: Buffer.from(YAML.stringify(manifest)),
    directory: false,
  });
  const bytes = await writeZip(archive);
  writeFileSync(file, bytes);
  const changed = structuredClone(catalog);
  changed.optional.find((pin) => pin.id === optionalPin.id).sha256 = createHash(
    "sha256",
  )
    .update(bytes)
    .digest("hex");
  writeFileSync(catalogPath, YAML.stringify(changed));
}
function replaceFile(archive, manifest, path, bytes) {
  // Native Feature inventories contain regular files only; replacement must
  // not manufacture directory entries that change which admission guard fails.
  archive.set(path, { data: Buffer.from(bytes), directory: false });
  const digest = createHash("sha256").update(bytes).digest("hex");
  manifest.files[path] = digest;
  const component = manifest.components.find(
    (component) => component.path === path,
  );
  if (component) component.sha256 = digest;
}
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive, manifest) => {
      const path = `databases/${projectUpdatePath}`;
      archive.delete(path);
      delete manifest.files[path];
    }),
  /updates\/.*declared native file missing/s,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive, manifest) => {
      // The outer archive is valid and repinned; only the native Update pin is
      // stale, so this proves the child decoder owns immutable source integrity.
      replaceFile(
        archive,
        manifest,
        `databases/${projectUpdatePath}`,
        `${projectUpdateBytes}\n`,
      );
    }),
  /Database template.*updates.*SHA-256 mismatch/s,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive) => {
      archive.delete(`databases/${entries[0].definitions[0].path}`);
    }),
  /inventory|undeclared|missing|unavailable/i,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive, manifest) => {
      const path = `databases/${entries[0].definitions[0].path}`;
      const bytes = "invalid native definition";
      replaceFile(archive, manifest, path, bytes);
      const nativeCatalog = structuredClone(sourceDatabaseCatalog);
      nativeCatalog.templates[0].definitions[0].sha256 = createHash("sha256")
        .update(bytes)
        .digest("hex");
      replaceFile(
        archive,
        manifest,
        "databases/catalog.yaml",
        YAML.stringify(nativeCatalog),
      );
    }),
  /Database template|invalid source schema/i,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive) => {
      archive.delete(`assistants/${extraPackageRelative}`);
    }),
  /inventory|undeclared|missing|unavailable/i,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive, manifest) => {
      const path = `assistants/${extraPackageRelative}`,
        bytes = "invalid native package";
      replaceFile(archive, manifest, path, bytes);
      const nativeCatalog = {
        ...assistantCatalog,
        packages: [
          {
            id: extraPackage.id,
            current: extraPackage.version,
            defaultFor: [],
            definitions: [
              {
                version: extraPackage.version,
                path: extraPackageRelative,
                sha256: createHash("sha256").update(bytes).digest("hex"),
              },
            ],
          },
        ],
      };
      replaceFile(
        archive,
        manifest,
        "assistants/catalog.yaml",
        YAML.stringify(nativeCatalog),
      );
    }),
  /assistant|invalid source schema/i,
);
await rejected(
  "mail/en/sign-in.html",
  (file) => unlinkSync(file),
  /Missing mail template/,
);
await rejected(
  "mail/en/sign-in.html",
  (file, bytes) =>
    writeFileSync(file, Buffer.concat([bytes, Buffer.from("{% if broken %}")])),
  /invalid Tera syntax/i,
);
await rejected(
  "mail/en/sign-in.html",
  (file) =>
    writeFileSync(
      file,
      "{% extends '_layout.html' %}{% block introduction %}{% include 'missing-required.html' %}{% endblock introduction %}",
    ),
  /missing required include missing-required.html/,
);
await rejected(
  "mail/assets/product-mark.png",
  (file) => {
    unlinkSync(file);
    symlinkSync("/opt/myoxus/config/default.yaml", file);
  },
  /escapes mail root/,
);
await rejected(
  optionalRelative,
  (file) => changeOptional(file, (archive) => archive.delete("document.zip")),
  /inventory|missing|unavailable/i,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, (archive, manifest) =>
      replaceFile(archive, manifest, "document.zip", "invalid ZIP bytes"),
    ),
  /ZIP_INVALID|invalid.*ZIP|invalid.*archive/i,
);
await rejected(
  optionalRelative,
  (file) =>
    changeOptional(file, async (archive, manifest) => {
      const differentSource = baseManifest.components.find(
        (component) =>
          component.kind === "documentTemplate" &&
          component.nativeIdentity.id === "meeting-focus",
      );
      const document = await readZip(
        archiveBytes(baseArchive, differentSource.path),
      );
      const native = JSON.parse(archiveText(document, "manifest.json"));
      native.template_id = documentManifest.template_id;
      native.version = documentManifest.version;
      document.set("manifest.json", {
        data: Buffer.from(JSON.stringify(native)),
        directory: false,
      });
      replaceFile(archive, manifest, "document.zip", await writeZip(document));
    }),
  /already exists with different content|immutable.*different|checksum.*mismatch/i,
);
await rejected(
  "pdf/presentation-navigator/main.typ",
  (file) => unlinkSync(file),
  /PDF input.*presentation-navigator\/main.typ.*No such file/i,
);
await rejected(
  "html/private_page.html.tera",
  (file) => unlinkSync(file),
  /required HTML catalog file unavailable: private_page.html.tera/,
);
await rejected(
  "html/rsvp_page.html.tera",
  (file, bytes) =>
    writeFileSync(
      file,
      Buffer.concat([
        bytes,
        Buffer.from(
          "{% if state == 'unavailable' %}{{ missing_delivery_context }}{% endif %}",
        ),
      ]),
    ),
  /HTML catalog render rsvp_page.html.tera/,
);
docker("start", api);
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    docker("exec", api, "myoxus-cli", "container", "health");
    break;
  } catch (error) {
    assert.equal(
      docker("inspect", "-f", "{{.State.Running}}", api).trim(),
      "true",
      "restored catalog exited",
    );
    if (attempt === 119) throw error;
    await sleep();
  }
}
assert.equal(
  revisions(),
  before,
  "restored startup changed immutable revisions",
);
assert.equal(
  pdfBundles(),
  beforePdf,
  "restored startup changed stored PDF bundles",
);
assert.equal(
  documentStates(),
  beforeDocuments,
  "repeated startup changed immutable Document revisions",
);
assert.equal(
  installedState(),
  beforeInstalled,
  "repeated startup changed installed Database data",
);
assert.equal(list().find((entry) => entry.id === source.id).name, marker);
assert.deepEqual(
  readFileSync(basePath),
  baseBytes,
  "healthy optional delivery never changes mandatory archive bytes",
);
nativeSourceSet();
sql(
  `DELETE FROM workspaces WHERE id='${workspaceId}'; DELETE FROM users WHERE id='${ownerId}';`,
);
console.log(
  "PASS packaged loaders reject missing, malformed, escaping and changed immutable inputs; stored content survives",
);
