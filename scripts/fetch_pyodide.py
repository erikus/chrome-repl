# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Download a pinned Pyodide release and write a trimmed runtime to vendor/pyodide/.

Usage:
    uv run scripts/fetch_pyodide.py              # trimmed stdlib (default)
    uv run scripts/fetch_pyodide.py --untrimmed  # full stdlib, for re-deriving the allowlist

To re-derive STDLIB_ALLOWLIST after a version bump: run with --untrimmed, then
`PYODIDE_TRACE_MODULES=1 node --test tests/` prints every stdlib file the
console exercise loaded. Add anything new here, re-run without --untrimmed and
`make test` again.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import shutil
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

PYODIDE_VERSION = "314.0.7"  # Python 3.14.2
TARBALL_SHA256 = "2abdcc2e35208af406e07724cffa85bc582ced97e9028383ecf5462541393f95"
TARBALL_NAME = f"pyodide-core-{PYODIDE_VERSION}.tar.bz2"
TARBALL_URL = f"https://github.com/pyodide/pyodide/releases/download/{PYODIDE_VERSION}/{TARBALL_NAME}"
TARBALL_ROOT = "pyodide"
DOWNLOAD_TIMEOUT_S = 120
HASH_CHUNK_BYTES = 1 << 20
ZIP_COMPRESS_LEVEL = 9

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = PROJECT_ROOT / ".cache"
VENDOR_DIR = PROJECT_ROOT / "vendor" / "pyodide"

