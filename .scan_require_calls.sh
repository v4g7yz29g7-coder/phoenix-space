#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scan_require_calls.py — find ALL `require(` calls in the project.

Coverage:
  * ALL text extensions, including .sh / .bash / .zsh / .txt / extension-less
    scripts that embed JS via `node -e "..."`, heredocs, etc.
  * Static requires:  require('x'), require("x")
  * Dynamic requires: require(var), require(expr), require(`tpl${x}`),
                      require(a + '/b'), etc.
Noise filtering:
  * node_modules, .git, vendor, dist, build, venv, __pycache__, .cache
  * backup artifacts:  *backup*, *.bak*, *.bak_*, *.orig, *.save, *~, *.pyy
  * generated report files themselves (REQUIRE_CALLS_REPORT*, EXEC_CALLS_REPORT*)
  * binary files
"""
import os, re, sys, json

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
OUT_TXT = os.path.join(ROOT, "REQUIRE_CALLS_REPORT.txt")
OUT_MD = os.path.join(ROOT, "REQUIRE_CALLS_REPORT.md")

PRUNE_DIRS = {
    ".git", "node_modules", "vendor", "dist", "build", "venv", ".venv",
    "__pycache__", ".cache", ".npm", ".phoenix_vision", ".svelte-kit",
    "coverage", ".next", ".nuxt", "target", ".idea", ".vscode",
}
NOISE_NAME_PATTERNS = [
    r"backup", r"\.bak", r"\.orig$", r"\.save$", r"~$", r"\.pyy$",
    r"^REQUIRE_CALLS_REPORT", r"^EXEC_CALLS_REPORT", r"^TODO_FINDINGS",
    r"\.log$", r"^memory_stub", r"^phoenix-deploy\.log",
    r"^\.scan_require", r"^\.gen_require",
]

# Files that are probably binary / huge -> skip
MAX_SIZE = 5 * 1024 * 1024

def is_noise(name):
    for p in NOISE_NAME_PATTERNS:
        if re.search(p, name, re.I):
            return True
    return False

def is_binary(path):
    try:
        with open(path, "rb") as f:
            chunk = f.read(4096)
    except OSError:
        return True
    if b"\x00" in chunk:
        return True
    return False

# require(  ... )   -> capture the argument text up to the matching close paren (single line)
REQUIRE_RE = re.compile(r"(?<![\w$.])require\s*\(")

def classify(arg):
    """Return ('static', module) or ('dynamic', raw)"""
    a = arg.strip()
    m = re.match(r"^(['\"])(.*?)\1$", a, re.S)
    if m:
        return "static", m.group(2)
    return "dynamic", a

def extract_args(line):
    """Yield (col, arg_text) for each require( on the line, balancing parens."""
    out = []
    for m in REQUIRE_RE.finditer(line):
        i = m.end()
        depth = 1
        quote = None
        buf = []
        while i < len(line):
            ch = line[i]
            if quote:
                buf.append(ch)
                if ch == "\\":
                    i += 1
                    if i < len(line):
                        buf.append(line[i])
                elif ch == quote:
                    quote = None
            else:
                if ch in "'\"`":
                    quote = ch
                    buf.append(ch)
                elif ch == "(":
                    depth += 1
                    buf.append(ch)
                elif ch == ")":
                    depth -= 1
                    if depth == 0:
                        break
                    buf.append(ch)
                else:
                    buf.append(ch)
            i += 1
        out.append((m.start() + 1, "".join(buf).strip()))
    return out

static_hits = []   # dict: file, line, col, module, text
dynamic_hits = []
files_scanned = 0
ext_counter = {}

for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS]
    for fn in filenames:
        if is_noise(fn):
            continue
        path = os.path.join(dirpath, fn)
        if os.path.islink(path):
            continue
        try:
            if os.path.getsize(path) > MAX_SIZE:
                continue
        except OSError:
            continue
        if is_binary(path):
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
        except OSError:
            continue
        if "require" not in content:
            continue
        files_scanned += 1
        ext = os.path.splitext(fn)[1] or "<no-ext>"
        rel = os.path.relpath(path, ROOT)
        for lineno, line in enumerate(content.splitlines(), 1):
            if "require" not in line:
                continue
            for col, arg in extract_args(line):
                kind, val = classify(arg)
                rec = {
                    "file": rel, "line": lineno, "col": col,
                    "ext": ext, "text": line.strip()[:300],
                }
                if kind == "static":
                    rec["module"] = val
                    static_hits.append(rec)
                    ext_counter[ext] = ext_counter.get(ext, 0) + 1
                else:
                    rec["arg"] = val or "<empty>"
                    dynamic_hits.append(rec)
                    ext_counter[ext] = ext_counter.get(ext, 0) + 1

static_hits.sort(key=lambda r: (r["file"], r["line"]))
dynamic_hits.sort(key=lambda r: (r["file"], r["line"]))
all_hits = sorted(static_hits + dynamic_hits, key=lambda r: (r["file"], r["line"]))

def fmt_txt():
    L = []
    L.append("=" * 78)
    L.append("REQUIRE CALLS REPORT")
    L.append("=" * 78)
    L.append("root: %s" % ROOT)
    L.append("files with 'require': %d" % files_scanned)
    L.append("total require() calls: %d  (static: %d, dynamic: %d)"
             % (len(all_hits), len(static_hits), len(dynamic_hits)))
    L.append("")
    L.append("--- per extension ---")
    for e, c in sorted(ext_counter.items(), key=lambda x: (-x[1], x[0])):
        L.append("  %-12s %d" % (e, c))
    L.append("")
    L.append("=" * 78)
    L.append("[A] STATIC REQUIRES (string literal) - %d" % len(static_hits))
    L.append("=" * 78)
    for r in static_hits:
        L.append("%s:%d:%d  require('%s')" % (r["file"], r["line"], r["col"], r["module"]))
    L.append("")
    L.append("=" * 78)
    L.append("[B] DYNAMIC REQUIRES (non-literal / expression) - %d" % len(dynamic_hits))
    L.append("=" * 78)
    for r in dynamic_hits:
        L.append("%s:%d:%d  require(%s)" % (r["file"], r["line"], r["col"], r["arg"]))
    L.append("")
    return "\n".join(L)

def fmt_md():
    L = []
    L.append("# Require Calls Report\n")
    L.append("- root: `%s`" % ROOT)
    L.append("- files with `require`: **%d**" % files_scanned)
    L.append("- total `require()` calls: **%d** (static: %d, dynamic: %d)\n"
             % (len(all_hits), len(static_hits), len(dynamic_hits)))
    L.append("## Calls per extension\n")
    L.append("| ext | calls |")
    L.append("|-----|-------|")
    for e, c in sorted(ext_counter.items(), key=lambda x: (-x[1], x[0])):
        L.append("| %s | %d |" % (e, c))
    L.append("\n## A. Static requires (%d)\n" % len(static_hits))
    L.append("| file | line | module |")
    L.append("|------|------|--------|")
    for r in static_hits:
        L.append("| `%s` | %d | `%s` |" % (r["file"], r["line"], r["module"].replace("|", "\\|")))
    L.append("\n## B. Dynamic requires (%d)\n" % len(dynamic_hits))
    L.append("| file | line | argument |")
    L.append("|------|------|----------|")
    for r in dynamic_hits:
        L.append("| `%s` | %d | `%s` |" % (r["file"], r["line"], r["arg"].replace("|", "\\|")))
    L.append("")
    return "\n".join(L)

with open(OUT_TXT, "w", encoding="utf-8") as f:
    f.write(fmt_txt())
with open(OUT_MD, "w", encoding="utf-8") as f:
    f.write(fmt_md())

print("files_scanned=%d static=%d dynamic=%d total=%d"
      % (files_scanned, len(static_hits), len(dynamic_hits), len(all_hits)))
print("per-ext:", json.dumps(ext_counter, sort_keys=True))
