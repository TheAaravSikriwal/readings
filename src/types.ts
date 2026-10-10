/** A highlight box on a PDF page, as fractions of the page size. */
export interface Rect {
  p: number; // page index (0-based)
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Highlight {
  id: string;
  /** The quoted text. Empty for a general note that isn't tied to a line. */
  text: string;
  note: string;
  created: string;
  /** 'note' = a line you annotated (drawn as an underline, not a highlight band).
   * 'definition' = a term and what it means; `note` holds the definition.
   * Definitions from every reading make up the glossary (src/notes.ts). */
  kind?: 'note' | 'definition' | 'reference';
  /** The word or phrase a definition defines. */
  term?: string;
  /** A reference: the cited work as the paper gives it. References from every
   * reading make up the reading list (src/notes.ts). */
  cite?: string;
  /** A reference that has been added to the map: the reading it became. */
  linked?: string;
  /** PDF highlights */
  rects?: Rect[];
  /** Web snapshot highlights: character offsets into the snapshot text */
  start?: number;
  end?: number;
}

interface Base {
  id: string;
  title: string;
  parent: string | null;
  hidden?: boolean; // left out of the public build
  created: string;
}

export interface Topic extends Base {
  type: 'topic';
  note?: string;
}

/** A place in a reading to come back to. */
export interface Bookmark {
  id: string;
  /** The PDF page (from 0); a web page has none. */
  p?: number;
  /** How far down, from 0 to 1: of that page (PDF), or of the whole article (web page). */
  y: number;
  label: string;
  created: string;
}

export interface Article extends Base {
  type: 'article';
  authors?: string;
  year?: string;
  url?: string;
  site?: string;
  /** File in data/files: <id>.pdf or <id>.html (page snapshot) */
  file?: string;
  /** Put the file itself on the website too (only for open-access material). */
  share?: boolean;
  summary?: string;
  /** Places to come back to. A reading with any is pinned on the map. */
  bookmarks?: Bookmark[];
  highlights: Highlight[];
}

export type LibNode = Topic | Article;

/** A connection between any two bubbles. */
export interface Link {
  id: string;
  a: string;
  b: string;
  note?: string;
}

export interface Library {
  version: 1;
  title: string;
  nodes: LibNode[];
  links: Link[];
}
