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
from dataclasses import dataclass
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
NOTICES_CACHE_DIR = CACHE_DIR / "notices"
VENDOR_DIR = PROJECT_ROOT / "vendor" / "pyodide"

# The release tarball ships no license files, so the upstream notices for
# everything in it are fetched separately, pinned to the exact revisions this
# Pyodide release was built from (see cpython/Makefile and Makefile.envs in
# the Pyodide repo at the tag) and SHA-256 verified like the tarball.
# `make zip` puts the concatenation at the zip root.
NOTICES_FILE = "THIRD_PARTY_NOTICES.txt"
CPYTHON_TAG = "v3.14.2"
EMSCRIPTEN_TAG = "5.0.3"
LIBFFI_COMMIT = "f08493d249d2067c8b3207ba46693dd858f95db3"  # Pyodide cpython/Makefile
HACL_STAR_COMMIT = "8ba599b2f6c9701b3dc961db895b0856a2210f76"  # CPython Modules/_hacl/refresh.sh
RAW_GITHUB = "https://raw.githubusercontent.com"


@dataclass(frozen=True)
class Notice:
    cache_name: str
    title: str
    url: str
    sha256: str


NOTICES = (
    Notice(
        "pyodide-LICENSE",
        f"Pyodide {PYODIDE_VERSION} (pyodide.mjs, pyodide.asm.*, the _pyodide/pyodide Python packages and "
        "the bundled hiwire library) -- Mozilla Public License 2.0.\n"
        f"Source code form: https://github.com/pyodide/pyodide/tree/{PYODIDE_VERSION}",
        f"{RAW_GITHUB}/pyodide/pyodide/{PYODIDE_VERSION}/LICENSE",
        "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5",
    ),
    Notice(
        "cpython-LICENSE",
        f"CPython {CPYTHON_TAG.removeprefix('v')} interpreter and standard library (python_stdlib.zip) -- "
        "PSF License Agreement and historical licenses",
        f"{RAW_GITHUB}/python/cpython/{CPYTHON_TAG}/LICENSE",
        "b0e25a78cffb43f4d92de8b61ccfa1f1f98ecbc22330b54b5251e7b6ba010231",
    ),
    Notice(
        "cpython-license.rst",
        "CPython: licenses and acknowledgements for incorporated software (Mersenne Twister, SipHash, "
        "dtoa, expat, libffi, zlib, libmpdec, mimalloc, Zstandard bindings, ...)",
        f"{RAW_GITHUB}/python/cpython/{CPYTHON_TAG}/Doc/license.rst",
        "c695d550b135e53e38807e76496d1db17d22c40e461d1f3f354c86188d3305dd",
    ),
    Notice(
        "hacl-star-LICENSE",
        "HACL* (hashlib/_blake2 primitives vendored in CPython Modules/_hacl)",
        f"{RAW_GITHUB}/hacl-star/hacl-star/{HACL_STAR_COMMIT}/LICENSE",
        "c5accbbd8546e94c34aed24afe689a617627d18eed5a6c48277e48db57c23851",
    ),
    Notice(
        "libffi-LICENSE",
        "libffi (compiled into pyodide.asm.wasm) -- MIT License",
        f"{RAW_GITHUB}/libffi/libffi/{LIBFFI_COMMIT}/LICENSE",
        "2c9c2acb9743e6b007b91350475308aee44691d96aa20eacef8e199988c8c388",
    ),
    Notice(
        "zstd-LICENSE",
        "Zstandard 1.5.7 (compiled into pyodide.asm.wasm) -- BSD License",
        f"{RAW_GITHUB}/python/cpython-source-deps/zstd-1.5.7/LICENSE",
        "7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8",
    ),
    Notice(
        "xz-COPYING",
        "XZ Utils 5.2.2 / liblzma (compiled into pyodide.asm.wasm) -- public domain",
        f"{RAW_GITHUB}/xz-mirror/xz/v5.2.2/COPYING",
        "c4f8e14fafe458d84808a4cd8b69f94673ebe2bf8fc992291629a69ac12218f8",
    ),
    Notice(
        "bzip2-LICENSE",
        "bzip2 1.0.6 (Emscripten port, compiled into pyodide.asm.wasm) -- BSD-style License",
        f"{RAW_GITHUB}/emscripten-ports/bzip2/1.0.6/LICENSE",
        "4919cfb14a73cd64fcef67b107613970cf1659a09aa675dba31314f373bc7204",
    ),
    Notice(
        "emscripten-LICENSE",
        f"Emscripten {EMSCRIPTEN_TAG} runtime and JS glue (pyodide.asm.mjs) -- MIT / University of Illinois NCSA",
        f"{RAW_GITHUB}/emscripten-core/emscripten/{EMSCRIPTEN_TAG}/LICENSE",
        "620a78084fc7ca97c0b5dea9abf891f3ffcadfdbf305276f099c9c4e12fc1d86",
    ),
    Notice(
        "musl-COPYRIGHT",
        "musl libc (Emscripten's C library, compiled into pyodide.asm.wasm) -- MIT License",
        f"{RAW_GITHUB}/emscripten-core/emscripten/{EMSCRIPTEN_TAG}/system/lib/libc/musl/COPYRIGHT",
        "f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af",
    ),
    Notice(
        "libcxx-LICENSE.TXT",
        "LLVM libc++ / libc++abi (compiled into pyodide.asm.wasm) -- Apache License 2.0 with LLVM Exceptions",
        f"{RAW_GITHUB}/emscripten-core/emscripten/{EMSCRIPTEN_TAG}/system/lib/libcxx/LICENSE.TXT",
        "539dd7aed86e8a4f12cbdd0e6c50c189c7d74847e4fecc64ce2c6ee3a01da38b",
    ),
    Notice(
        "compiler-rt-LICENSE.TXT",
        "LLVM compiler-rt (compiled into pyodide.asm.wasm) -- Apache License 2.0 with LLVM Exceptions",
        f"{RAW_GITHUB}/emscripten-core/emscripten/{EMSCRIPTEN_TAG}/system/lib/compiler-rt/LICENSE.TXT",
        "1a8f1058753f1ba890de984e48f0242a3a5c29a6a8f2ed9fd813f36985387e8d",
    ),
)

