#!/usr/bin/env node
/**
 * backfill.mjs — render every historical version of every worksheet page of
 * iliad-team/iliad-intensive with TODAY's pipeline, and store the page HTML
 * here, for the site's /dev/diff view.
 *
 *   version key   (slug, git tree hash of tex/<slug>/)
 *   output        <slug>/<tree>.html  +  index.json
 *
 * The source repo is only ever READ (git log / ls-tree / cat-file / archive)
 * plus `git worktree add|remove` of one scratch worktree at
 * <src>/.claude/worktrees/_snapshots-build/, where all building happens.
 *
 * Run `node backfill.mjs --help` for flags. Works on Node >= 18; the builds it
 * spawns need Node >= 20 and use ~/.nvm/versions/node/v22* (or $NODE22).
 */
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync,
  statSync, renameSync, copyFileSync, symlinkSync, lstatSync, realpathSync,
  unlinkSync, createWriteStream,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAP = HERE;                         // output lives next to the script
const INDEX = path.join(SNAP, "index.json");
const LOGS = path.join(SNAP, ".logs");

// ============================================================ arguments ====
const HELP = `
backfill.mjs — pre-render every historical version of every worksheet page

usage: node backfill.mjs [flags]

  --src <path>       source repo (default ../iliad-intensive, relative to this folder)
  --ref <rev>        pipeline revision to build with (default: the source repo's HEAD)
  --only <a,b,…>     only these slugs
  --limit N          build at most N versions this run (trial runs)
  --batch N          versions per \`next build\` (default 25)
  --jobs N           parallel sheets inside build-content (default: CPU count)
  --retry-failed     also retry versions index.json records as failed
  --dry-run          enumerate only; print per-slug table of built / to-build
  --clean            remove the scratch worktree and exit
  --help             this text

Output: <slug>/<tree>.html and index.json in ${SNAP}
Logs of each build step: .logs/
`;

const argv = process.argv.slice(2);
const opt = {
  src: path.resolve(HERE, "../iliad-intensive"), ref: "HEAD", only: null, limit: Infinity,
  batch: 25, jobs: os.cpus().length, retryFailed: false, dryRun: false, clean: false,
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined) die(`${a} needs a value`);
    return v;
  };
  const int = () => {
    const n = parseInt(val(), 10);
    if (!(n > 0)) die(`${a} needs a positive integer`);
    return n;
  };
  if (a === "--help" || a === "-h") { process.stdout.write(HELP); process.exit(0); }
  else if (a === "--src") opt.src = path.resolve(process.cwd(), val());
  else if (a === "--ref") opt.ref = val();
  else if (a === "--only") opt.only = new Set(val().split(",").map((s) => s.trim()).filter(Boolean));
  else if (a === "--limit") opt.limit = int();
  else if (a === "--batch") opt.batch = int();
  else if (a === "--jobs") opt.jobs = int();
  else if (a === "--retry-failed") opt.retryFailed = true;
  else if (a === "--dry-run") opt.dryRun = true;
  else if (a === "--clean") opt.clean = true;
  else die(`unknown argument ${a} (see --help)`);
}

// ============================================================ terminal UI ==
const TTY = !!process.stdout.isTTY;
const COLOR = TTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
const esc = (n) => (s) => (COLOR ? `\x1b[${n}m${s}\x1b[0m` : String(s));
const c = {
  red: esc(31), green: esc(32), yellow: esc(33), blue: esc(34), magenta: esc(35),
  cyan: esc(36), gray: esc(90), bold: esc(1), dim: esc(2),
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const ui = {
  phase: "starting",
  total: 0, done: 0, ok: 0, failed: 0, skipped: 0,
  t0: Date.now(), tWork: null, spin: 0, active: false, timer: null,
  start() {
    if (!TTY) return;
    this.active = true;
    process.stdout.write("\x1b[?25l");           // hide cursor
    this.timer = setInterval(() => { this.spin++; this.draw(); }, 120);
    this.timer.unref();
  },
  stop() {
    if (!this.active) return;
    clearInterval(this.timer);
    this.active = false;
    process.stdout.write("\r\x1b[2K\x1b[?25h");
  },
  setPhase(p) {
    if (p === this.phase) return;
    this.phase = p;
    if (TTY) this.draw();
    else console.log(`… ${stripAnsi(p)}`);
  },
  log(line) {
    if (this.active) process.stdout.write(`\r\x1b[2K${line}\n`);
    else console.log(COLOR ? line : stripAnsi(line));
    if (this.active) this.draw();
  },
  line() {
    const cols = process.stdout.columns || 100;
    const frames = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
    const pct = this.total ? this.done / this.total : 0;
    const el = Date.now() - this.t0;
    let eta = "–";
    if (this.tWork && this.done > 0 && this.done < this.total) {
      eta = fmtDur(((Date.now() - this.tWork) / this.done) * (this.total - this.done));
    } else if (this.total && this.done >= this.total) eta = "0s";
    const counts = `${c.green(`✓${this.ok}`)} ${c.red(`✗${this.failed}`)} ${c.gray(`↷${this.skipped}`)}`;
    const head = `${c.cyan(frames[this.spin % frames.length])} ${c.bold(`${this.done}/${this.total}`)} ${String(Math.floor(pct * 100)).padStart(3)}% `;
    const tail = ` ${counts} ${c.gray(`${fmtDur(el)} · eta ${eta}`)} ${c.yellow(this.phase)}`;
    const fixed = stripAnsi(head).length + stripAnsi(tail).length;
    const w = Math.max(10, Math.min(40, cols - fixed - 2));
    const fill = Math.round(pct * w);
    const bar = c.green("█".repeat(fill)) + c.gray("░".repeat(w - fill));
    let s = head + bar + tail;
    // truncate visible width to the terminal (phase text is last, so it goes first)
    if (stripAnsi(s).length > cols - 1) {
      const over = stripAnsi(s).length - (cols - 1);
      const ph = this.phase.slice(0, Math.max(0, this.phase.length - over - 1)) + "…";
      s = head + bar + ` ${counts} ${c.gray(`${fmtDur(el)} · eta ${eta}`)} ${c.yellow(ph)}`;
    }
    return s;
  },
  draw() {
    if (!this.active) return;
    process.stdout.write(`\r\x1b[2K${this.line()}`);
  },
};

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}
function die(msg) {
  ui.stop();
  console.error(c.red(`✗ ${msg}`));
  process.exit(1);
}

