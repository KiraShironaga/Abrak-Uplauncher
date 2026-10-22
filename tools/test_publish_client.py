"""Small inert-fixture tests; no real client publication, execution or network."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("publisher", Path(__file__).with_name("publish-client.py"))
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="abrak-publish-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / ".abrak-local-project").write_text("owned fixture", encoding="utf-8")
        self.source = self.root / publisher.DEFAULT_SOURCE
        for relative in sorted(publisher.REQUIRED):
            target = self.source / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(("inert fixture " + relative).encode())
        self.asset = self.source / "resources/app/retroclient/data/échantillon test.bin"
        self.asset.parent.mkdir()
        self.asset.write_bytes(b"example v2 payload")

    def pointer(self):
        return self.root / "data/client-release.json"

    def test_plan_is_read_only_and_snapshot_is_verified_with_immutable_urls(self):
        private = self.source / "auth.json"
        private.write_text("synthetic-never-package", encoding="utf-8")
        before = self.asset.read_bytes()
        plan = publisher.plan(self.root, 2)
        self.assertFalse((self.root / "releases").exists())
        self.assertEqual(plan["files"], 4)
        self.assertIn("auth.json", plan["excluded"])
        result = publisher.publish(self.root, 2)
        self.assertFalse(result["activated"])
        self.assertFalse(self.pointer().exists())
        self.assertTrue(publisher.verify(self.root, 2)["zip_verified_against_manifest"])
        manifest = json.loads((self.root / "releases/snapshots/2/manifest.json").read_text(encoding="utf-8"))
        entry = manifest[self.asset.relative_to(self.source).as_posix()]
        self.assertIn("/local/releases/2/files/", entry["fileUrl"])
        self.assertTrue(entry["fileUrl"].endswith("%C3%A9chantillon%20test.bin"))
        self.assertEqual(self.asset.read_bytes(), before)
        self.assertEqual(private.read_text(), "synthetic-never-package")
        self.assertFalse((self.root / "releases/snapshots/2/files/auth.json").exists())

    def test_versions_are_monotonic_and_previous_snapshots_are_never_rewritten(self):
        publisher.publish(self.root, 2, activate_after=True, compression="stored")
        snapshot = self.root / "releases/snapshots/2"
        before = {str(p.relative_to(snapshot)): p.read_bytes() for p in snapshot.rglob("*") if p.is_file()}
        with self.assertRaises(publisher.ReleaseError):
            publisher.publish(self.root, 2)
        with self.assertRaises(publisher.ReleaseError):
            publisher.activate(self.root, 2)
        self.asset.write_bytes(b"new payload version3")
        result = publisher.publish(self.root, 3, activate_after=True)
        self.assertEqual(result["pointer"], {"version": 3, "manifestRelative": "releases/snapshots/3/manifest.json", "zipRelative": "releases/snapshots/3/client.zip", "rootRelative": "releases/snapshots/3/files"})
        self.assertEqual(json.loads(self.pointer().read_text())["version"], 3)
        self.assertEqual(before, {str(p.relative_to(snapshot)): p.read_bytes() for p in snapshot.rglob("*") if p.is_file()})

    def test_source_mutation_aborts_without_activation_or_partial_final_release(self):
        real_copy = publisher.copy_stable
        def mutate_after_copy(original, target, expected):
            result = real_copy(original, target, expected)
            if original == self.asset:
                original.write_bytes(b"changed during copy")
            return result
        with patch.object(publisher, "copy_stable", side_effect=mutate_after_copy):
            with self.assertRaises(publisher.ReleaseError):
                publisher.publish(self.root, 2, activate_after=True)
        self.assertFalse(self.pointer().exists())
        self.assertFalse((self.root / "releases/snapshots/2").exists())
        self.assertEqual(list((self.root / "releases/snapshots").glob(".building-*")), [])

    def test_tampered_snapshot_file_cannot_be_activated(self):
        publisher.publish(self.root, 2, activate_after=True)
        publisher.publish(self.root, 3)
        target = self.root / "releases/snapshots/3/files" / self.asset.relative_to(self.source)
        target.write_bytes(b"tampered snapshot")
        before = self.pointer().read_bytes()
        with self.assertRaises(publisher.ReleaseError):
            publisher.activate(self.root, 3)
        self.assertEqual(self.pointer().read_bytes(), before)

    def test_tampered_zip_is_rejected_even_when_snapshot_files_match(self):
        publisher.publish(self.root, 2)
        archive = self.root / "releases/snapshots/2/client.zip"
        with zipfile.ZipFile(archive, "a") as z:
            z.writestr("../untrusted.bin", b"inert")
        with self.assertRaises(publisher.ReleaseError):
            publisher.activate(self.root, 2)
        self.assertFalse(self.pointer().exists())

    def test_failed_atomic_pointer_replace_preserves_previous_active_release(self):
        publisher.publish(self.root, 2, activate_after=True)
        before = self.pointer().read_bytes()
        replace = os.replace
        def fail_pointer(source, target):
            if Path(target) == self.pointer():
                raise PermissionError("simulated pointer replace failure")
            return replace(source, target)
        with patch.object(publisher.os, "replace", side_effect=fail_pointer):
            with self.assertRaises(PermissionError):
                publisher.publish(self.root, 3, activate_after=True)
        self.assertEqual(self.pointer().read_bytes(), before)
        self.assertTrue(publisher.verify(self.root, 3)["zip_verified_against_manifest"])
        self.assertEqual(list((self.root / "data").glob(".client-release-*.tmp")), [])
        self.assertEqual(publisher.activate(self.root, 3)["pointer"]["version"], 3)

    def test_external_paths_and_invalid_versions_are_refused(self):
        for value in ["../x", "/x", "C:/client", "a:stream", "data/NUL.txt", "a/../b", "x\\y", "x."]:
            with self.assertRaises(publisher.ReleaseError):
                publisher.safe_relative(value)
        for version in [0, 1, -2, True]:
            with self.assertRaises(publisher.ReleaseError):
                publisher.plan(self.root, version)
        with self.assertRaises(publisher.ReleaseError):
            publisher.plan(self.root, 2, "desktop")

    def test_links_or_windows_junctions_are_refused(self):
        link = self.source / "linked-data"
        try:
            if os.name == "nt":
                environment = {**os.environ, "ABRAK_TEST_LINK": str(link), "ABRAK_TEST_TARGET": str(self.asset.parent)}
                result = subprocess.run(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop';New-Item -ItemType Junction -Path $env:ABRAK_TEST_LINK -Target $env:ABRAK_TEST_TARGET|Out-Null"], env=environment, capture_output=True, timeout=15)
                if result.returncode:
                    self.skipTest("OS did not allow creating the fixture junction")
            else:
                link.symlink_to(self.asset.parent, target_is_directory=True)
            with self.assertRaises(publisher.ReleaseError):
                publisher.publish(self.root, 2)
            self.assertEqual(self.asset.read_bytes(), b"example v2 payload")
        finally:
            if link.exists() or link.is_symlink():
                if os.name == "nt":
                    link.rmdir()
                else:
                    link.unlink()

    def test_lock_and_corrupt_pointer_fail_without_overwriting(self):
        folder = self.root / "releases/snapshots"
        folder.mkdir(parents=True)
        lock = folder / ".publish.lock"
        lock.write_text('{"id":"other","pid":99999}')
        with self.assertRaises(publisher.ReleaseError):
            publisher.publish(self.root, 2)
        self.assertEqual(json.loads(lock.read_text())["id"], "other")
        lock.unlink()
        self.pointer().parent.mkdir()
        self.pointer().write_text("[]")
        with self.assertRaises(publisher.ReleaseError):
            publisher.plan(self.root, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