NOTICES_HEADER = f"""\
Third-party notices for Python REPL

This extension bundles Pyodide {PYODIDE_VERSION} (CPython {CPYTHON_TAG.removeprefix('v')} compiled to
WebAssembly with Emscripten {EMSCRIPTEN_TAG}), unmodified apart from removing unused
standard-library modules from python_stdlib.zip. The upstream license texts
for it and for the libraries compiled into pyodide.asm.wasm follow.

SQLite 3.39.0 is also compiled into pyodide.asm.wasm; it is in the public
domain (https://sqlite.org/copyright.html) and carries no license text.

The extension's own code is MIT-licensed (see LICENSE in the source
repository: https://github.com/erikus/chrome-repl).
"""
NOTICE_RULE = "=" * 78

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


def fetch_pinned(url: str, expected_sha256: str, dest: Path) -> Path:
    """Return dest, downloading url into it if missing or corrupt."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and sha256_of(dest) == expected_sha256:
        print(f"using cached {dest.relative_to(PROJECT_ROOT)}")
        return dest
    print(f"downloading {url}")
    partial = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT_S) as resp, partial.open("wb") as out:
        shutil.copyfileobj(resp, out)
    actual = sha256_of(partial)
    if actual != expected_sha256:
        partial.unlink()
        sys.exit(f"SHA-256 mismatch for {url}: expected {expected_sha256}, got {actual}")
    partial.replace(dest)
    return dest


def build_notices() -> str:
    """Concatenate the pinned upstream license texts under NOTICES_HEADER."""
    sections = [NOTICES_HEADER]
    for notice in NOTICES:
        path = fetch_pinned(notice.url, notice.sha256, NOTICES_CACHE_DIR / notice.cache_name)
        text = path.read_text(encoding="utf-8").strip("\n")
        sections.append(f"{NOTICE_RULE}\n{notice.title}\nLicense text from: {notice.url}\n{NOTICE_RULE}\n\n{text}\n")
    return "\n\n".join(sections)


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

    tarball = fetch_pinned(TARBALL_URL, TARBALL_SHA256, CACHE_DIR / TARBALL_NAME)
    notices = build_notices()
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
        (staging / NOTICES_FILE).write_text(notices, encoding="utf-8")
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