STDLIB_ZIP = "python_stdlib.zip"
# Everything loadPyodide() reads at startup besides the stdlib zip. Verified by
# grepping pyodide.mjs: it resolves pyodide.asm.mjs, pyodide.asm.wasm,
# pyodide-lock.json and python_stdlib.zip relative to indexURL. package.json,
# pyodide.js (UMD build), *.d.ts and the python CLI shims are not needed.
RUNTIME_FILES = ("pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "pyodide-lock.json")

# Paths inside python_stdlib.zip to keep. A trailing "/" keeps the whole
# package. Derived empirically: loading Pyodide plus pyodide.console and
# exercising math/random/statistics, tracebacks, completion and help() under
# Node with the untrimmed stdlib, then listing every loaded __file__.
STDLIB_ALLOWLIST = (
    # Pyodide runtime and console.
    "_pyodide/",
    "pyodide/",
    "asyncio/",
    "concurrent/",
    "compression/",
    "_sysconfigdata__emscripten_wasm32-emscripten.py",
    "sysconfig/__init__.py",
    # Interpreter startup / import machinery.
    "site.py",
    "_sitebuiltins.py",
    "_colorize.py",
    "_py_warnings.py",
    "warnings.py",
    "importlib/__init__.py",
    "importlib/_abc.py",
    "importlib/_bootstrap.py",
    "importlib/_bootstrap_external.py",
    "importlib/abc.py",
    "importlib/machinery.py",
    "importlib/util.py",
    "zipimport.py",
    "encodings/__init__.py",
    "encodings/aliases.py",
    "encodings/utf_8.py",
    "encodings/ascii.py",
    "encodings/latin_1.py",
    "encodings/utf_16.py",
    "encodings/utf_16_le.py",
    "encodings/utf_16_be.py",
    "encodings/utf_32.py",
    "encodings/utf_32_le.py",
    "encodings/utf_32_be.py",
    "encodings/unicode_escape.py",
    "encodings/raw_unicode_escape.py",
    # Requested modules and their pure-Python dependencies.
    "random.py",
    "statistics.py",
    "fractions.py",
    "decimal.py",
    "numbers.py",
    "bisect.py",
    "heapq.py",
    "operator.py",
    "functools.py",
    "collections/__init__.py",
    "_collections_abc.py",
    "_weakrefset.py",
    "weakref.py",
    "copy.py",
    "copyreg.py",
    "reprlib.py",
    "keyword.py",
    "types.py",
    "abc.py",
    "enum.py",
    "contextlib.py",
    "contextvars.py",
    "dataclasses.py",
    "inspect.py",
    "annotationlib.py",
    "ast.py",
    "dis.py",
    "opcode.py",
    "_opcode_metadata.py",
    "typing.py",
    "__future__.py",
    # REPL: console, completion, tracebacks (difflib: keyword typo suggestions).
    "code.py",
    "codeop.py",
    "rlcompleter.py",
    "traceback.py",
    "linecache.py",
    "tokenize.py",
    "token.py",
    "textwrap.py",
    "difflib.py",
    "re/",
    # help() via pydoc (pydoc_data is not shipped upstream either).
    "pydoc.py",
    "pkgutil.py",
    "_pyrepl/__init__.py",
    "_pyrepl/pager.py",
    "platform.py",
    "urllib/__init__.py",
    "urllib/parse.py",
    "ipaddress.py",
    # Imported at startup by the modules above.
    "base64.py",
    "bz2.py",
    "lzma.py",
    "codecs.py",
    "io.py",
    "os.py",
    "stat.py",
    "posixpath.py",
    "ntpath.py",
    "genericpath.py",
    "fnmatch.py",
    "glob.py",
    "shutil.py",
    "tempfile.py",
    "pathlib/",
    "zipfile/",
    "json/",
    "logging/__init__.py",
    "locale.py",
    "signal.py",
    "socket.py",
    "selectors.py",
    "ssl.py",
    "_ssl.py",
    "struct.py",
    "string/",
    "subprocess.py",
    "threading.py",
)


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(HASH_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def fetch_tarball() -> Path:
    """Return the cached tarball, downloading it if missing or corrupt."""
    CACHE_DIR.mkdir(exist_ok=True)
    tarball = CACHE_DIR / TARBALL_NAME
    if tarball.exists() and sha256_of(tarball) == TARBALL_SHA256:
        print(f"using cached {tarball.relative_to(PROJECT_ROOT)}")
        return tarball
    print(f"downloading {TARBALL_URL}")
    partial = tarball.with_suffix(tarball.suffix + ".part")
    with urllib.request.urlopen(TARBALL_URL, timeout=DOWNLOAD_TIMEOUT_S) as resp, partial.open("wb") as out:
        shutil.copyfileobj(resp, out)
    actual = sha256_of(partial)
    if actual != TARBALL_SHA256:
        partial.unlink()
        sys.exit(f"SHA-256 mismatch for {TARBALL_NAME}: expected {TARBALL_SHA256}, got {actual}")
    partial.replace(tarball)
    return tarball


def is_allowed(name: str) -> bool:
    return any(name == entry or (entry.endswith("/") and name.startswith(entry)) for entry in STDLIB_ALLOWLIST)


def trim_stdlib(full_zip: bytes) -> bytes:
    """Rebuild python_stdlib.zip keeping only allowlisted .py files."""
    out_buf = io.BytesIO()
    matched: set[str] = set()
    with zipfile.ZipFile(io.BytesIO(full_zip)) as src, zipfile.ZipFile(
        out_buf, "w", zipfile.ZIP_DEFLATED, compresslevel=ZIP_COMPRESS_LEVEL
    ) as dst:
        for info in src.infolist():
            if info.is_dir() or not info.filename.endswith(".py") or not is_allowed(info.filename):
                continue
            matched.update(e for e in STDLIB_ALLOWLIST if info.filename == e or info.filename.startswith(e))
            new_info = zipfile.ZipInfo(info.filename, date_time=info.date_time)
            new_info.compress_type = zipfile.ZIP_DEFLATED
            new_info.external_attr = info.external_attr
            dst.writestr(new_info, src.read(info), compresslevel=ZIP_COMPRESS_LEVEL)
    unmatched = sorted(set(STDLIB_ALLOWLIST) - matched)
    if unmatched:
        sys.exit(f"allowlist entries not found in {STDLIB_ZIP} (stale for {PYODIDE_VERSION}?): {unmatched}")
    return out_buf.getvalue()


def read_member(tar: tarfile.TarFile, name: str) -> bytes:
    member = tar.getmember(f"{TARBALL_ROOT}/{name}")
    if not member.isfile():
        sys.exit(f"{member.name} in tarball is not a regular file")
    f = tar.extractfile(member)
    assert f is not None
    return f.read()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--untrimmed", action="store_true", help="ship the full stdlib zip (for allowlist derivation)")
    args = parser.parse_args()

    tarball = fetch_tarball()
    VENDOR_DIR.parent.mkdir(exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix="pyodide.", dir=VENDOR_DIR.parent))
    try:
        # Read only named members; never extract the archive wholesale.
        with tarfile.open(tarball, "r:bz2") as tar:
            for name in RUNTIME_FILES:
                (staging / name).write_bytes(read_member(tar, name))
            full_zip = read_member(tar, STDLIB_ZIP)
        stdlib = full_zip if args.untrimmed else trim_stdlib(full_zip)
        (staging / STDLIB_ZIP).write_bytes(stdlib)
        if VENDOR_DIR.exists():
            shutil.rmtree(VENDOR_DIR)
        staging.replace(VENDOR_DIR)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise

    total = sum(p.stat().st_size for p in VENDOR_DIR.iterdir())
    print(f"{STDLIB_ZIP}: {len(full_zip):,} -> {len(stdlib):,} bytes")
    print(f"wrote {VENDOR_DIR.relative_to(PROJECT_ROOT)}/ ({total:,} bytes, Pyodide {PYODIDE_VERSION})")


if __name__ == "__main__":
    main()
