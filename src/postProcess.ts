import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';

const UA = 'devcon-export/0.1 (post-process; mirror)';

/** Same idea as devcon-swarm-exporter `IndexFile` — `npx serve mirror` opens `/` → `/en/`. */
export const MIRROR_ROOT_INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="0; url=/en/index.html">
  <title>Redirecting…</title>
  <script>
    window.location.replace('/en/index.html');
  </script>
</head>
<body>
  <p>If you are not redirected automatically, open <a href="/en/index.html">/en/</a>.</p>
</body>
</html>
`;

/** Root redirect for static hosting (`npx serve` from the mirror folder). */
export async function writeMirrorRootIndex(mirrorRoot: string): Promise<void> {
  const path = join(mirrorRoot, 'index.html');
  await writeFile(path, MIRROR_ROOT_INDEX_HTML, 'utf8');
}

/** Next.js build id from `_buildManifest.js` script path in HTML. */
export async function extractNextBuildId(mirrorRoot: string): Promise<string | null> {
  async function walk(dir: string): Promise<string | null> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const found = await walk(p);
        if (found) {
          return found;
        }
      } else if (e.name.endsWith('.html')) {
        const text = await readFile(p, 'utf8');
        const m = text.match(/\/_next\/static\/([^/]+)\/_buildManifest\.js/);
        if (m?.[1]) {
          return m[1];
        }
      }
    }
    return null;
  }
  return walk(mirrorRoot);
}

/**
 * Map page URL → `_next/data/{buildId}/…` JSON path (no leading slash).
 * e.g. https://devcon.org/en/tickets → en/tickets.json
 */
export function urlToNextDataRelativeJsonPath(urlStr: string): string | null {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  if (u.hostname !== 'devcon.org' || u.protocol !== 'https:') {
    return null;
  }
  let path = u.pathname.replace(/\/$/, '') || '/';
  if (path === '/' || path === '') {
    return null;
  }
  return `${path.slice(1)}.json`;
}

function isInsideMirror(mirrorRoot: string, absPath: string): boolean {
  const a = normalize(absPath);
  const m = normalize(mirrorRoot);
  return a === m || a.startsWith(`${m}${sep}`);
}

async function fetchBinary(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Download `/_next/data/{buildId}/{route}.json` for each crawled page URL (swarm-exporter: downloadNextDataFiles). */
export async function downloadNextDataJsonFiles(options: {
  mirrorRoot: string;
  base: string;
  pageUrls: string[];
  log: { info: (s: string) => void; warning: (s: string) => void };
}): Promise<void> {
  const { mirrorRoot, base, pageUrls, log } = options;
  const buildId = await extractNextBuildId(mirrorRoot);
  if (!buildId) {
    log.warning('Could not find Next.js build id in mirror HTML; skipping _next/data/*.json downloads.');
    return;
  }
  log.info(`Next.js build id: ${buildId}`);

  const keys = new Set<string>();
  for (const url of pageUrls) {
    const k = urlToNextDataRelativeJsonPath(url);
    if (k) {
      keys.add(k);
    }
  }

  for (const jsonKey of keys) {
    const remote = `${base}/_next/data/${buildId}/${jsonKey}`;
    const diskPath = join(mirrorRoot, '_next', 'data', buildId, jsonKey);
    if (!isInsideMirror(mirrorRoot, diskPath)) {
      continue;
    }
    try {
      await mkdir(dirname(diskPath), { recursive: true });
      const buf = await fetchBinary(remote);
      await writeFile(diskPath, buf);
      log.info(`Saved _next/data: ${jsonKey}`);
    } catch (e) {
      log.warning(`_next/data ${jsonKey}: ${e}`);
    }
  }
}

/** Find `/…path/to/file.json` references in HTML/JS (e.g. mumbai/Eth-Glyph-….json). */
export async function discoverJsonPathsInMirror(mirrorRoot: string): Promise<Set<string>> {
  const out = new Set<string>();
  const re = /["'](\/[a-zA-Z0-9][a-zA-Z0-9/_-]*\.json)(?:\?[^"'\\s]*)?["']/g;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules') {
          continue;
        }
        await walk(p);
      } else if (/\.(html|js)$/i.test(e.name)) {
        const text = await readFile(p, 'utf8');
        let m: RegExpExecArray | null;
        re.lastIndex = 0;
        while ((m = re.exec(text)) !== null) {
          const pathOnly = m[1];
          if (pathOnly.startsWith('/_next/')) {
            continue;
          }
          out.add(pathOnly.slice(1));
        }
      }
    }
  }
  await walk(mirrorRoot);
  return out;
}

export async function downloadDiscoveredJsonFiles(options: {
  mirrorRoot: string;
  base: string;
  pathsRelative: Set<string>;
  log: { info: (s: string) => void; warning: (s: string) => void };
}): Promise<void> {
  const { mirrorRoot, base, pathsRelative, log } = options;
  for (const rel of pathsRelative) {
    const remote = `${base}/${rel}`;
    const diskPath = join(mirrorRoot, ...rel.split('/'));
    if (!isInsideMirror(mirrorRoot, diskPath)) {
      continue;
    }
    try {
      await mkdir(dirname(diskPath), { recursive: true });
      const buf = await fetchBinary(remote);
      await writeFile(diskPath, buf);
      log.info(`Saved JSON asset: ${rel}`);
    } catch (e) {
      log.warning(`JSON ${rel}: ${e}`);
    }
  }
}

/** Swarm-exporter `rewriteJsFiles`: Next Image uses unoptimized mode offline. */
export async function rewriteUnoptimizedInNextChunks(mirrorRoot: string, log: { info: (s: string) => void }): Promise<void> {
  const chunksDir = join(mirrorRoot, '_next', 'static', 'chunks');
  let files: string[] = [];
  try {
    files = (await readdir(chunksDir)).filter((f) => f.endsWith('.js')).map((f) => join(chunksDir, f));
  } catch {
    return;
  }
  for (const file of files) {
    let text = await readFile(file, 'utf8');
    if (!text.includes('unoptimized:!1')) {
      continue;
    }
    text = text.replace(/unoptimized:!1/g, 'unoptimized:!0');
    await writeFile(file, text, 'utf8');
    log.info(`unoptimized:!0: ${relative(mirrorRoot, file)}`);
  }
}

export async function runMirrorPostProcess(options: {
  mirrorRoot: string;
  base: string;
  pageUrls: string[];
  log: { info: (s: string) => void; warning: (s: string) => void };
}): Promise<void> {
  const { mirrorRoot, base, pageUrls, log } = options;
  log.info('Post-process: _next/data JSON, extra .json refs, unoptimized chunks…');
  await downloadNextDataJsonFiles({ mirrorRoot, base, pageUrls, log });
  const extra = await discoverJsonPathsInMirror(mirrorRoot);
  await downloadDiscoveredJsonFiles({ mirrorRoot, base, pathsRelative: extra, log });
  await rewriteUnoptimizedInNextChunks(mirrorRoot, log);
}
