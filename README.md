# Readings

A 3D bubble map of everything you read. Topics are glass bubbles, articles are pearls,
and lines connect them: thin ones to their parent topic, brighter ones (with drifting
particles) between related readings.

## Run it

```
npm install      # first time only
npm run dev      # opens http://localhost:4747
```

On Windows you can also double-click `Open Readings.cmd`.

## Use it

**Adding things:** press **+ add material** (or `a`) and pick PDF, Link or No file (for a
book or a talk). Title, authors and year are filled in when they can be detected; type over
anything. You can also drop a PDF or paste a link anywhere: it opens the same form.

| Do this | To |
| --- | --- |
| click a bubble | open a topic (like a folder) or an article's card |
| double-click a pearl / **read** | open the reader |
| drag a bubble onto a topic | move it there |
| shift-click a bubble (with an article open) | connect / disconnect them |
| right-click a bubble | add material here, rename, connect, move, hide from website, delete |
| `/` | search titles, authors, highlights and notes |
| `Esc` | back out one level |
| `n` | new topic |

**Reading:**

| Do this | To |
| --- | --- |
| select text → **highlight** (`H`) | highlight it |
| select text → **note** (`N`) | attach a note to that line (a dot appears in the margin) |
| click a highlight or margin dot | read or edit its note |
| **+ note** in the side panel | a note about the whole reading |
| `←` `→`, PgUp/PgDn, or the ‹ › pager | previous / next page |
| **focus** (`F`) | full screen, just the page. Click left/right of the page to turn it |
| **export** | this article's summary and notes as Markdown |

**export** in the bottom bar downloads all your notes and summaries (or one topic) as
Markdown, or a full JSON backup.

Double-click a breadcrumb to rename it. The address bar always points at what's open,
so you can link straight to an article.

## Your data

Everything lives in `data/`:

- `data/library.json`: topics, articles, connections, highlights, notes (plain JSON, git-friendly)
- `data/files/`: the PDFs and saved page text
- `data/backups/`: automatic snapshots (every 10 min while you edit, last 30 kept)
- `data/trash/`: files of deleted articles (nothing is hard-deleted)

## Publish to wearechintu.com/readings

Press **publish** in the bottom bar. It shows what will go up, then:

1. takes a fresh copy of the live site from GitHub (a private worktree in `.publish/`,
   never your own checkout of the site),
2. builds the public, read-only map,
3. swaps it into `public/readings-app/` and commits only that folder,
4. pushes it to `main`. Vercel rebuilds the site in about two minutes.

From a terminal, `npm run publish-site` does the same. Where the site lives is set in
`readings.config.json`.

What goes up, and what doesn't:

- Anything marked **Hide from website** (and everything inside it) stays on this computer.
- PDFs and saved web pages stay here unless you tick **Publish the PDF too** on that reading.
  Only do that for open-access material (for example CC BY). Free to read online is not the
  same as free to re-upload. Without it the site shows your summary, highlights and notes,
  and links to the source.

`npm run export-site -- <site folder>` builds and copies the map into a site checkout
without committing anything, for working on the site itself.

## This repository is public

It holds the app's code only. `.gitignore` keeps out `data/` (your library, PDFs, notes,
backups and trash) and `.publish/`. Your library is backed up automatically in
`data/backups/` on this computer.

## Code

```
server/library-plugin.ts   dev API (save, upload, fetch) + public build step
server/fetch-article.ts    link → PDF or clean text, plus arXiv / Crossref metadata
src/map/                   the 3D map (three.js via 3d-force-graph) and bubble shader
src/reader/                PDF + web reader, highlighting
src/ui/                    card, breadcrumbs, search, menus
src/store.ts               the library and every edit action
```
