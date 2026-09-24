#!/usr/bin/env bash
#
# ./setup.sh — get this machine ready to run backfill.mjs.
#
#   1. clone iliad-intensive next to this folder (full history: the backfill
#      renders every version on every branch), or fetch if it is already there
#   2. run that repo's own ./setup.sh — TeX Live, Typst, Node 22 via nvm, both
#      npm installs, git LFS. It holds the one definition of the package set
#      (.github/apt-packages.txt), so nothing is duplicated here.
#   3. what old versions need on top: texlive-science (stmaryrd, physics —
#      the source repo dropped it on 2026-07-28, after sheets had used it)
#      and every historical LFS object (figures; ~50 MB), without which
#      pdflatex chokes on LFS pointer files
#   4. check everything backfill.mjs needs, then `backfill.mjs --dry-run`
#
# Idempotent: re-running only installs what's missing.
#
#   ./setup.sh                 source repo at ../iliad-intensive
#   ./setup.sh --src <path>    somewhere else (then pass the same --src to backfill.mjs)

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/../iliad-intensive"
REPO="${ILIAD_REPO:-https://github.com/iliad-team/iliad-intensive.git}"

while [ $# -gt 0 ]; do
  case "$1" in
    --src) SRC="${2:?--src needs a path}"; shift 2 ;;
    -h|--help) sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument $1 (see --help)" >&2; exit 1 ;;
  esac
done

echo "== source repo =="
if [ -d "$SRC/.git" ] || git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  # No --prune: remote-tracking refs of deleted branches are history the
  # backfill still wants to enumerate.
  echo "$SRC exists — fetching every branch"
  git -C "$SRC" fetch origin
elif [ -e "$SRC" ]; then
  echo "$SRC exists but is not a git repository — move it or pass --src" >&2
  exit 1
else
  echo "cloning $REPO → $SRC"
  git clone "$REPO" "$SRC"
fi
# every PR head too, fork PRs included (their branches are not in the repo)
echo "fetching every PR head"
git -C "$SRC" fetch -q origin '+refs/pull/*/head:refs/remotes/pull/*'
SRC="$(cd "$SRC" && pwd)"

echo
echo "== iliad-intensive/setup.sh =="
(cd "$SRC" && ./setup.sh)

echo
echo "== extras for historical versions =="
if kpsewhich stmaryrd.sty physics.sty 2>/dev/null | grep -q physics; then
  echo "texlive-science already installed"
else
  sudo apt-get install -y --no-install-recommends texlive-science
fi
git -C "$SRC" lfs fetch --all || echo "⚠ some LFS objects could not be fetched (fork PRs?); those figures stay pointers"

echo
echo "== checks =="
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm use 22 >/dev/null
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; else echo "  ✗ $1"; fail=1; fi; }
check "node $(node --version) (>= 20, from nvm)" '[ "$(node -p "parseInt(process.versions.node)")" -ge 20 ]'
check "node_modules"                 "[ -d '$SRC/node_modules' ]"
check "scripts/tex2mdx/node_modules" "[ -d '$SRC/scripts/tex2mdx/node_modules' ]"
check "pdflatex"                     "command -v pdflatex"
check "git, tar"                     "command -v git && command -v tar"
[ "$fail" = 0 ] || { echo "setup incomplete — see ✗ above" >&2; exit 1; }

echo
echo "== backfill.mjs --dry-run =="
src_arg=()
[ "$SRC" = "$(cd "$HERE/.." && pwd)/iliad-intensive" ] || src_arg=(--src "$SRC")
node "$HERE/backfill.mjs" --dry-run "${src_arg[@]}"

echo
echo "Done. Next: ./run.sh help   (./run.sh trial, then ./run.sh build${src_arg[*]:+ ${src_arg[*]}})"
