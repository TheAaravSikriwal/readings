// Command-line publishing, for when the app isn't open.
//
//   npm run publish-site            build, commit and push the map to the live site
//   npm run export-site -- <folder> build and copy the map into a site checkout, no git
import path from 'node:path';
import { buildPublic, exportTo, publish, siteConfig } from './publish.ts';

const root = process.cwd();
const [command, folder] = process.argv.slice(2);

try {
  if (command === 'publish') {
    const r = await publish(root, (line) => console.log(line));
    if (r.changed && r.url) console.log(`Live soon at ${r.url}`);
  } else if (command === 'export') {
    const cfg = await siteConfig(root);
    const site = folder ?? cfg?.repo;
    if (!site || !cfg) throw new Error('Say which site checkout to export into.');
    const out = path.join(root, '.publish', 'build');
    console.log('Building the public map…');
    await buildPublic(root, out);
    await exportTo(out, path.join(site, cfg.dir));
    console.log(`Copied into ${path.join(site, cfg.dir)}. Nothing was committed.`);
  } else {
    console.log('Usage: cli.ts publish | export [site folder]');
    process.exitCode = 1;
  }
} catch (e: any) {
  console.error(e?.message ?? e);
  process.exitCode = 1;
}
