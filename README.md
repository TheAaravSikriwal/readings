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
| shift-click a bubble | connect it to the open article, or to the topic you're in (click again to disconnect) |
| right-click a bubble | add material here, rename, connect, move, hide from website, delete |
| `/` | search titles, authors, highlights and notes |
| click empty space, or `Esc` | back out one level |
| `Ctrl+Z` / `Ctrl+Shift+Z` | undo / redo |
| `n` | new topic |

**Reading:**

| Do this | To |
| --- | --- |
| select text → **highlight** (`H`) | highlight it |
| select text → **note** (`N`) | attach a note to that line (a dot appears in the margin) |
| select text → **define** (`D`) | save a term and its definition. Select just the term and write what it means, or select a defining passage and name the term. It gets a dotted underline |
| select text → **reference** (`R`) | log a work the paper cites, to read next. Select the entry in its reference list, or an in-text citation like "[12]" and type what it cites. Then say why it's worth following, or just press Enter. It gets a dashed underline |
| **bookmark** (`B`) | leave a red bookmark on the line you're reading, and label it if you like. As many as you want per reading |
| click a highlight or margin dot | read or edit its note |
| **+ note** in the side panel | a note about the whole reading |
| `←` `→`, PgUp/PgDn, or the ‹ › pager | previous / next page |
| **contents** (`O`) | the document's headings and subheadings beside the page: where you are, and a click to go anywhere |
| `[` `]` | previous / next heading |
| **focus** (`F`) | full screen, just the page, no edges. Click left/right of it to turn the page |
| **paper** (`W`) | page colour: white, warm or dark |
| **export** | this article's summary and notes as Markdown |

After any mark the box opens ready to type: Enter finishes, so you rarely need the mouse.

Every definition goes into the **glossary** on the map (bottom left): one entry per term
across all your readings. The same term spelled differently (case, plural) is still one entry;
different definitions of it are listed under it with where each came from.

Every reference goes into **references**, beside the glossary: your reading list. Each work is
listed once, with the readings that cite it and why. The ones you haven't read come first; a
reference counts as on the map once a reading with its title is there. **+ add to map** opens
the add form filled in from the citation: with a DOI or arXiv link it fetches the paper itself.
It goes in the citing reading's topic, connected to it. **find ↗** searches Google Scholar.
Glossary and references each hide with ×, and come back from their tab.

Inside a reading, its own bookmarks, terms and references sit at the top of the side panel;
each section folds away. Headings are found when a reading is first opened: a PDF's own
bookmarks if it has them, otherwise read off the text (bigger type, numbered titles like
"6. Contrary Views…" or "(1) The Theological Objection", short lines standing on their own); a
saved web page's heading tags. Notes and references then sit in folders, one per heading (empty ones too, for getting around), each
of which folds away; click a folder's name to go to that heading. Exports group quotes the
same way. The article's card on the map lists its references too.

Readings with bookmarks are **pinned** at the top of the map: click one to go straight back to
the last place you marked, or the number beside it for all of them. Bookmarked pearls carry a
small red mark. Bookmarks are yours alone: they're left out of the website.

**Edit screen** (`E`, or **edit** in the bottom bar; only in the app on your computer, never on
the website). The rest of the interface steps aside and every bubble, label and line is in view:

| Do this | To |
| --- | --- |
| click a bubble or a line | see its settings on the right |
| hover a line, click its **+** | add a bubble in the middle of it (a topic or a reading; on an "inside" line, a topic in between) |
| drag a selected line's end onto another bubble | re-route the connection (or move a bubble into another topic) |
| drag the dot on a selected bubble onto another | connect them |
| drag a bubble onto a topic | move it inside |
| drag a bubble into open space | pin it there (**let it float** undoes it) |
| double-click empty space | a new topic right there |
| `T` / `A` / `C` | new topic / new reading / connect, from what's selected |
| `Enter` / `Del` / `F` / `L` | rename / delete / fit in view / show or hide layers |
| `Esc` | step back; with nothing selected, leave |

The **layers** list on the left has every bubble: click one to fly to it, drag one onto a topic
to move it. With nothing selected the right panel holds the map's own settings: its name, how
roomy the layout is, how strongly connections pull bubbles away from their topics, pinned
bubbles, and the idle drift. Every change is one Ctrl+Z away.

**export** in the bottom bar downloads all your notes and summaries (or one topic) as
Markdown, or a full JSON backup.

Anything can connect to anything: readings, subtopics and main topics. A bubble stays anchored
to its parent but drifts toward what it's connected to: 10% of the way per connection, halfway
at five, and never more than 65%.

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
