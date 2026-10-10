// Publishing: build the public, read-only map and put it on the website.
//
// The site (readings.config.json → site.repo) is a separate git repository.
// Publishing never touches your own checkout of it: it keeps a private
// worktree in .publish/site, resets it to the live branch on GitHub, swaps in
// the new build at site.dir, commits only that folder and pushes it. So
// whatever else is going on in the site's repo, the only change that goes
// live is the map.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { build } from 'vite';

const exec = promisify(execFile);

export interface SiteConfig {
  /** The website's git repository on this computer. */
  repo: string;
  /** Where the map lives inside it. */
  dir: string;
  /** The branch the site goes live from. */
  branch: string;
  /** Where the map can be seen once it is live. */
  url: string;
}

export async function siteConfig(root: string): Promise<SiteConfig | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(path.join(root, 'readings.config.json'), 'utf8'));
    const s = raw.site;
    if (!s?.repo || !s?.dir) return null;
    return { repo: s.repo, dir: s.dir, branch: s.branch || 'main', url: s.url || '' };
  } catch {
    return null;
  }
}

/* Talking to GitHub goes through the GitHub CLI's login when it is there:
 * Git Credential Manager can stop and wait on a sign-in window nobody sees. */
let auth: string[] | null = null;
async function githubAuth() {
  if (auth) return auth;
  try {
    await exec('gh', ['auth', 'status'], { windowsHide: true });
    auth = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
  } catch {
    auth = [];
  }
  return auth;
}

async function git(cwd: string, ...args: string[]) {
  const remote = args[0] === 'fetch' || args[0] === 'push' ? await githubAuth() : [];
  const { stdout } = await exec('git', [...remote, ...args], {
    cwd,
    maxBuffer: 1 << 26,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** Builds the public map (hidden things left out) into `outDir`. */
export async function buildPublic(root: string, outDir: string) {
  await build({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    mode: 'production',
    logLevel: 'warn',
    build: { outDir, emptyOutDir: true },
  });
}

/** Copies a build into `<site>/<dir>`, replacing what was there. */
export async function exportTo(build: string, target: string) {
  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.cp(build, target, { recursive: true });
}

function counts(libFile: string) {
  try {
    const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'));
    const articles = lib.nodes.filter((n: any) => n.type === 'article').length;
    const topics = lib.nodes.filter((n: any) => n.type === 'topic').length;
    return { articles, topics, links: lib.links.length };
  } catch {
    return { articles: 0, topics: 0, links: 0 };
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface PublishResult {
  changed: boolean;
  url: string;
  commit?: string;
}

/** Builds, commits and pushes the map to the live site. `log` hears each step. */
export async function publish(root: string, log: (line: string) => void): Promise<PublishResult> {
  const cfg = await siteConfig(root);
  if (!cfg) throw new Error('No website set up yet: add it to readings.config.json.');
  if (!fs.existsSync(path.join(cfg.repo, '.git'))) throw new Error(`Can't find the website's repository at ${cfg.repo}.`);

  const work = path.join(root, '.publish');
  const site = path.join(work, 'site');
  const live = `origin/${cfg.branch}`;

  log('Getting the live site from GitHub…');
  await git(cfg.repo, 'fetch', 'origin', cfg.branch);
  if (!fs.existsSync(path.join(site, '.git'))) {
    await git(cfg.repo, 'worktree', 'prune');
    await fsp.mkdir(work, { recursive: true });
    await git(cfg.repo, 'worktree', 'add', '--detach', site, live);
  } else {
    await git(site, 'checkout', '--detach', '--force', live);
  }
  await git(site, 'clean', '-fdq', '--', cfg.dir);

  log('Building the public map (anything hidden is left out)…');
  const out = path.join(work, 'build');
  await buildPublic(root, out);

  log('Putting it into the site…');
  await exportTo(out, path.join(site, cfg.dir));
  await git(site, 'add', '-A', '--', cfg.dir);
  if (!(await git(site, 'status', '--porcelain', '--', cfg.dir))) {
    log('Nothing has changed since the last publish.');
    return { changed: false, url: cfg.url };
  }

  const c = counts(path.join(out, 'data', 'library.json'));
  const message = `content(readings): ${plural(c.articles, 'reading')}, ${plural(c.topics, 'topic')}, ${plural(c.links, 'connection')}`;
  await git(site, 'commit', '-q', '-m', message, '--', cfg.dir);

  log('Pushing to the website…');
  try {
    await git(site, 'push', '-q', 'origin', `HEAD:${cfg.branch}`);
  } catch {
    // Someone (you, on another machine or branch) pushed in the meantime.
    // The map is the only thing this commit touches, so it replays cleanly.
    await git(site, 'fetch', 'origin', cfg.branch);
    await git(site, 'rebase', '-q', live);
    await git(site, 'push', '-q', 'origin', `HEAD:${cfg.branch}`);
  }
  const commit = await git(site, 'rev-parse', '--short', 'HEAD');
  log(`Pushed ${commit}. The site rebuilds in about two minutes.`);
  return { changed: true, url: cfg.url, commit };
}