// ============================================================ subprocesses =
const children = new Set();
let interrupted = false;

/** Run a command, capture output (also teed to a log file); never throws. */
function run(cmd, args, { cwd, env, log, onData } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const out = log ? createWriteStream(log) : null;
    let buf = "";
    const take = (d) => {
      const s = d.toString();
      buf += s;
      out?.write(s);
      onData?.(s, buf);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => { buf += `\n${e.message}`; });
    child.on("close", (code, signal) => {
      children.delete(child);
      out?.end();
      resolve({ code: code ?? (signal ? 130 : 1), out: buf });
    });
  });
}
const git = (...args) => execFileSync("git", ["-C", opt.src, ...args], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
const gitTry = (...args) => { try { return git(...args); } catch { return null; } };

// ============================================================ source repo ==
if (!existsSync(path.join(opt.src, ".git")) && !gitTry("rev-parse", "--git-dir")) {
  die(`--src ${opt.src} is not a git repository`);
}
opt.src = realpathSync(opt.src);
const GIT_COMMON = path.resolve(opt.src, git("rev-parse", "--git-common-dir").trim());
const WT = path.join(opt.src, ".claude", "worktrees", "_snapshots-build");

if (opt.clean) {
  if (existsSync(WT)) {
    gitTry("worktree", "remove", "--force", WT);
    if (existsSync(WT)) rmSync(WT, { recursive: true, force: true });
    gitTry("worktree", "prune");
    console.log(c.green(`✓ removed scratch worktree ${WT}`));
  } else console.log(c.gray(`nothing to clean (${WT} does not exist)`));
  process.exit(0);
}

/** Feed lines to `git cat-file --batch-check` in one process. */
function batchCheck(lines) {
  if (!lines.length) return [];
  const out = execFileSync("git", ["-C", opt.src, "cat-file", "--batch-check=%(objectname) %(objecttype)"],
    { input: lines.join("\n") + "\n", encoding: "utf8", maxBuffer: 1 << 28, stdio: ["pipe", "pipe", "pipe"] });
  return out.trimEnd().split("\n").map((l) => {
    const [sha, type] = l.split(" ");
    return type === "missing" || !type ? null : { sha, type };
  });
}

/**
 * Every (slug, tree) version reachable from branches and remote branches, with
 * every commit that changed tex/<slug>/ to that tree.
 */
function enumerate() {
  // slugs: every tex/<slug>/ that ever held a main.tex or main.mdx
  const names = git("log", "--full-history", "--branches", "--remotes", "--name-only", "--format=", "--", "tex").split("\n");
  const slugs = [...new Set(names.map((n) => /^tex\/([^/]+)\/main\.(?:tex|mdx)$/.exec(n)?.[1]).filter(Boolean))].sort();
  const pages = new Map();       // slug -> Map(tree -> version)
  const SEP = "\x1f";
  for (const slug of opt.only ? slugs.filter((s) => opt.only.has(s)) : slugs) {
    const log = git("log", "--full-history", "--branches", "--remotes", `--format=%H${SEP}%P${SEP}%aI${SEP}%an${SEP}%s`, "--", `tex/${slug}`)
      .split("\n").filter(Boolean).map((l) => {
        const [sha, parents, date, author, subject] = l.split(SEP);
        return { sha, date, subject, author, p1: parents.split(" ")[0] || null };
      });
    // --full-history keeps side branches that were created and deleted again
    // (ml-foundations) — default simplification would hide them — but it also
    // lists merges; a merge counts only where it changed the folder relative
    // to its FIRST parent (a PR landing, or main merged into a branch).
    const q = [];
    for (const cm of log) q.push(`${cm.sha}:tex/${slug}`, `${cm.sha}:tex/${slug}/main.tex`, `${cm.sha}:tex/${slug}/main.mdx`, `${cm.p1 ?? "0000000"}:tex/${slug}`);
    const res = batchCheck(q);
    const versions = new Map();
    log.forEach((cm, i) => {
      const [tree, tex, mdx, parent] = res.slice(i * 4, i * 4 + 4);
      delete cm.p1;
      if (!tree || tree.type !== "tree" || (!tex && !mdx)) return;   // deleted, or no sheet yet
      if (parent?.sha === tree.sha) return;                          // merge that changed nothing here
      let v = versions.get(tree.sha);
      if (!v) versions.set(tree.sha, (v = { slug, tree: tree.sha, commits: [] }));
      v.commits.push(cm);
    });
    for (const v of versions.values()) {
      v.commits.sort((a, b) => b.date.localeCompare(a.date));
      v.latest = v.commits[0].date;
      v.earliest = v.commits[v.commits.length - 1];
    }
    if (versions.size) pages.set(slug, versions);
  }
  if (opt.only) for (const s of opt.only) if (!pages.has(s)) ui.log(c.yellow(`⚠ --only: no versions of "${s}" on any branch`));
  return pages;
}

// ============================================================ index.json ===
function loadIndex() {
  try { return JSON.parse(readFileSync(INDEX, "utf8")); }
  catch { return { pages: {} }; }
}
const htmlPath = (slug, tree) => path.join(SNAP, slug, `${tree}.html`);

let INDEX_DATA = loadIndex();
INDEX_DATA.pages ??= {};
let PIPELINE = null;

/** Merge enumeration + results into index.json (atomically). */
function writeIndex(pages, results) {
  const out = { generatedAt: new Date().toISOString(), pipelineCommit: PIPELINE ?? INDEX_DATA.pipelineCommit ?? null, pages: {} };
  const slugs = new Set([...Object.keys(INDEX_DATA.pages), ...pages.keys()]);
  for (const slug of [...slugs].sort()) {
    const byTree = new Map();
    for (const v of INDEX_DATA.pages[slug]?.versions ?? []) byTree.set(v.tree, { ...v });
    for (const v of pages.get(slug)?.values() ?? []) {
      const r = results.get(`${slug}@${v.tree}`);
      const prev = byTree.get(v.tree);
      const status = r?.status ?? (existsSync(htmlPath(slug, v.tree)) ? "ok" : prev?.status);
      if (!status) continue;                              // not built yet
      const e = { tree: v.tree, status };
      const err = r ? r.error : prev?.error;
      if (status === "failed" && err) e.error = err;
      const pipe = r?.pipeline ?? prev?.pipeline;
      if (pipe) e.pipeline = pipe;
      // union of commits (a branch deleted since still keeps its record)
      const cm = new Map((prev?.commits ?? []).map((x) => [x.sha, x]));
      for (const x of v.commits) cm.set(x.sha, x);
      e.commits = [...cm.values()].sort((a, b) => b.date.localeCompare(a.date));
      byTree.set(v.tree, e);
    }
    // an "ok" whose HTML is gone is no longer ok
    for (const [t, e] of byTree) if (e.status === "ok" && !existsSync(htmlPath(slug, t))) byTree.delete(t);
    const versions = [...byTree.values()].sort((a, b) => (b.commits[0]?.date ?? "").localeCompare(a.commits[0]?.date ?? ""));
    if (versions.length) out.pages[slug] = { versions };
  }
  const tmp = `${INDEX}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  renameSync(tmp, INDEX);
  INDEX_DATA = out;
}

// ============================================================ frontmatter ==
let KNOWN_KEYS = null;
function loadKnownKeys() {
  const src = readFileSync(path.join(WT, "scripts", "tex2mdx", "shims.mjs"), "utf8");
  const m = /KNOWN_FRONT_KEYS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  if (!m) die("could not find KNOWN_FRONT_KEYS in scripts/tex2mdx/shims.mjs");
  const body = m[1].replace(/\/\/.*$/gm, "");
  KNOWN_KEYS = new Set([...body.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]));
}

/**
 * Keep only known top-level keys (with their continuation lines), then force
 * `unlisted: true`. `lines` are YAML lines without comment prefixes.
 */
function filterYaml(lines) {
  const keep = [];
  const dropped = [];
  let keeping = true;
  for (const l of lines) {
    const km = /^([A-Za-z_][\w-]*)\s*:/.exec(l);
    if (km) {
      keeping = KNOWN_KEYS.has(km[1]) && km[1] !== "unlisted";
      if (!keeping && km[1] !== "unlisted") dropped.push(km[1]);
    }
    if (keeping) keep.push(l);
  }
  keep.push("unlisted: true");
  return { lines: keep, dropped };
}

function fixFrontmatter(dir) {
  const tex = path.join(dir, "main.tex");
  const mdx = path.join(dir, "main.mdx");
  if (existsSync(tex)) {
    const raw = readFileSync(tex, "utf8");
    const open = /^%---\s*iliad\s*-*\s*$/m.exec(raw);
    const close = open ? /^%---\s*end\s*-*\s*$/m.exec(raw.slice(open.index)) : null;
    if (!open || !close) {
      writeFileSync(tex, `%--- iliad ---\n% unlisted: true\n%--- end ---\n${raw}`);
      return [];
    }
    const bodyStart = open.index + open[0].length + 1;
    const bodyEnd = open.index + close.index;
    const inner = raw.slice(bodyStart, bodyEnd).split("\n");
    const yaml = [];
    const other = [];
    for (const l of inner) {
      if (/^%/.test(l)) yaml.push(l.replace(/^%[ \t]?/, ""));
      else other.push(l);        // blank lines only (anything else would be a converter warning anyway)
    }
    const { lines, dropped } = filterYaml(yaml);
    const block = lines.map((l) => `% ${l}`.replace(/\s+$/, "")).join("\n") + "\n";
    writeFileSync(tex, raw.slice(0, bodyStart) + block + raw.slice(bodyEnd));
    return dropped;
  }
  if (existsSync(mdx)) {
    const raw = readFileSync(mdx, "utf8");
    const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
    if (!m) { writeFileSync(mdx, `---\nunlisted: true\n---\n${raw}`); return []; }
    const { lines, dropped } = filterYaml(m[1].split("\n"));
    writeFileSync(mdx, `---\n${lines.join("\n")}\n---\n${raw.slice(m[0].length)}`);
    return dropped;
  }
  return [];
}

// ============================================================ worktree =====
function nodeBin() {
  const ok = (bin) => {
    try { return parseInt(execFileSync(path.join(bin, "node"), ["-p", "process.versions.node"], { encoding: "utf8" }), 10) >= 20; }
    catch { return false; }
  };
  const cands = [];
  if (process.env.NODE22) cands.push(process.env.NODE22.replace(/\/node$/, ""));
  const nvm = path.join(os.homedir(), ".nvm", "versions", "node");
  if (existsSync(nvm)) {
    const vs = readdirSync(nvm).filter((v) => /^v\d+\./.test(v) && parseInt(v.slice(1), 10) >= 20)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    // v22 first (the repo's .nvmrc), then anything newer/older that is >= 20
    for (const v of [...vs.filter((x) => x.startsWith("v22.")), ...vs]) cands.push(path.join(nvm, v, "bin"));
  }
  cands.push(path.dirname(process.execPath));
  const hit = cands.find(ok);
  if (!hit) die("need Node >= 20 for next build: install it with nvm (nvm install 22) or set NODE22=/path/to/bin");
  return hit;
}

function ensureWorktree() {
  const want = git("rev-parse", `${opt.ref}^{commit}`).trim();
  if (existsSync(WT) && !existsSync(path.join(WT, ".git"))) die(`${WT} exists but is not a git worktree — remove it or run --clean`);
  if (!existsSync(WT)) {
    ui.setPhase("creating scratch worktree");
    mkdirSync(path.dirname(WT), { recursive: true });
    git("worktree", "add", "--detach", WT, want);
  } else {
    const have = execFileSync("git", ["-C", WT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    // put any leftovers (a pass-2 iliad.sty) back, then move to the wanted pipeline
    execFileSync("git", ["-C", WT, "checkout", "--force", "--detach", want], { stdio: "ignore" });
    if (have !== want) ui.log(c.gray(`  scratch worktree moved ${have.slice(0, 10)} → ${want.slice(0, 10)}`));
  }
  for (const rel of ["node_modules", "scripts/tex2mdx/node_modules"]) {
    const srcNm = path.join(opt.src, rel);
    if (!existsSync(srcNm)) die(`${srcNm} is missing — run npm ci in the source repo first`);
    const real = realpathSync(srcNm);
    const link = path.join(WT, rel);
    let isLink = false;
    try { isLink = lstatSync(link).isSymbolicLink(); } catch { /* absent */ }
    if (isLink && realpathSync(link) === real) continue;
    if (isLink) unlinkSync(link);
    else if (existsSync(link)) continue;             // a real install: leave it
    symlinkSync(real, link);
  }
  return want;
}

const aliasOf = (v) => `${v.slug}--${v.tree.slice(0, 10)}`;

/** Remove everything a batch left in the scratch worktree. */
function cleanAliases(aliases) {
  for (const a of aliases) {
    for (const p of [
      path.join(WT, "tex", a),
      path.join(WT, "content", "modules", `${a}.mdx`),
      path.join(WT, "public", "downloads", a),
      path.join(WT, "public", "uploads", a),
    ]) rmSync(p, { recursive: true, force: true });
  }
  rmSync(path.join(WT, "out"), { recursive: true, force: true });
}
/** Remove stray aliases from an earlier interrupted run (they would be rebuilt). */
function cleanStrays() {
  const stray = new Set();
  const scan = (dir, strip = "") => {
    try { for (const n of readdirSync(dir)) if (/--[0-9a-f]{10}(\.mdx)?$/.test(n)) stray.add(n.replace(strip, "")); } catch { /* none */ }
  };
  scan(path.join(WT, "tex"));
  scan(path.join(WT, "content", "modules"), /\.mdx$/);
  scan(path.join(WT, "public", "downloads"));
  scan(path.join(WT, "public", "uploads"));
  cleanAliases([...stray]);
  execFileSync("git", ["-C", WT, "checkout", "--", "tex/iliad.sty"], { stdio: "ignore" });
}

/** LFS pointers in an archive → the real object from the local LFS store, when present. */
function resolveLfs(dir) {
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (st.size > 400) continue;
      const txt = readFileSync(p, "utf8");
      const m = /^version https:\/\/git-lfs[^\n]*\noid sha256:([0-9a-f]{64})/.exec(txt);
      if (!m) continue;
      const obj = path.join(GIT_COMMON, "lfs", "objects", m[1].slice(0, 2), m[1].slice(2, 4), m[1]);
      if (existsSync(obj)) copyFileSync(obj, p);
    }
  };
  walk(dir);
}

/** The iliad.sty a version was written against: its own copy, else the repo's at its commit. */
function styBlobOf(v) {
  const [local, shared] = batchCheck([`${v.tree}:iliad.sty`, `${v.earliest.sha}:tex/iliad.sty`]);
  return (local ?? shared)?.sha ?? null;
}

async function extract(v) {
  const alias = aliasOf(v);
  const dest = path.join(WT, "tex", alias);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  // archive the folder's own tree: its contents land at the archive root
  await new Promise((resolve, reject) => {
    const ga = spawn("git", ["-C", opt.src, "archive", "--format=tar", v.tree], { stdio: ["ignore", "pipe", "pipe"] });
    const tar = spawn("tar", ["-x", "-C", dest], { stdio: ["pipe", "ignore", "pipe"] });
    ga.stdout.pipe(tar.stdin);
    let err = "";
    ga.stderr.on("data", (d) => { err += d; });
    tar.stderr.on("data", (d) => { err += d; });
    tar.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git archive | tar failed: ${err.trim()}`))));
  });
  resolveLfs(dest);
  // Old sheets \usepackage{iliad} from their own folder (a per-sheet copy),
  // but build-content refuses a per-sheet copy that differs from the shared
  // tex/iliad.sty. So every sheet gets a copy of whatever the shared one holds
  // right now — pass 1: today's; pass 2: the one the version was written for.
  copyFileSync(path.join(WT, "tex", "iliad.sty"), path.join(dest, "iliad.sty"));
  for (const junk of [".build-hash"]) rmSync(path.join(dest, junk), { force: true });
  return fixFrontmatter(dest);
}

