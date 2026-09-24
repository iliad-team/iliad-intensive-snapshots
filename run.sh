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
  --ref <rev>         pipeline revision             (default: source repo HEAD)

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

cmd="${1:-help}"
[ $# -gt 0 ] && shift
case "$cmd" in
  status)   backfill --dry-run "$@" ;;
  trial)
    n=5
    if [[ "${1:-}" =~ ^[0-9]+$ ]]; then n="$1"; shift; fi
    backfill --limit "$n" "$@" ;;
  build)    backfill "$@" ;;
  retry)    backfill --retry-failed "$@" ;;
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
