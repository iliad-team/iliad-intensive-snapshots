# iliad-snapshots

Every historical version of every worksheet page of
[iliad-intensive](https://github.com/iliad-team/iliad-intensive), rendered to
HTML with **today's** pipeline. The site's `/dev/diff` page reads these files
and uses `public/diff.js` to diff any two versions of a page side by side. That
script diffs the rendered article, `main article .prose`.

## Layout

```
<slug>/<tree>.html   one page version; <tree> = git tree hash of tex/<slug>/
index.json           what exists, and which commits produced each version
backfill.mjs         the one-off local backfill that renders the history
```

`index.json`:

```js
{ generatedAt, pipelineCommit,            // pipeline = iliad-intensive commit that rendered
  pages: { <slug>: { versions: [          // newest first, by latest commit date
    { tree, status: "ok" | "failed", error?, pipeline,
      commits: [ { sha, date, subject, author } ] }   // every commit that produced this tree
  ] } } }
```

A version is a distinct `(slug, tree of tex/<slug>/)` pair. The enumeration
covers every local and remote-tracking branch (`--branches --remotes`, never
`--all`, because `refs/stash` is shared between sessions) and uses
`--full-history`, so it also finds folders a side branch created and later
deleted (`ml-foundations`, `practical-ml`). A merge commit counts only when it
changed the folder relative to its first parent, which is when a PR lands.

## Running the backfill

Requirements: the source repo checked out next to this folder with
`npm ci` done (both `node_modules`, root and `scripts/tex2mdx/`), plus TeX
Live. The script itself runs on any Node ≥ 18. The builds it spawns need
Node ≥ 20: it picks `~/.nvm/versions/node/v22*`, or set `NODE22=/path/to/bin`.

```sh
cd ~/Dropbox/ILIAD/iliad-intensive-snapshots
node backfill.mjs --dry-run            # per-slug table: versions, built, failed, to build
node backfill.mjs --limit 5            # trial: the 5 newest unbuilt versions
node backfill.mjs                      # everything (resumable; Ctrl-C is safe)
node backfill.mjs --retry-failed       # after a pipeline fix: retry recorded failures
node backfill.mjs --only aixi,qft      # just some slugs
node backfill.mjs --clean              # remove the scratch worktree
```

| flag | |
|---|---|
| `--src <path>` | source repo (default `../iliad-intensive`) |
| `--ref <rev>` | pipeline revision to build with (default: source repo `HEAD`) |
| `--only a,b` | only these slugs |
| `--limit N` | at most N versions this run |
| `--batch N` | versions per `next build` (default 25) |
| `--jobs N` | parallel sheets inside `build-content` (default: CPU count) |
| `--retry-failed` | also retry versions recorded as failed |
| `--dry-run` | enumerate only |
| `--clean` | remove the scratch worktree and exit |

**Resuming.** A version is skipped when its `.html` exists, or when
`index.json` records it as failed (unless you pass `--retry-failed`). The index
is rewritten after every batch, so Ctrl-C loses at most one batch. The first
Ctrl-C stops cleanly and a second aborts at once. To re-render a version that
built fine, for example after a pipeline change, delete its `.html` or its
slug folder and run the script again.

## How a version is rendered

The script only reads the source repo, using `git log`, `ls-tree`, `cat-file`
and `archive`, and `git worktree add` for one scratch worktree at
`<src>/.claude/worktrees/_snapshots-build/`. That path is gitignored, and it
has to sit inside the repo: Turbopack panics when a symlinked `node_modules`
points outside its root. The worktree's `node_modules` are symlinks to the
source repo's. It is reused between runs and moved to `--ref` at the start of
each run. Nothing in the main checkout's working tree is touched.

For each batch:

1. `git archive <tree>` into `tex/<slug>--<tree10>/`. LFS pointers are
   replaced from the local LFS store when the object exists there.
2. Fix up the frontmatter: drop every key that today's `KNOWN_FRONT_KEYS`
   (`scripts/tex2mdx/shims.mjs`) does not know, including `cluster`, `day` and
   `learningOutcomes` with their continuation lines, and add `unlisted: true`.
   The page is not in `schedule.yaml`. If there is no block, one is created.
3. Put a copy of the shared `tex/iliad.sty` in the sheet folder. Old sheets
   `\usepackage{iliad}` from their own folder, and `build-content` refuses a
   per-sheet copy that differs from the shared one.
4. `node scripts/build-content.mjs --check --no-gate --jobs N <aliases…>`.
   This runs the converter plus one best-effort pdflatex pass for the `.aux`,
   with no PDFs, decks or downloads. A version fails if it prints
   `✗ <alias>` or leaves no `content/modules/<alias>.mdx`.
5. `next build`. The page is at `out/page/<alias>/index.html`, because an
   unscheduled page has no cluster. If one page breaks the build, for example
   with MDX that does not compile, that page is marked failed and the build is
   retried without it.
6. `scripts/strip-hydration.mjs`, the same pass the live site gets. It drops
   the RSC payload, which is a second copy of the whole page. Then the alias
   is replaced by the real slug throughout the HTML and the page is saved as
   `<slug>/<tree>.html`.
7. The batch's aliases and `out/` are removed.

**Pass 2.** Versions that failed during conversion, and whose `iliad.sty`
differs from today's, are retried. The sty comes from the sheet's own copy in
its tree, or else from `tex/iliad.sty` at the version's earliest commit.
Retries are grouped by sty, and that sty is written into the scratch
worktree's `tex/iliad.sty` for the batch. MDX failures from `next build` are
not retried, since a sty cannot fix them.

Per-batch logs of every subprocess go to `.logs/` (gitignored).

## Limitations (v1)

- **No images or figures.** `public/uploads/<slug>/` (TikZ SVGs, `fig/`
  conversions) is not stored, so `<img>` tags in the snapshots point at
  `/uploads/<slug>/…` paths that may not exist, or may hold a newer figure.
- **Everything uses today's pipeline.** A historic version renders the way
  today's converter renders it, not the way it looked on the site back then.
  Frontmatter keys today's converter rejects (`learningOutcomes`, `cluster`,
  `day`) are dropped, so an old page's front-matter outcomes box is missing.
- `--check` builds do not stage downloads, so the snapshot pages show no
  PDF or download links.
- Some versions fail under today's pipeline, whether they are old or broken
  mid-branch. Each one is recorded with its error in `index.json`.