// ============================================================ build ========
let NODE_BIN = null;
const buildEnv = () => {
  const env = { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH}`, NEXT_PUBLIC_BASE_PATH: "", NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" };
  for (const k of ["PREVIEW_ONLY", "NEXT_PUBLIC_PREVIEW_PR", "PREVIEW_CHANGED_SLUGS", "PREVIEW_FULL", "NEXT_PUBLIC_DIFF_BASE", "CI_SLUGS"]) delete env[k];
  return env;
};

/** Split build-content output into per-alias ✗ blocks. */
function parseFailures(out, aliases) {
  const set = new Set(aliases);
  const fails = new Map();
  let cur = null;
  for (const line of out.split("\n")) {
    const m = /^(✗|▸|↷|✓) ([^\s:]+)/.exec(line);
    if (m) {
      cur = m[1] === "✗" && set.has(m[2]) ? m[2] : null;
      if (cur) fails.set(cur, [line.replace(/^✗ [^:]+:\s*/, "")]);
      continue;
    }
    if (cur) fails.get(cur).push(line);
  }
  const res = new Map();
  for (const [a, lines] of fails) res.set(a, lines.join("\n").trim());
  return res;
}

/** One short line out of a long error. */
function reason(err) {
  const lines = err.split("\n").map((l) => l.trim()).filter(Boolean);
  const mdx = lines.findIndex((l) => /error compiling MDX/.test(l));
  if (mdx >= 0 && lines[mdx + 1]) return `MDX: ${lines[mdx + 1]}`.slice(0, 160);
  const e = lines.findIndex((l) => /^ERROR/.test(l));
  if (e >= 0 && /^- /.test(lines[e + 1] ?? "")) return lines[e + 1].replace(/^-\s*/, "").replace(/\s{2,}/g, "  ").slice(0, 160);
  const pick = lines.find((l) => /^! /.test(l))
    ?? lines.find((l) => /^(ERROR|error)/.test(l))
    ?? lines.find((l) => /^- \S+:\d+/.test(l))
    ?? lines.find((l) => /^\s*-\s/.test(l) && !/^NOTE/.test(l))
    ?? lines[0] ?? "unknown error";
  const first = lines[0] && lines[0] !== pick ? `${lines[0].replace(/\s*\(see [^)]*\):?$/, "")}: ` : "";
  return (first + pick.replace(/^-\s*/, "")).slice(0, 160);
}

/** The first TeX error (`! …` plus context) in a sheet's main.log, if any. */
function texErrorOf(dir) {
  try {
    const lines = readFileSync(path.join(dir, "main.log"), "latin1").split("\n");
    const i = lines.findIndex((l) => l.startsWith("!"));
    if (i < 0) return null;
    return lines.slice(i, i + 6).filter((l) => l.trim()).join("\n");
  } catch { return null; }
}

const truncate = (s, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s);

let batchNo = 0;
/**
 * Build one batch against whatever tex/iliad.sty currently holds.
 * Returns Map(key -> {status, error}) for every version in the batch.
 */
async function buildBatch(batch, label) {
  const n = ++batchNo;
  const res = new Map();
  const aliases = batch.map(aliasOf);
  const logBase = path.join(LOGS, `batch-${String(n).padStart(3, "0")}`);
  const T = {};
  let tp = Date.now();
  const lap = (k) => { T[k] = (T[k] ?? 0) + Date.now() - tp; tp = Date.now(); };
  try {
    // 1. extract
    ui.setPhase(`${label}: extracting`);
    const byAlias = new Map();
    for (const v of batch) {
      if (interrupted) return res;
      const dropped = await extract(v);
      byAlias.set(aliasOf(v), v);
      if (dropped.length) v.dropped = dropped;
    }
    lap("extract");
    // 2. convert
    ui.setPhase(`${label}: converting (0/${batch.length})`);
    const seen = new Set();
    const bc = await run(NODE_BIN + "/node", ["scripts/build-content.mjs", "--check", "--no-gate", "--jobs", String(opt.jobs), ...aliases], {
      cwd: WT, env: buildEnv(), log: `${logBase}-content.log`,
      onData: (_s, buf) => {
        for (const m of buf.matchAll(/^✗ (\S+?):/gm)) seen.add(m[1]);
        for (const a of aliases) if (existsSync(path.join(WT, "content", "modules", `${a}.mdx`))) seen.add(a);
        ui.setPhase(`${label}: converting (${Math.min(seen.size, batch.length)}/${batch.length})`);
      },
    });
    lap("convert");
    if (interrupted) return res;
    const fails = parseFailures(bc.out, aliases);
    const good = [];
    for (const a of aliases) {
      const v = byAlias.get(a);
      const mdx = path.join(WT, "content", "modules", `${a}.mdx`);
      if (fails.has(a) || !existsSync(mdx)) {
        let err = fails.get(a) || `no MDX produced (build-content exit ${bc.code}):\n${bc.out.slice(-1500)}`;
        // "pdflatex failed" says nothing on its own: add the TeX error itself
        const texErr = texErrorOf(path.join(WT, "tex", a));
        if (texErr) err += `\n\npdflatex (main.log):\n${texErr}`;
        res.set(`${v.slug}@${v.tree}`, { status: "failed", error: truncate(err.replaceAll(a, v.slug)) });
        rmSync(mdx, { force: true });
      } else good.push(a);
    }
    if (!good.length) return res;

    // 3. next build (dropping pages that break it, then one at a time)
    let pending = [...good];
    let attempt = 0;
    let built = [];
    while (pending.length && !interrupted) {
      attempt++;
      ui.setPhase(`${label}: next build${attempt > 1 ? ` (retry ${attempt - 1})` : ""} · ${pending.length} page${pending.length === 1 ? "" : "s"}`);
      rmSync(path.join(WT, "out"), { recursive: true, force: true });
      const nb = await run(path.join(NODE_BIN, "node"), [path.join(WT, "node_modules", "next", "dist", "bin", "next"), "build"], {
        cwd: WT, env: buildEnv(), log: `${logBase}-next-${attempt}.log`,
      });
      if (interrupted) return res;
      if (nb.code === 0) { built = pending; break; }
      const outLines = nb.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
      const guilty = pending.filter((a) => outLines.some((l) => l.includes(`prerendering page "/page/${a}"`)));
      const blame = guilty.length ? guilty : pending.length === 1 ? pending : null;
      if (blame) {
        for (const a of blame) {
          const v = byAlias.get(a);
          // the prerender error block for this page, else the tail of the log
          const i = outLines.findIndex((l) => l.includes(`prerendering page "/page/${a}"`));
          let block = "";
          if (i >= 0) {
            const end = outLines.findIndex((l, j) => j > i && /^Export encountered|^\S*⨯/.test(l));
            block = outLines.slice(i, end > i ? end : i + 15).join("\n");
          }
          res.set(`${v.slug}@${v.tree}`, { status: "failed", stage: "next", error: truncate(`next build failed:\n${(block || outLines.slice(-40).join("\n")).replaceAll(a, v.slug)}`) });
          rmSync(path.join(WT, "content", "modules", `${a}.mdx`), { force: true });
        }
        pending = pending.filter((a) => !blame.includes(a));
        continue;
      }
      // cannot tell who broke it: build them one by one
      ui.log(c.yellow(`  ⚠ next build failed for the whole batch and names no page — building ${pending.length} pages one at a time`));
      for (const a of pending) rmSync(path.join(WT, "content", "modules", `${a}.mdx`), { force: true });
      const solo = [...pending];
      pending = [];
      for (const a of solo) {
        if (interrupted) return res;
        const v = byAlias.get(a);
        // re-extracted MDX is gone; rebuild just this one
        const sub = await buildBatch([v], `${label} · solo ${v.slug}`);
        for (const [k, r] of sub) res.set(k, r);
      }
      return res;
    }
    lap("next build");
    if (interrupted || !built.length) return res;

    // 4. strip hydration (what the live site serves) + save
    ui.setPhase(`${label}: saving`);
    const strip = await run(path.join(NODE_BIN, "node"), ["scripts/strip-hydration.mjs"], { cwd: WT, env: buildEnv(), log: `${logBase}-strip.log` });
    if (strip.code !== 0) ui.log(c.yellow(`  ⚠ strip-hydration failed (${logBase}-strip.log) — saving the unstripped pages`));
    for (const a of built) {
      const v = byAlias.get(a);
      const key = `${v.slug}@${v.tree}`;
      const page = path.join(WT, "out", "page", a, "index.html");
      if (!existsSync(page)) {
        res.set(key, { status: "failed", error: `next build produced no out/page/${v.slug}/index.html` });
        continue;
      }
      const html = readFileSync(page, "utf8").replaceAll(a, v.slug);
      if (!/class="prose/.test(html)) {
        res.set(key, { status: "failed", error: "rendered page has no .prose article" });
        continue;
      }
      mkdirSync(path.join(SNAP, v.slug), { recursive: true });
      const tmp = `${htmlPath(v.slug, v.tree)}.tmp`;
      writeFileSync(tmp, html);
      renameSync(tmp, htmlPath(v.slug, v.tree));
      res.set(key, { status: "ok" });
    }
    lap("save");
    return res;
  } finally {
    cleanAliases(aliases);
    const parts = Object.entries(T).map(([k, ms]) => `${k} ${fmtDur(ms)}`);
    if (parts.length && !interrupted) ui.log(c.gray(`  ${label} · ${batch.length} version${batch.length === 1 ? "" : "s"} · ${parts.join(" · ")}`));
  }
}

// ============================================================ main =========
async function main() {
  ui.start();
  ui.setPhase("enumerating");
  const pages = enumerate();
  const all = [...pages.values()].flatMap((m) => [...m.values()]);
  const failedBefore = new Set();
  for (const [slug, p] of Object.entries(INDEX_DATA.pages)) for (const v of p.versions ?? []) if (v.status === "failed") failedBefore.add(`${slug}@${v.tree}`);

  const state = (v) => existsSync(htmlPath(v.slug, v.tree)) ? "ok"
    : failedBefore.has(`${v.slug}@${v.tree}`) ? "failed" : "todo";

  if (opt.dryRun) {
    ui.stop();
    printDryRun(pages, state);
    return 0;
  }

  const todo = all
    .filter((v) => state(v) === "todo" || (opt.retryFailed && state(v) === "failed"))
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, opt.limit);
  ui.skipped = all.length - all.filter((v) => state(v) === "todo" || (opt.retryFailed && state(v) === "failed")).length;
  ui.total = todo.length;
  ui.log(`${c.bold("iliad snapshots")} ${c.gray("·")} ${pages.size} pages, ${all.length} versions ${c.gray("·")} ${c.cyan(`${todo.length} to build`)}, ${ui.skipped} already done`);
  if (!todo.length) {
    ui.stop();
    console.log(c.green("✓ nothing to do — every version is built (or recorded as failed; --retry-failed to retry)"));
    writeIndex(pages, new Map());
    return 0;
  }

  mkdirSync(LOGS, { recursive: true });
  NODE_BIN = nodeBin();
  PIPELINE = ensureWorktree();
  cleanStrays();
  loadKnownKeys();
  ui.log(c.gray(`  pipeline ${PIPELINE.slice(0, 10)} · worktree ${path.relative(process.cwd(), WT) || WT} · node ${NODE_BIN}`));
  ui.log(c.gray(`  logs in ${LOGS}`));

  const results = new Map();
  const currentSty = git("rev-parse", `${PIPELINE}:tex/iliad.sty`).trim();
  const retry = [];                // pass-2 candidates
  const summary = new Map();       // slug -> {ok, failed}
  ui.tWork = Date.now();

  const finish = (v, r, final) => {
    const key = `${v.slug}@${v.tree}`;
    r.pipeline = PIPELINE;
    results.set(key, r);
    const s = summary.get(v.slug) ?? { ok: 0, failed: 0, reasons: new Map() };
    summary.set(v.slug, s);
    ui.done++;
    const tag = `${v.slug}${c.gray("@")}${v.tree.slice(0, 10)}`;
    const when = c.gray(v.latest.slice(0, 10));
    const note = final ? c.magenta(` [${final}]`) : "";
    const dropped = v.dropped?.length ? c.gray(` (dropped front keys: ${v.dropped.join(", ")})`) : "";
    if (r.status === "ok") {
      ui.ok++; s.ok++;
      ui.log(`${c.green("✓")} ${tag} ${when}${note}${dropped}`);
    } else {
      ui.failed++; s.failed++;
      const why = r.reason ?? reason(r.error ?? "");
      s.reasons.set(why, (s.reasons.get(why) ?? 0) + 1);
      ui.log(`${c.red("✗")} ${tag} ${when}${note} ${c.red(why)}`);
    }
  };

  // ---- pass 1: today's iliad.sty
  const batches1 = chunk(todo, opt.batch);
  for (let i = 0; i < batches1.length && !interrupted; i++) {
    const b = batches1[i];
    const res = await buildBatch(b, `batch ${i + 1}/${batches1.length}`);
    for (const v of b) {
      const r = res.get(`${v.slug}@${v.tree}`);
      if (!r) continue;                                  // interrupted
      if (r.status === "failed" && r.stage !== "next") {   // a sty cannot fix MDX that next rejects
        const sty = styBlobOf(v);
        if (sty && sty !== currentSty) { retry.push({ v, sty, err: r }); continue; }
      }
      finish(v, r);
    }
    writeIndex(pages, results);
  }

  // ---- pass 2: each failure against the iliad.sty it was written for
  if (retry.length && !interrupted) {
    const groups = new Map();
    for (const x of retry) groups.set(x.sty, [...(groups.get(x.sty) ?? []), x]);
    ui.log(c.cyan(`↻ pass 2: retrying ${retry.length} failure${retry.length === 1 ? "" : "s"} with their own iliad.sty (${groups.size} variant${groups.size === 1 ? "" : "s"})`));
    const styFile = path.join(WT, "tex", "iliad.sty");
    const jobs = [...groups].flatMap(([sty, xs]) => chunk(xs, opt.batch).map((b) => ({ sty, b })));
    for (let i = 0; i < jobs.length && !interrupted; i++) {
      const { sty, b } = jobs[i];
      writeFileSync(styFile, git("cat-file", "blob", sty));
      try {
        const res = await buildBatch(b.map((x) => x.v), `pass 2 · batch ${i + 1}/${jobs.length} (sty ${sty.slice(0, 7)})`);
        for (const x of b) {
          const r = res.get(`${x.v.slug}@${x.v.tree}`);
          if (!r) continue;
          if (r.status === "failed") r.reason = reason(r.error);
          if (r.status === "failed") r.error = `with today's iliad.sty:\n${x.err.error}\n\nwith its own iliad.sty (${sty.slice(0, 10)}):\n${r.error}`;
          finish(x.v, r, `own sty ${sty.slice(0, 7)}`);
        }
      } finally {
        execFileSync("git", ["-C", WT, "checkout", "--", "tex/iliad.sty"], { stdio: "ignore" });
      }
      writeIndex(pages, results);
    }
  }

  writeIndex(pages, results);
  ui.stop();
  printSummary(summary);
  if (interrupted) {
    console.log(c.yellow(`⏸ interrupted — ${ui.done}/${ui.total} done; run the same command again to resume`));
    return 130;
  }
  return ui.failed ? 2 : 0;
}

