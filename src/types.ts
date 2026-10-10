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
  /** 'note' = a line you annotated (drawn as an underline, not a highlight band) */
  kind?: 'note';
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
