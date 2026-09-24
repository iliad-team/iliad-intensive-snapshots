#!/usr/bin/env bash
#
# ./run.sh — the everyday commands for the snapshot backfill.
# Loads Node 22 from nvm itself, so it works in any shell after ./setup.sh.

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

# usable CPUs: the cgroup quota when there is one (nproc ignores it)
cpus() {
  local q p
  if read -r q p 2>/dev/null </sys/fs/cgroup/cpu.max && [ "$q" != max ]; then
    echo $(( q / p > 0 ? q / p : 1 ))
  else
    nproc 2>/dev/null || echo "?"
  fi
}

usage() {
  cat <<EOF
./run.sh — render every historical version of every iliad-intensive page

usage: ./run.sh <command> [backfill flags…]

commands
  status              what exists: per-page versions / built / failed / to build
  trial [N]           build the N newest unbuilt versions (default 5) — try this first
  build               build everything not yet built (resumable; Ctrl-C is safe)
  retry               also retry versions recorded as failed (after a pipeline fix)
  failures [slug]     list recorded failures with their one-line reason
  log                 the newest batch's build logs (all runs: .logs/<run start time>/)
  clean               remove the scratch worktree in the source repo
  help                this text

backfill flags (after the command, passed through to backfill.mjs)
  --only a,b          only these slugs              ./run.sh build --only aixi,qft
  --batch N           versions per next build       (default 25)
  --jobs N            parallel sheets in conversion (default: usable CPUs, $(cpus) here)
  --limit N           at most N versions this run
  --src <path>        source repo                   (default ../iliad-intensive)
  --ref <rev>         pipeline revision             (default: the source repo's origin/main)
  --no-sync           skip the sync below (offline, or on purpose)

status / trial / build / retry first SYNC, so a local run matches what CI
(.github/workflows/update.yml) produces: this repo is fast-forwarded to
origin, the source repo is fetched (every branch and PR head), and pages are built with origin/main's
pipeline, not whatever the source checkout happens to be on. CI renders new
versions hourly on its own; build locally only to try something out.

examples
  ./run.sh status
  ./run.sh trial
  ./run.sh build --only qft
  ./run.sh failures aixi

Output: <slug>/<tree>.html + index.json here. Logs: .logs/<run start time>/
First time on a machine? ./setup.sh
EOF
}

# backfill.mjs needs Node >= 18 (and picks Node >= 20 from nvm for the builds)
use_node() {
  if ! command -v node >/dev/null || [ "$(node -p 'parseInt(process.versions.node)')" -lt 18 ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    if [ -s "$NVM_DIR/nvm.sh" ]; then
      # shellcheck disable=SC1091
      . "$NVM_DIR/nvm.sh"
      nvm use 22 >/dev/null 2>&1 || true
    fi
  fi
  command -v node >/dev/null || { echo "✗ no node found — run ./setup.sh first" >&2; exit 1; }
}
backfill() { use_node; exec node backfill.mjs "$@"; }

# Bring both repos up to what CI sees, and default the pipeline to the source
# repo's origin/main. Sets ARGS (the backfill flags, --no-sync removed, --ref
# added unless given). Without this a local run builds with a source checkout
# nothing ever pulls, and races CI for the same versions with older output.
ARGS=()
sync() {
  local src="$HERE/../iliad-intensive" prev="" a nosync=0 ref=""
  ARGS=()
  for a in "$@"; do
    if [ "$a" = --no-sync ]; then nosync=1; else ARGS+=("$a"); fi
    [ "$prev" = --src ] && src="$a"
    [ "$prev" = --ref ] && ref="$a"
    prev="$a"
  done
  if [ "$nosync" = 0 ]; then
    echo "sync: pulling this repo, fetching the source repo (--no-sync to skip)"
    if ! git -C "$HERE" pull -q --ff-only; then
      echo "✗ could not fast-forward this repo to origin. Uncommitted pages from an earlier" >&2
      echo "  local run? CI has committed its own copies since: see git status, and" >&2
      echo "  git checkout -- index.json && git clean -f -- '*/*.html' to drop them." >&2
      exit 1
    fi
    # branches, plus every PR head (fork PRs too) under refs/remotes/pull/, as CI does
    git -C "$src" fetch -q origin '+refs/heads/*:refs/remotes/origin/*' '+refs/pull/*/head:refs/remotes/pull/*' \
      || { echo "✗ could not fetch $src (offline? --no-sync)" >&2; exit 1; }
  fi
  if [ -z "$ref" ]; then
    ref="$(git -C "$src" symbolic-ref -q --short refs/remotes/origin/HEAD || echo origin/main)"
    ARGS+=(--ref "$ref")
  else
    echo "⚠ --ref $ref: pages built with a pipeline CI does not use; don't commit them unless that is the point"
  fi
  # The builds borrow the source checkout's node_modules, installed for ITS
  # commit: if the pipeline commit's lockfiles differ, they may not match.
  if ! git -C "$src" diff --quiet HEAD "$ref" -- package-lock.json scripts/tex2mdx/package-lock.json 2>/dev/null; then
    echo "⚠ $ref changed the npm dependencies since the source checkout's commit. Update it first:" >&2
    echo "  (cd $src && git pull --ff-only && npm ci && npm ci --prefix scripts/tex2mdx)" >&2
  fi
}

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  status)   sync "$@"; backfill --dry-run "${ARGS[@]}" ;;
  trial)
    n=5
    if [[ "${1:-}" =~ ^[0-9]+$ ]]; then n="$1"; shift; fi
    sync "$@"; backfill --limit "$n" "${ARGS[@]}" ;;
  build)    sync "$@"; backfill "${ARGS[@]}" ;;
  retry)    sync "$@"; backfill --retry-failed "${ARGS[@]}" ;;
  clean)    backfill --clean "$@" ;;
  failures)
    use_node
    [ -f index.json ] || { echo "no index.json yet — nothing built"; exit 0; }
    node -e '
      const idx = require("./index.json"), only = process.argv[1];
      let n = 0;
      for (const [slug, p] of Object.entries(idx.pages)) {
        if (only && slug !== only) continue;
        for (const v of p.versions) {
          if (v.status !== "failed") continue;
          n++;
          const why = (v.error ?? "").split("\n").map((l) => l.trim()).find((l) => l) ?? "";
          console.log(`${slug}@${v.tree.slice(0, 10)}  ${v.commits[0]?.date.slice(0, 10) ?? ""}  ${why.slice(0, 120)}`);
        }
      }
      console.log(n ? `\n${n} failed — full errors: index.json pages.<slug>.versions[].error` : "no recorded failures");
    ' "${1:-}" ;;
  log)
    latest="$(ls -t .logs/*/batch-*.log 2>/dev/null | head -1 || true)"
    [ -n "$latest" ] || { echo "no logs yet (.logs/ is empty)"; exit 0; }
    prefix="${latest%%-content.log}"; prefix="${prefix%%-next-*}"; prefix="${prefix%%-strip.log}"
    for f in "$prefix"-*.log; do echo "==> $f <=="; tail -n 40 "$f"; echo; done ;;
  help|-h|--help) usage ;;
  *) echo "unknown command: $cmd" >&2; echo >&2; usage >&2; exit 1 ;;
esac