function chunk(xs, n) {
  const out = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
const pad = (s, n, right = false) => {
  const len = stripAnsi(String(s)).length;
  const sp = " ".repeat(Math.max(0, n - len));
  return right ? sp + s : s + sp;
};

function printDryRun(pages, state) {
  const rows = [];
  let T = { n: 0, ok: 0, failed: 0, todo: 0 };
  for (const [slug, m] of [...pages].sort()) {
    const vs = [...m.values()];
    const r = { slug, n: vs.length, ok: 0, failed: 0, todo: 0, first: vs.map((v) => v.earliest.date).sort()[0], last: vs.map((v) => v.latest).sort().at(-1), commits: vs.reduce((a, v) => a + v.commits.length, 0) };
    for (const v of vs) r[state(v)]++;
    rows.push(r);
    for (const k of ["n", "ok", "failed", "todo"]) T[k] += r[k];
  }
  const w = Math.max(5, ...rows.map((r) => r.slug.length));
  console.log(c.bold(`${pad("slug", w)}  ${pad("versions", 8, true)}  ${pad("commits", 7, true)}  ${pad("built", 5, true)}  ${pad("failed", 6, true)}  ${pad("to build", 8, true)}  history`));
  for (const r of rows) {
    console.log(`${pad(r.slug, w)}  ${pad(r.n, 8, true)}  ${pad(c.gray(r.commits), 7, true)}  ${pad(r.ok ? c.green(r.ok) : c.gray(0), 5, true)}  ${pad(r.failed ? c.red(r.failed) : c.gray(0), 6, true)}  ${pad(r.todo ? c.cyan(r.todo) : c.gray(0), 8, true)}  ${c.gray(`${r.first.slice(0, 10)} → ${r.last.slice(0, 10)}`)}`);
  }
  console.log(c.bold(`${pad(`${rows.length} pages`, w)}  ${pad(T.n, 8, true)}  ${pad("", 7)}  ${pad(c.green(T.ok), 5, true)}  ${pad(c.red(T.failed), 6, true)}  ${pad(c.cyan(T.todo), 8, true)}`));
  const todoN = T.todo + (opt.retryFailed ? T.failed : 0);
  const n = Math.min(todoN, opt.limit);
  console.log(c.gray(`\n${n} version${n === 1 ? "" : "s"} would be built this run in ${Math.ceil(n / opt.batch)} batch${Math.ceil(n / opt.batch) === 1 ? "" : "es"} of ≤${opt.batch}.`));
}

function printSummary(summary) {
  if (!summary.size) return;
  const rows = [...summary].sort();
  const w = Math.max(5, ...rows.map(([s]) => s.length));
  console.log("\n" + c.bold(`${pad("slug", w)}  ${pad("ok", 4, true)}  ${pad("failed", 6, true)}  top failure reason`));
  for (const [slug, s] of rows) {
    const top = [...s.reasons].sort((a, b) => b[1] - a[1])[0];
    console.log(`${pad(slug, w)}  ${pad(s.ok ? c.green(s.ok) : c.gray(0), 4, true)}  ${pad(s.failed ? c.red(s.failed) : c.gray(0), 6, true)}  ${top ? c.gray(`${top[1]}× ${top[0]}`.slice(0, 110)) : ""}`);
  }
  const el = Date.now() - ui.t0;
  const per = ui.done ? fmtDur((Date.now() - (ui.tWork ?? ui.t0)) / ui.done) : "–";
  console.log(c.bold(`\n${c.green(`✓ ${ui.ok} ok`)}  ${c.red(`✗ ${ui.failed} failed`)}  ${c.gray(`↷ ${ui.skipped} skipped`)}  in ${fmtDur(el)} (${per}/version)`));
  console.log(c.gray(`index: ${INDEX}   (errors in full: pages.<slug>.versions[].error)`));
}

// ============================================================ signals ======
async function shutdown() {
  for (const ch of children) { try { process.kill(-ch.pid, "SIGTERM"); } catch { /* gone */ } }
}
process.on("SIGINT", () => {
  if (interrupted) {                     // second Ctrl-C: out now
    ui.stop();
    for (const ch of children) { try { process.kill(-ch.pid, "SIGKILL"); } catch { /* gone */ } }
    console.error(c.red("\n✗ aborted"));
    process.exit(130);
  }
  interrupted = true;
  ui.log(c.yellow("⏸ Ctrl-C — stopping after cleanup (press again to abort immediately)"));
  shutdown();
});
process.on("SIGTERM", () => { interrupted = true; shutdown(); });

main().then((code) => {
  try { if (existsSync(WT)) cleanStrays(); } catch { /* best effort */ }
  process.exit(code);
}).catch((e) => {
  ui.stop();
  console.error(c.red(`✗ ${e.stack ?? e}`));
  try { if (existsSync(WT)) cleanStrays(); } catch { /* best effort */ }
  process.exit(1);
});
