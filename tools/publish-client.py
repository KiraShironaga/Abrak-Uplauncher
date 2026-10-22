"""Publish a verified, versioned client snapshot inside this local project only."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from urllib.parse import quote
import uuid
import zipfile

ORIGIN = "http://127.0.0.1:4318"
DEFAULT_SOURCE = "client/Abrak/Retro"
REQUIRED = {"resources/app/retroclient/Abrak.exe", "resources/app/retroclient/loader.swf", "resources/app/retroclient/config.xml"}
CACHE_DIRS = {"cache", "gpucache", "code cache", "local storage", "session storage", "sessions", "indexeddb", "network", "logs", ".tmp", ".staging", ".git", "profile", "profile-local", "native-client"}
PRIVATE_NAMES = {"cookies", "cookies-journal", "login data", "login data-journal", "local state", "preferences", "secure preferences"}


class ReleaseError(ValueError):
    pass


def safe_relative(value):
    if not isinstance(value, str) or not value or "\\" in value or re.search(r'[:<>"|?*]', value) or any(ord(c) < 32 for c in value):
        raise ReleaseError("Invalid relative client path")
    parts = value.split("/")
    if any(not p or p in {".", ".."} or p.endswith((" ", ".")) or re.match(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", p, re.I) for p in parts):
        raise ReleaseError("Invalid relative client path")
    return value


def reject_link(path):
    details = path.lstat()
    if stat.S_ISLNK(details.st_mode) or getattr(details, "st_file_attributes", 0) & 0x400:
        raise ReleaseError(f"Links and reparse points are refused: {path.name}")
    return details


def owned(root, relative):
    result = root / safe_relative(relative)
    current = root
    for part in result.relative_to(root).parts:
        current = current / part
        try:
            reject_link(current)
        except FileNotFoundError:
            pass
    return result


def project_root(value):
    raw = Path(value).absolute()
    # Resolve the explicit project itself, then never follow links below it.
    root = raw.resolve(strict=True)
    if not owned(root, ".abrak-local-project").is_file():
        raise ReleaseError("Expected an AbrakLauncherLocal project marker")
    return root


def read_active(root):
    pointer = owned(root, "data/client-release.json")
    if not pointer.exists():
        return 1
    try:
        value = json.loads(pointer.read_text(encoding="utf-8-sig"))
    except (ValueError, OSError) as error:
        raise ReleaseError("Active release pointer is unreadable; refusing to guess a version") from error
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] < 1:
        raise ReleaseError("Invalid active release version")
    return value["version"]


def new_version(root, version):
    if type(version) is not int or version <= read_active(root):
        raise ReleaseError("New version must be an integer greater than the active version (builtin starts at 1)")


def fingerprint(details):
    return details.st_size, details.st_mtime_ns, details.st_ino, details.st_dev


def private_name(relative):
    return (any(p.lower() in CACHE_DIRS for p in relative.parts[:-1])
            or relative.name.lower() in PRIVATE_NAMES
            or relative.suffix.lower() in {".sol", ".log"}
            or relative.name.lower().startswith((".env", "credentials", "session.json", "auth.json", "token.json")))


def scan(root, source_relative):
    source_relative = safe_relative(source_relative)
    if not source_relative.startswith("client/"):
        raise ReleaseError("The source must be inside this project's client/ directory")
    source = owned(root, source_relative)
    if not source.is_dir():
        raise ReleaseError("Client source directory not found")
    files, excluded, seen = [], [], set()
    for directory, dirs, names in os.walk(source, followlinks=False):
        directory = Path(directory)
        for name in list(dirs):
            child = directory / name
            reject_link(child)
            if name.lower() in CACHE_DIRS:
                excluded.append(child.relative_to(source).as_posix() + "/")
                dirs.remove(name)
        for name in names:
            child = directory / name
            details = reject_link(child)
            relative_path = child.relative_to(source)
            if private_name(relative_path):
                excluded.append(relative_path.as_posix())
                continue
            relative = safe_relative(relative_path.as_posix())
            if not stat.S_ISREG(details.st_mode) or relative.casefold() in seen:
                raise ReleaseError("Special file or duplicate Windows path in client")
            seen.add(relative.casefold())
            files.append((child, relative, fingerprint(details)))
    files.sort(key=lambda item: item[1])
    if not REQUIRED.issubset({item[1] for item in files}):
        raise ReleaseError("Client must include the native executable, loader.swf and config.xml at the adapter's expected paths")
    if len(files) > 100000:
        raise ReleaseError("The local launcher supports at most 100000 manifest entries")
    return source, files, sorted(excluded)


def file_digest(path, algorithm="sha256"):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, algorithm).hexdigest()


def plan(project, version, source=DEFAULT_SOURCE):
    root = project_root(project)
    new_version(root, version)
    final = owned(root, f"releases/snapshots/{version}")
    if final.exists():
        raise ReleaseError("Snapshot already exists; it will never be overwritten")
    source_path, files, excluded = scan(root, source)
    total = sum(item[2][0] for item in files)
    return {"mode": "plan", "project": str(root), "version": version, "active_version": read_active(root), "source_relative": source_path.relative_to(root).as_posix(), "files": len(files), "bytes": total, "estimated_peak_additional_bytes": total * 2 + 64 * 1024 * 1024, "excluded": excluded, "snapshot_relative": f"releases/snapshots/{version}", "writes": False, "native_client_executed": False}


@contextmanager
def publication_lock(root):
    folder = owned(root, "releases/snapshots")
    folder.mkdir(parents=True, exist_ok=True)
    filename = owned(root, "releases/snapshots/.publish.lock")
    identifier = uuid.uuid4().hex
    try:
        with filename.open("x", encoding="utf-8") as stream:
            json.dump({"pid": os.getpid(), "id": identifier}, stream)
    except FileExistsError as error:
        raise ReleaseError("Publication lock exists; check its owner before removing a stale lock") from error
    try:
        yield
    finally:
        try:
            if json.loads(filename.read_text(encoding="utf-8")).get("id") == identifier:
                filename.unlink()
        except (OSError, ValueError):
            pass


def copy_stable(original, destination, expected):
    reject_link(original)
    destination.parent.mkdir(parents=True, exist_ok=True)
    sha1 = hashlib.sha1()
    with original.open("rb") as source, destination.open("xb") as target:
        before = os.fstat(source.fileno())
        if fingerprint(before) != expected:
            raise ReleaseError("Client source changed since the publication scan")
        while block := source.read(1024 * 1024):
            sha1.update(block)
            target.write(block)
        if fingerprint(os.fstat(source.fileno())) != expected:
            raise ReleaseError("Client source changed while copying")
    if destination.stat().st_size != expected[0] or file_digest(destination, "sha1") != sha1.hexdigest():
        raise ReleaseError("Copied client integrity check failed")
    return {"size": expected[0], "hash": sha1.hexdigest()}


def validate_manifest(manifest, version):
    if not isinstance(manifest, dict) or not REQUIRED.issubset(manifest) or len(manifest) > 100000:
        raise ReleaseError("Invalid snapshot manifest")
    seen = set()
    for relative, entry in manifest.items():
        safe_relative(relative)
        expected_url = f"{ORIGIN}/local/releases/{version}/files/" + quote(relative, safe="/")
        if relative.casefold() in seen or not isinstance(entry, dict) or type(entry.get("size")) is not int or entry["size"] < 0 or not re.fullmatch(r"[0-9a-f]{40}", str(entry.get("hash", ""))) or entry.get("fileUrl") != expected_url:
            raise ReleaseError("Invalid manifest entry or mutable/nonlocal file URL")
        seen.add(relative.casefold())


def verify_directory(snapshot, manifest, version):
    validate_manifest(manifest, version)
    actual = set()
    base = snapshot / "files"
    reject_link(base)
    for directory, dirs, names in os.walk(base, followlinks=False):
        for name in dirs:
            reject_link(Path(directory) / name)
        for name in names:
            item = Path(directory) / name
            reject_link(item)
            relative = safe_relative(item.relative_to(base).as_posix())
            actual.add(relative)
            entry = manifest.get(relative)
            if not entry or item.stat().st_size != entry["size"] or file_digest(item, "sha1") != entry["hash"]:
                raise ReleaseError(f"Snapshot file integrity mismatch: {relative}")
    if actual != set(manifest):
        raise ReleaseError("Snapshot files and manifest differ")
    reject_link(snapshot / "client.zip")
    with zipfile.ZipFile(snapshot / "client.zip") as archive:
        entries = archive.infolist()
        if len(entries) != len(manifest) or {item.filename for item in entries} != set(manifest):
            raise ReleaseError("ZIP and manifest members differ")
        for item in entries:
            safe_relative(item.filename)
            entry = manifest[item.filename]
            kind = (item.external_attr >> 16) & 0xF000
            if item.flag_bits & 1 or item.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED} or kind not in {0, stat.S_IFREG} or item.file_size != entry["size"]:
                raise ReleaseError("Unsupported or inconsistent ZIP member")
            digest, total = hashlib.sha1(), 0
            with archive.open(item) as stream:
                while block := stream.read(1024 * 1024):
                    total += len(block)
                    if total > entry["size"]:
                        raise ReleaseError("ZIP member exceeded manifest size")
                    digest.update(block)
            if total != entry["size"] or digest.hexdigest() != entry["hash"]:
                raise ReleaseError("ZIP member hash mismatch")
    return {"version": version, "files": len(manifest), "bytes": sum(item["size"] for item in manifest.values()), "manifest_sha256": file_digest(snapshot / "manifest.json"), "zip_sha256": file_digest(snapshot / "client.zip"), "zip_verified_against_manifest": True}


def verify(project, version):
    root = project_root(project)
    if type(version) is not int or version < 2:
        raise ReleaseError("Snapshot versions begin at 2; version 1 is builtin")
    snapshot = owned(root, f"releases/snapshots/{version}")
    manifest_file = owned(root, f"releases/snapshots/{version}/manifest.json")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    return {**verify_directory(snapshot, manifest, version), "snapshot_relative": snapshot.relative_to(root).as_posix(), "writes": False}


def write_pointer_atomic(root, value):
    pointer = owned(root, "data/client-release.json")
    pointer.parent.mkdir(parents=True, exist_ok=True)
    temporary = owned(root, f"data/.client-release-{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, pointer)
    finally:
        temporary.unlink(missing_ok=True)


def activate_locked(root, version, verification=None):
    new_version(root, version)
    verification = verification or verify(root, version)
    base = f"releases/snapshots/{version}"
    pointer = {"version": version, "manifestRelative": base + "/manifest.json", "zipRelative": base + "/client.zip", "rootRelative": base + "/files"}
    write_pointer_atomic(root, pointer)
    return {**verification, "activated": True, "pointer": pointer, "writes": True}


def activate(project, version):
    root = project_root(project)
    with publication_lock(root):
        return activate_locked(root, version)


def publish(project, version, source=DEFAULT_SOURCE, activate_after=False, compression="deflate", progress=None):
    root = project_root(project)
    if compression not in {"stored", "deflate"}:
        raise ReleaseError("Use stored or deflate compression")
    with publication_lock(root):
        initial = plan(root, version, source)
        source_path, files, excluded = scan(root, source)
        final = owned(root, f"releases/snapshots/{version}")
        staging = owned(root, f"releases/snapshots/.building-{version}-{uuid.uuid4().hex}")
        staging.mkdir(exist_ok=False)
        manifest = {}
        try:
            for index, (original, relative, expected) in enumerate(files, 1):
                entry = copy_stable(original, staging / "files" / relative, expected)
                entry["fileUrl"] = f"{ORIGIN}/local/releases/{version}/files/" + quote(relative, safe="/")
                manifest[relative] = entry
                if progress and (index % 5000 == 0 or index == len(files)):
                    progress({"stage": "copied", "files": index, "total_files": len(files)})
            # Ordinary source writes/additions during the operation abort publication.
            _, final_files, final_excluded = scan(root, source)
            if [(r, f) for _, r, f in files] != [(r, f) for _, r, f in final_files] or excluded != final_excluded:
                raise ReleaseError("Client source changed during publication; stop writes and retry a fresh version")
            (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
            method = zipfile.ZIP_STORED if compression == "stored" else zipfile.ZIP_DEFLATED
            if progress:
                progress({"stage": "zip", "files": len(manifest)})
            with zipfile.ZipFile(staging / "client.zip", "x", compression=method, compresslevel=None if method == zipfile.ZIP_STORED else 1, allowZip64=True) as archive:
                for relative in manifest:
                    archive.write(staging / "files" / relative, relative)
            if progress:
                progress({"stage": "verifying", "files": len(manifest)})
            checked = verify_directory(staging, manifest, version)
            report = {**checked, "created_at_utc": datetime.now(timezone.utc).isoformat(), "source_relative": source_path.relative_to(root).as_posix(), "source_metadata_stable_during_copy": True, "compression": compression, "excluded": excluded, "snapshot_relative": initial["snapshot_relative"], "activated": False, "original_client_modified": False, "installation_modified": False, "native_client_executed": False}
            (staging / "snapshot-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            if final.exists():
                raise ReleaseError("Snapshot appeared during publication; refusing to overwrite it")
            staging.rename(final)
        except BaseException:
            # Only this fresh staging directory is removable; existing releases are kept.
            if staging.exists() and staging.parent == owned(root, "releases/snapshots") and staging.name.startswith(".building-"):
                shutil.rmtree(staging)
            raise
        if activate_after:
            result = activate_locked(root, version, checked)
            return {**report, **result}
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "publish", "verify", "activate"])
    parser.add_argument("--project-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--version", required=True, type=int)
    parser.add_argument("--source", default=DEFAULT_SOURCE, help="Project-relative client/ directory, read only")
    parser.add_argument("--compression", choices=["stored", "deflate"], default="deflate")
    parser.add_argument("--activate", action="store_true", help="Activate after publish verifies all snapshot and ZIP bytes")
    args = parser.parse_args()
    try:
        if args.command == "plan":
            result = plan(args.project_root, args.version, args.source)
        elif args.command == "publish":
            progress = lambda value: print(json.dumps(value), file=sys.stderr, flush=True)
            result = publish(args.project_root, args.version, args.source, args.activate, args.compression, progress)
        elif args.command == "verify":
            result = verify(args.project_root, args.version)
        else:
            result = activate(args.project_root, args.version)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ReleaseError, OSError, zipfile.BadZipFile, ValueError) as error:
        parser.exit(1, f"Client publication refused: {error}\n")


if __name__ == "__main__":
    main()
