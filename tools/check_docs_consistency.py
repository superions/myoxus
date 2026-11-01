#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]

MARKDOWN_ROOTS = [
    ROOT / "README.md",
    ROOT / "docs",
    ROOT / "server",
]

LINK_RE = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
SCHEME_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")
INTERNAL_REFERENCE_RE = re.compile(
    r"(?<![A-Za-z0-9_.-])(?:\.\./)*(?:todo|learnings)/"
    r"|\b(?:server|environment|webfrontend|adminfrontend|electron|editor)-done\.md\b"
)

BANNED_PATTERNS = [
    (re.compile(r"\bservers/rust\b"), "Use `server/` instead of `servers/rust`."),
    (re.compile(r"\bdocs/server\b"), "Use `docs/ops` instead of `docs/server`."),
    (re.compile(r"\bTODO-server\.md\b"), "Use `todo/server.md` instead of `TODO-server.md`."),
    (re.compile(r"\bTODO-adminfrontend\.md\b"), "Use `todo/adminfrontend.md` instead of `TODO-adminfrontend.md`."),
    (re.compile(r"\bTODO-webfrontend\.md\b"), "Use `todo/webfrontend.md` instead of `TODO-webfrontend.md`."),
    (re.compile(r"\bservers/adminfrontend\b"), "Use `client/admin` and `build/admin` paths instead of `servers/adminfrontend`."),
    (re.compile(r"\bservers/webfrontend\b"), "Use `client/web` and `build/web` paths instead of `servers/webfrontend`."),
    (re.compile(r"\bservers/style\b"), "Use `client/style` instead of `servers/style`."),
    (re.compile(r"\brefactor/"), "Use `docs/dev` structure instead of `refactor/` paths."),
    (
        re.compile(r"client/libs/core/src/modules/workspace-database"),
        "Use the active `client/libs/core/src/modules/database` path.",
    ),
    (
        re.compile(r"client/libs/core/src/modules/database/editor-surface"),
        "Use the decomposed Database view-host and concrete view module paths.",
    ),
]

BUSINESS_DOC_DIR = ROOT / "docs" / "dev" / "server"
BUSINESS_MATRIX = BUSINESS_DOC_DIR / "business-artifact-matrix.md"
DATABASE_API_DOC = BUSINESS_DOC_DIR / "databases-api.md"
DATABASE_MODEL_DOC = BUSINESS_DOC_DIR / "databases-data-model.md"
DATABASE_FIELD_DOC = BUSINESS_DOC_DIR / "databases-field-types.md"
DATABASE_VIEW_DOC = BUSINESS_DOC_DIR / "databases-views.md"
DATABASE_PROJECT_DOC = BUSINESS_DOC_DIR / "databases-projects.md"
DATABASE_IMPORT_DOC = BUSINESS_DOC_DIR / "databases-import-export.md"
DATABASE_GRAPHQL_FILES = [
    ROOT / "client" / "libs" / "graphql" / "src" / "graphql" / "database.gql",
    ROOT / "client" / "libs" / "graphql" / "src" / "graphql" / "workspace-tags.gql",
]
DATABASE_DOMAIN = ROOT / "server" / "crates" / "domain" / "src" / "database"
DATABASE_MIGRATIONS = ROOT / "server" / "crates" / "infrastructure" / "migrations"
ADMIN_CONFIG = ROOT / "client" / "admin" / "workspaces" / "admin" / "src" / "config.json"
EFFECTIVE_CONFIG_REGISTRY = (
    ROOT / "server" / "crates" / "contracts" / "src" / "effective_config.rs"
)
OPS_CONFIG_REFERENCE = ROOT / "docs" / "ops" / "configuration" / "reference.md"
DATABASE_OP_RE = re.compile(r"^(query|mutation)\s+(\w+)", re.MULTILINE)
CREATE_DATABASE_OBJECT_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z][a-z0-9_]*)",
    re.IGNORECASE,
)
DATABASE_IMPORT_DIAGNOSTIC_RE = re.compile(
    r"\bMIX_DATABASE_(?:CSV|JSON|NOTION)[A-Z0-9_]*[A-Z0-9]\b"
)


