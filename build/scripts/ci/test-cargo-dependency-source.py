#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
from pathlib import Path
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("source_policy", Path(__file__).with_name("verify-cargo-dependency-source.py"))
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


class SourcePolicyTests(unittest.TestCase):
    def test_target_build_dev_and_renamed_consumers(self):
        manifest = {"dependencies": {"renamed": {"workspace": True}, "local": "1"},
                    "dev-dependencies": {"test": {"workspace": True}},
                    "target": {"cfg(windows)": {"build-dependencies": {"win": {"workspace": True}}}}}
        self.assertEqual(policy.inherited_names(manifest), {"renamed", "test", "win"})

    def test_security_fix_uses_resolved_version_and_excludes_unreachable_lock_metadata(self):
        graph = {"resolve": {"nodes": [{"id": "selected"}]}, "packages": [
            {"id": "selected", "name": "jwt", "version": "10.4.0", "source": "registry+crates.io"},
            {"id": "optional", "name": "jwt", "version": "9.3.1", "source": "registry+crates.io"}]}
        advisories = [{"id": "GHSA-test-test-test", "affected": [
            {"package": {"name": "jwt", "ecosystem": "crates.io"}}]}]
        with patch.object(policy, "metadata", return_value=graph), patch.object(policy, "osv") as osv:
            osv.return_value = {"results": [{}]}
            packages, findings = policy.verify_security_targets([Path("Cargo.toml")], advisories)
            self.assertEqual(packages, [("jwt", "10.4.0")])
            self.assertEqual(findings, [])
            self.assertEqual(osv.call_args.args[1]["queries"][0]["version"], "10.4.0")
            osv.return_value = {"results": [{"vulns": [{"id": "GHSA-test-test-test"}]}]}
            self.assertEqual(len(policy.verify_security_targets([Path("Cargo.toml")], advisories)[1]), 1)
            osv.return_value = {"results": []}
            with self.assertRaises(ValueError):
                policy.verify_security_targets([Path("Cargo.toml")], advisories)


if __name__ == "__main__":
    unittest.main()
