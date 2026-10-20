// Content hash of the recognition index files → data/index-version.json (see lens/indexVersion.js).
//   node apps/web-preview-live-repro/tools/stamp-index-version.mjs      (run before every deploy)
import fs from 'node:fs/promises'; import path from 'node:path'; import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const data = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const files = (await fs.readdir(data)).filter(f => /^(deep-|visual-index-)/.test(f)).sort();
const h = crypto.createHash('sha256');
for (const f of files) { h.update(f); h.update(await fs.readFile(path.join(data, f))); }
const version = h.digest('hex').slice(0, 12);
await fs.writeFile(path.join(data, 'index-version.json'), JSON.stringify({ version, files: files.length, stampedAt: new Date().toISOString() }) + '\n');
console.log('index version', version, `(${files.length} files)`);