def check_source_readmes(root: Path = ROOT) -> list[str]:
    """Inspect owned files, not installed dependencies; also work in source archives."""
    roots = ("server", "client", "virgultum")
    if (root / ".git").exists():
        result = subprocess.run(
            ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", *roots],
            cwd=root, check=True, capture_output=True, text=True,
        )
        paths = [Path(name) for name in result.stdout.split("\0") if name]
    else:
        paths = []
        for source in roots:
            for directory, dirs, names in os.walk(root / source):
                dirs[:] = [name for name in dirs if name not in {"node_modules", ".git", "target"}]
                paths.extend((Path(directory) / name).relative_to(root) for name in names)
    return [
        f"[source-readme] {path.as_posix()}: move standalone documentation to docs/dev/ or docs/ops/"
        for path in sorted(set(paths))
        if re.match(r"^readme(?:$|[._-])", path.name, re.IGNORECASE)
        and (root / path).is_file()
    ]


def check_source_readme_self_tests() -> list[str]:
    issues = []
    with tempfile.TemporaryDirectory(prefix="myoxus-doc-placement-") as directory:
        root = Path(directory)
        for name in ("README.md", "docs/dev/README.md", "client/lib/LICENSE", "server/NOTICE.md"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("allowed\n")
        if check_source_readmes(root):
            issues.append("[self-test] legal notices or documentation indexes rejected")
        for name in ("server/README.md", "client/lib/readme.txt", "virgultum/lib/README.myoxus.md"):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("misplaced\n")
            if len(check_source_readmes(root)) != 1:
                issues.append(f"[self-test] source README not rejected: {name}")
            path.unlink()
        subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
        path = root / "client" / "README.md"
        path.write_text("untracked\n")
        if len(check_source_readmes(root)) != 1:
            issues.append("[self-test] untracked source README not rejected")
        subprocess.run(["git", "add", "client/README.md"], cwd=root, check=True)
        if len(check_source_readmes(root)) != 1:
            issues.append("[self-test] tracked source README not rejected")
        path.unlink()
        if check_source_readmes(root):
            issues.append("[self-test] removed source README still rejected")
    return issues


def gather_markdown_files() -> list[Path]:
    files: list[Path] = []
    for item in MARKDOWN_ROOTS:
        if item.is_file() and item.suffix == ".md":
            files.append(item)
            continue
        if item.is_dir():
            files.extend(sorted(item.rglob("*.md")))
    return files


def is_active_doc(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    parts = rel.parts
    if len(parts) >= 3 and parts[:3] == ("docs", "dev", "archive"):
        return False
    if len(parts) >= 2 and parts[:2] == ("server", "archive"):
        return False
    return True


def check_local_links(markdown_files: list[Path]) -> list[str]:
    issues: list[str] = []
    for md in markdown_files:
        text = md.read_text(encoding="utf-8", errors="ignore")
        for match in LINK_RE.finditer(text):
            target = match.group(1).strip()
            if not target or target.startswith("#"):
                continue
            if SCHEME_RE.match(target):
                continue
            target = target.split("#", 1)[0].split("?", 1)[0]
            if target.startswith("<") and target.endswith(">"):
                target = target[1:-1]
            candidate = (md.parent / target).resolve()
            if not candidate.exists():
                rel_md = md.relative_to(ROOT)
                issues.append(f"[broken-link] {rel_md}: {target}")
    return issues


def markdown_link_target(md: Path, raw_target: str) -> Path | None:
    target = raw_target.strip()
    if not target or target.startswith("#") or SCHEME_RE.match(target):
        return None
    target = target.split("#", 1)[0].split("?", 1)[0]
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    candidate = (md.parent / target).resolve()
    if candidate.is_dir():
        candidate = candidate / "README.md"
    return candidate


def check_internal_references(markdown_files: list[Path], root: Path = ROOT) -> list[str]:
    issues: list[str] = []
    for md in markdown_files:
        for lineno, line in enumerate(
            md.read_text(encoding="utf-8", errors="ignore").splitlines(), start=1
        ):
            if INTERNAL_REFERENCE_RE.search(line):
                issues.append(
                    f"[internal-reference] {md.relative_to(root)}:{lineno}: "
                    "public documentation must not reference internal planning paths or done archives"
                )
    return issues


def check_index_ownership(
    docs_root: Path,
    markdown_files: list[Path],
    root: Path = ROOT,
    excluded_prefixes: tuple[str, ...] = ("docs/dev/",),
) -> list[str]:
    """Require each exported document in its nearest ancestor README inventory.

    Links from other indexes are useful cross-navigation, but do not establish a
    second owner. This keeps ownership structural and independent of link labels.
    """
    indexes = {path.resolve(): path for path in markdown_files if path.name == "README.md"}
    issues: list[str] = []
    root_index = (docs_root / "README.md").resolve()
    # An index owns many documents. Resolve its inventory once per check, not
    # once per child; keep this local so later fixture/worktree edits are seen.
    inventories: dict[Path, set[Path]] = {}
    for md in markdown_files:
        resolved = md.resolve()
        rel = md.relative_to(root).as_posix()
        # The internal test index is not linked from the public root index.
        # Its descendants still require their normal nearest-index ownership.
        if resolved == root_index or rel == "docs/test/README.md" or any(rel.startswith(prefix) for prefix in excluded_prefixes):
            continue
        search_dir = md.parent.parent if md.name == "README.md" else md.parent
        owner: Path | None = None
        while search_dir.is_relative_to(docs_root):
            candidate = (search_dir / "README.md").resolve()
            if candidate in indexes and candidate != resolved:
                owner = indexes[candidate]
                break
            if search_dir == docs_root:
                break
            search_dir = search_dir.parent
        if owner is None:
            issues.append(
                f"[index-ownership] {rel}: no ancestor README owner exists"
            )
            continue
        if owner not in inventories:
            inventories[owner] = {
                target.resolve()
                for raw_target in LINK_RE.findall(owner.read_text(encoding="utf-8", errors="ignore"))
                if (target := markdown_link_target(owner, raw_target)) is not None
            }
        if resolved not in inventories[owner]:
            issues.append(
                f"[index-ownership] {rel}: missing from nearest owner {owner.relative_to(root)}"
            )
    return issues


def git_export_ignored(paths: set[Path], root: Path = ROOT) -> set[Path]:
    if not (root / ".git").exists():
        return set()
    relative_paths = sorted(path.relative_to(root).as_posix() for path in paths)
    if not relative_paths:
        return set()
    result = subprocess.run(
        ["git", "-C", str(root), "check-attr", "--stdin", "export-ignore"],
        input="\n".join(relative_paths) + "\n",
        text=True,
        capture_output=True,
        check=True,
    )
    ignored: set[Path] = set()
    for line in result.stdout.splitlines():
        path, _, value = line.partition(": export-ignore: ")
        if value == "set":
            ignored.add((root / path).resolve())
    return ignored


def check_export_safe_links(
    markdown_files: list[Path],
    root: Path = ROOT,
    ignored_paths: set[Path] | None = None,
) -> list[str]:
    # Retain the source spelling for diagnostics while sharing resolution
    # between the export-attribute query and the resulting link validation.
    links: dict[Path, list[tuple[str, Path]]] = {}
    for md in markdown_files:
        links[md] = [
            (raw_target, target.resolve())
            for raw_target in LINK_RE.findall(md.read_text(encoding="utf-8", errors="ignore"))
            if (target := markdown_link_target(md, raw_target)) is not None
            and target.exists()
        ]
    linked_targets = {target for targets in links.values() for _, target in targets}
    linked_targets.update(path.resolve() for path in markdown_files)
    ignored = (
        ignored_paths
        if ignored_paths is not None
        else git_export_ignored(linked_targets, root)
    )
    issues: list[str] = []
    for md in markdown_files:
        if md.resolve() in ignored:
            continue
        for raw_target, target in links[md]:
            if target in ignored:
                issues.append(
                    f"[export-broken-link] {md.relative_to(root)}: {raw_target.strip()} resolves only in the worktree"
                )
    return issues


def check_public_contract_self_tests() -> list[str]:
    """Exercise positive and negative documentation-governance fixtures."""
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="myoxus-docs-fixture-") as temporary:
        root = Path(temporary)
        docs = root / "docs"
        section = docs / "dev"
        section.mkdir(parents=True)
        (docs / "README.md").write_text(
            "# Docs\n\n- [Dev](./dev/README.md)\n", encoding="utf-8"
        )
        (section / "README.md").write_text(
            "# Dev\n\n- [Owned](./owned.md)\n", encoding="utf-8"
        )
        (section / "owned.md").write_text(
            "# Owned\n\nA product field may use the literal `todo` value.\n",
            encoding="utf-8",
        )
        files = sorted(docs.rglob("*.md"))
        if check_index_ownership(docs, files, root, excluded_prefixes=()):
            failures.append("[self-test] positive index-ownership fixture failed")
        if check_internal_references(files, root):
            failures.append("[self-test] literal todo positive fixture failed")

        index = section / "README.md"
        inventory = index.read_text(encoding="utf-8")
        index.write_text("# Dev\n", encoding="utf-8")
        if not check_index_ownership(docs, files, root, excluded_prefixes=()):
            failures.append("[self-test] changed owner inventory was not re-read")
        index.write_text(inventory, encoding="utf-8")
        if check_index_ownership(docs, files, root, excluded_prefixes=()):
            failures.append("[self-test] restored owner inventory was not re-read")

        unowned = docs / "unowned.md"
        unowned.write_text("# Unowned\n", encoding="utf-8")
        files = sorted(docs.rglob("*.md"))
        if not check_index_ownership(docs, files, root):
            failures.append("[self-test] missing index owner was not rejected")

        for name, value in [
            ("todo", "See `todo/server.md`.\n"),
            ("learnings", "See ../learnings/architecture.md.\n"),
            ("done", "See `server-done.md`.\n"),
        ]:
            fixture = section / f"internal-{name}.md"
            fixture.write_text(value, encoding="utf-8")
            if not check_internal_references([fixture], root):
                failures.append(f"[self-test] {name} internal reference was not rejected")

        internal = root / "todo" / "internal.md"
        internal.parent.mkdir()
        internal.write_text("internal\n", encoding="utf-8")
        exported = section / "exported.md"
        exported.write_text("[Internal](../../todo/internal.md)\n", encoding="utf-8")
        if not check_export_safe_links([exported], root, {internal.resolve()}):
            failures.append("[self-test] export-broken link was not rejected")
    return failures


def check_banned_patterns(markdown_files: list[Path]) -> list[str]:
    issues: list[str] = []
    for md in markdown_files:
        if not is_active_doc(md):
            continue
        rel_md = md.relative_to(ROOT)
        text = md.read_text(encoding="utf-8", errors="ignore")
        # Most files contain no deprecated path. Keep identical per-line
        # diagnostics, but do not retry every absent pattern on every line.
        patterns = [(pattern, hint) for pattern, hint in BANNED_PATTERNS if pattern.search(text)]
        if not patterns:
            continue
        lines = text.splitlines()
        for lineno, line in enumerate(lines, start=1):
            for pattern, hint in patterns:
                if pattern.search(line):
                    issues.append(
                        f"[deprecated-path] {rel_md}:{lineno}: {hint} (found: {line.strip()})"
                    )
    return issues


def check_business_artifact_coverage() -> list[str]:
    issues: list[str] = []

    if not BUSINESS_MATRIX.exists():
        issues.append(
            f"[business-matrix] Missing required matrix file: {BUSINESS_MATRIX.relative_to(ROOT)}"
        )
        return issues

    matrix_text = BUSINESS_MATRIX.read_text(encoding="utf-8", errors="ignore")

    business_docs = sorted(BUSINESS_DOC_DIR.glob("business-logic-*.md"))
    business_docs = [p for p in business_docs if p.name != "business-logic.md"]

    for doc in business_docs:
        expected_link = f"(./{doc.name})"
        if expected_link not in matrix_text:
            issues.append(
                "[business-matrix] "
                f"{BUSINESS_MATRIX.relative_to(ROOT)} does not reference {doc.name}"
            )

        header = "\n".join(
            doc.read_text(encoding="utf-8", errors="ignore").splitlines()[:15]
        )
        rel_doc = doc.relative_to(ROOT)
        if "_Last verified:" not in header:
            issues.append(
                f"[business-metadata] {rel_doc}: missing `_Last verified:` marker near file header"
            )
        if "Implemented in:" not in header:
            issues.append(
                f"[business-metadata] {rel_doc}: missing `Implemented in:` marker near file header"
            )

    return issues


def database_migration_files() -> list[Path]:
    return [
        path
        for path in sorted(DATABASE_MIGRATIONS.glob("*.sql"))
        if "database" in path.name
        or "workspace_tags" in path.name
        or "workspace_automations" in path.name
    ]


def rust_enum_variants(source: str, enum_name: str) -> list[str]:
    match = re.search(rf"pub enum {re.escape(enum_name)}\s*\{{(.*?)\n\}}", source, re.DOTALL)
    if not match:
        return []
    variants: list[str] = []
    for line in match.group(1).splitlines():
        variant = re.match(r"\s*([A-Z][A-Za-z0-9]*)\s*(?:,|\{|\()", line)
        if variant:
            variants.append(re.sub(r"(?<!^)(?=[A-Z])", "_", variant.group(1)).lower())
    return variants


def check_database_documentation_contract() -> list[str]:
    """Keep the shipped Database API/schema inventories tied to source."""
    issues: list[str] = []
    api_text = DATABASE_API_DOC.read_text(encoding="utf-8")
    model_text = DATABASE_MODEL_DOC.read_text(encoding="utf-8")

    for graphql_file in DATABASE_GRAPHQL_FILES:
        graphql_text = graphql_file.read_text(encoding="utf-8")
        for kind, operation in DATABASE_OP_RE.findall(graphql_text):
            generated = f"{operation}{'Query' if kind == 'query' else 'Mutation'}"
            if f"`{operation}`" not in api_text:
                issues.append(
                    f"[database-api] {DATABASE_API_DOC.relative_to(ROOT)} does not document "
                    f"{operation} from {graphql_file.relative_to(ROOT)}"
                )
            if f"`{generated}`" not in api_text:
                issues.append(
                    f"[database-codegen] {DATABASE_API_DOC.relative_to(ROOT)} does not name "
                    f"generated operation {generated}"
                )

    migration_files = database_migration_files()
    for migration in migration_files:
        if f"`{migration.name}`" not in model_text:
            issues.append(
                f"[database-migration] {DATABASE_MODEL_DOC.relative_to(ROOT)} does not inventory "
                f"{migration.name}"
            )

    created_objects = {
        name
        for migration in migration_files
        for name in CREATE_DATABASE_OBJECT_RE.findall(
            migration.read_text(encoding="utf-8", errors="ignore")
        )
    }
    for name in sorted(created_objects):
        if f"`{name}`" not in model_text:
            issues.append(
                f"[database-schema] {DATABASE_MODEL_DOC.relative_to(ROOT)} does not inventory {name}"
            )

    for enum_name, doc, owner in [
        ("DatabaseFieldType", DATABASE_FIELD_DOC, "definition/models.rs"),
        ("DatabaseViewKind", DATABASE_VIEW_DOC, "views/models.rs"),
        ("DatabaseProfileKind", DATABASE_PROJECT_DOC, "projects.rs"),
        ("DatabaseRowKind", DATABASE_PROJECT_DOC, "editing/models.rs"),
    ]:
        domain_path = DATABASE_DOMAIN / owner
        domain_text = domain_path.read_text(encoding="utf-8")
        doc_text = doc.read_text(encoding="utf-8")
        variants = rust_enum_variants(domain_text, enum_name)
        if not variants:
            issues.append(f"[database-domain] Could not parse {enum_name} from {domain_path.relative_to(ROOT)}")
        for variant in variants:
            if f"`{variant}`" not in doc_text:
                issues.append(
                    f"[database-domain] {doc.relative_to(ROOT)} does not document {enum_name}::{variant}"
                )

    field_doc_text = DATABASE_FIELD_DOC.read_text(encoding="utf-8")
    for nested_wire_field in [
        '"currencyCode"',
        '"minutes"',
        '"blobKey"',
        '"sequence"',
        '"start"',
    ]:
        if nested_wire_field not in field_doc_text:
            issues.append(
                f"[database-cell-wire] {DATABASE_FIELD_DOC.relative_to(ROOT)} does not document "
                f"canonical nested field {nested_wire_field}"
            )

    import_sources = list((DATABASE_DOMAIN.parent.parent.parent / "application" / "src" / "database").rglob("*.rs"))
    import_sources.append(ROOT / "server" / "crates" / "api" / "src" / "database_worker.rs")
    import_codes = {
        code
        for source in import_sources
        for code in DATABASE_IMPORT_DIAGNOSTIC_RE.findall(
            source.read_text(encoding="utf-8", errors="ignore")
        )
    }
    import_doc_text = DATABASE_IMPORT_DOC.read_text(encoding="utf-8")
    for code in sorted(import_codes):
        if f"`{code}`" not in import_doc_text:
            issues.append(
                f"[database-import-diagnostic] {DATABASE_IMPORT_DOC.relative_to(ROOT)} does not document {code}"
            )

    admin_config = json.loads(ADMIN_CONFIG.read_text(encoding="utf-8"))
    database_ops_dir = ROOT / "docs" / "ops" / "data" / "databases"
    database_ops_docs = sorted(database_ops_dir.glob("*.md"))
    ops_text = "\n".join(doc.read_text(encoding="utf-8") for doc in database_ops_docs)
    admin_keys = [f"databases.{key}" for key in admin_config.get("databases", {})]
    admin_keys.extend(["i18n.defaultCurrency", "job.queues.database"])
    for key in admin_keys:
        if f"`{key}`" not in ops_text:
            issues.append(
                f"[database-admin-config] docs/ops/data/databases does not inventory {key}"
            )

    return issues


def check_ops_config_registry_coverage() -> list[str]:
    """Keep the operator key reference aligned with the canonical registry."""
    source = EFFECTIVE_CONFIG_REGISTRY.read_text(encoding="utf-8")
    try:
        registry = source.split(
            "pub static CONFIG_REGISTRY: &[ConfigDescriptor] = &[", 1
        )[1].split("\n];", 1)[0]
    except IndexError:
        return [
            "[ops-config-registry] Could not locate CONFIG_REGISTRY in "
            f"{EFFECTIVE_CONFIG_REGISTRY.relative_to(ROOT)}"
        ]

    registered_paths = set(re.findall(r'path:\s*"([^"]+)"', registry))
    reference = OPS_CONFIG_REFERENCE.read_text(encoding="utf-8")
    return [
        "[ops-config-registry] "
        f"{OPS_CONFIG_REFERENCE.relative_to(ROOT)} does not inventory `{path}`"
        for path in sorted(registered_paths)
        if f"`{path}`" not in reference
    ]


def check_public_export(revision: str) -> list[str]:
    """Run this same checker inside the repository's real public archive."""
    if not (ROOT / ".git").exists():
        return ["[public-export] export verification requires a Git worktree"]
    with tempfile.TemporaryDirectory(prefix="myoxus-public-docs-") as temporary:
        temporary_root = Path(temporary)
        archive = temporary_root / "source.tar"
        extracted = temporary_root / "source"
        extracted.mkdir()
        export = subprocess.run(
            [
                str(ROOT / "build/scripts/release/export-public-source.sh"),
                "--revision",
                revision,
                "--output",
                str(archive),
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            env={**os.environ, "MYOXUS_EXPORT_PYTHON": sys.executable},
        )
        if export.returncode != 0:
            return [f"[public-export] exporter failed: {export.stderr.strip()}"]
        with tarfile.open(archive) as source:
            source.extractall(extracted, filter="data")
        check = subprocess.run(
            [
                sys.executable,
                str(extracted / "tools/check_docs_consistency.py"),
                "--public-archive",
            ],
            cwd=extracted,
            text=True,
            capture_output=True,
        )
        if check.returncode != 0:
            detail = check.stdout.strip() or check.stderr.strip()
            return [f"[public-export] extracted archive failed documentation checks:\n{detail}"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate Myoxus documentation contracts")
    parser.add_argument(
        "--self-test-only",
        action="store_true",
        help="run only the embedded positive and negative governance fixtures",
    )
    parser.add_argument(
        "--source-placement-only", action="store_true",
        help="check source README placement without other documentation contracts",
    )
    parser.add_argument(
        "--public-archive",
        action="store_true",
        help="validate an already extracted public archive without internal docs/dev contracts",
    )
    parser.add_argument(
        "--public-export-revision",
        metavar="REVISION",
        help="also export this exact Git revision and run the checker inside the archive",
    )
    args = parser.parse_args()

    if args.source_placement_only:
        issues = check_source_readme_self_tests() + check_source_readmes()
        for issue in issues:
            print(issue)
        if not issues:
            print("Source documentation placement check passed.")
        return 1 if issues else 0

    self_test_issues = check_public_contract_self_tests() + check_source_readme_self_tests()
    if args.self_test_only:
        if self_test_issues:
            print("Documentation checker self-test failed:")
            for issue in self_test_issues:
                print(f"- {issue}")
            return 1
        print("Documentation checker self-test passed.")
        return 0

    markdown_files = gather_markdown_files()
    docs_markdown_files = [
        path for path in markdown_files if path.is_relative_to(ROOT / "docs")
    ]

    issues: list[str] = list(self_test_issues)
    issues.extend(check_source_readmes())
    issues.extend(check_local_links(markdown_files))
    issues.extend(check_banned_patterns(markdown_files))
    issues.extend(check_internal_references(docs_markdown_files))
    issues.extend(
        check_index_ownership(ROOT / "docs", docs_markdown_files)
    )
    issues.extend(check_export_safe_links(docs_markdown_files))
    if not args.public_archive:
        issues.extend(check_business_artifact_coverage())
        issues.extend(check_database_documentation_contract())
    issues.extend(check_ops_config_registry_coverage())
    if args.public_export_revision:
        issues.extend(check_public_export(args.public_export_revision))

    if issues:
        print("Documentation consistency check failed:")
        for issue in issues:
            print(f"- {issue}")
        return 1

    print(
        "Documentation consistency check passed "
        f"({len(markdown_files)} markdown files checked)."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
