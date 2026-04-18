import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dataset, PlaywrightCrawler, RequestQueue } from 'crawlee';

import { AssetMirrorSession, rewriteHtmlAssets } from './assets.js';
import { runMirrorPostProcess, writeMirrorRootIndex } from './postProcess.js';

const BASE = 'https://devcon.org';
const SITEMAP = `${BASE}/sitemap.xml`;
const MIRROR_SUBDIR = 'mirror';
const QUEUE_NAME = 'devcon-mirror';

const rootDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(rootDir, '..');
const mirrorRoot = join(projectRoot, MIRROR_SUBDIR);

const baseOrigin = new URL(BASE).origin;

function isDevconHttps(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.protocol === 'https:' && u.hostname === 'devcon.org';
  } catch {
    return false;
  }
}

/** Map a page URL to a path under ./mirror (HTML files). */
export function urlToMirrorFile(urlStr: string): string {
  const u = new URL(urlStr);
  if (u.origin !== baseOrigin) {
    throw new Error(`Refusing to write off-origin URL: ${urlStr}`);
  }
  const pathname = u.pathname || '/';
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  const hasFileExtension = last?.includes('.') ?? false;

  if (segments.length === 0) {
    return join(mirrorRoot, 'index.html');
  }
  if (hasFileExtension) {
    const rel = join(...segments);
    const resolved = normalize(join(mirrorRoot, rel));
    if (!resolved.startsWith(normalize(mirrorRoot))) {
      throw new Error(`Unsafe path for URL: ${urlStr}`);
    }
    return resolved;
  }
  const rel = join(...segments, 'index.html');
  const resolved = normalize(join(mirrorRoot, rel));
  if (!resolved.startsWith(normalize(mirrorRoot))) {
    throw new Error(`Unsafe path for URL: ${urlStr}`);
  }
  return resolved;
}

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, {
    headers: { 'user-agent': 'devcon-export/0.1 (Crawlee mirror; +https://github.com/)' },
  });
  if (!r.ok) {
    throw new Error(`GET ${url} failed: ${r.status}`);
  }
  return r.text();
}

/** Recursively expand sitemap indexes and return page URLs (https devcon.org only). */
async function collectSitemapPageUrls(entryUrl: string, visited = new Set<string>()): Promise<string[]> {
  if (visited.has(entryUrl)) {
    return [];
  }
  visited.add(entryUrl);
  const xml = await fetchText(entryUrl);
  const locs = extractLocs(xml);
  const pages: string[] = [];
  for (const loc of locs) {
    if (loc.endsWith('.xml')) {
      pages.push(...(await collectSitemapPageUrls(loc, visited)));
    } else if (isDevconHttps(loc)) {
      pages.push(loc);
    }
  }
  return pages;
}

async function buildStartUrls(): Promise<string[]> {
  const fromSitemap = await collectSitemapPageUrls(SITEMAP).catch((err) => {
    console.warn('Sitemap fetch failed, using home only:', err);
    return [] as string[];
  });
  const unique = [...new Set([`${BASE}/`, ...fromSitemap])];
  return unique.filter(isDevconHttps);
}

async function main(): Promise<void> {
  const maxPages = Number(process.env.MAX_PAGES || '0') || undefined;
  const startUrls = await buildStartUrls();
  console.log(`Seeded ${startUrls.length} URL(s) (home + sitemap).`);
  if (startUrls.length <= 1) {
    console.warn(
      'Only the home URL was seeded — sitemap fetch may have failed (network/DNS). Check the message above or open https://devcon.org/sitemap.xml manually.',
    );
  }

  let saved = 0;
  const crawledPageUrls: string[] = [];
  // Named queues are NOT auto-purged on run (only the default queue is). A finished crawl leaves all
  // URLs marked handled, so the next run would process 0 requests unless we drop or use RESUME=1.
  let requestQueue = await RequestQueue.open(QUEUE_NAME);
  if (process.env.RESUME !== '1') {
    console.log(
      'Resetting request queue (omit RESUME or set RESUME=0 for a full re-crawl; use RESUME=1 to continue an interrupted crawl).',
    );
    await requestQueue.drop();
    requestQueue = await RequestQueue.open(QUEUE_NAME);
  }

  const assetSession = new AssetMirrorSession(mirrorRoot, baseOrigin, {
    info: (msg) => console.log(msg),
    warning: (msg) => console.warn(msg),
  });

  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: 2,
    maxRequestsPerCrawl: maxPages,
    requestHandlerTimeoutSecs: 120,
    async requestHandler({ page, request, enqueueLinks, log }) {
      const docUrl = request.loadedUrl ?? request.url;
      const targetPath = urlToMirrorFile(docUrl);
      await mkdir(dirname(targetPath), { recursive: true });
      const rawHtml = await page.content();
      const html = await rewriteHtmlAssets({
        html: rawHtml,
        documentUrl: docUrl,
        documentFilePath: targetPath,
        baseOrigin,
        log: {
          info: (m) => log.info(m),
          warning: (m) => log.warning(m),
        },
        session: assetSession,
      });
      await writeFile(targetPath, html, 'utf8');
      saved += 1;
      crawledPageUrls.push(docUrl);
      log.info(`Saved (${saved}): ${docUrl} -> ${targetPath}`);

      await enqueueLinks({
        globs: [`${BASE}/**`],
        exclude: [/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|pdf|zip|mp4|webm)(\?|$)/i],
      });
    },
    failedRequestHandler({ request, log }, err) {
      log.error(`Failed: ${request.url}: ${err}`);
    },
  });

  await crawler.run(startUrls);

  if (saved > 0 && process.env.SKIP_POST_PROCESS !== '1') {
    const uniqueUrls = [...new Set(crawledPageUrls)];
    await runMirrorPostProcess({
      mirrorRoot,
      base: BASE,
      pageUrls: uniqueUrls,
      log: {
        info: (s) => console.log(s),
        warning: (s) => console.warn(s),
      },
    });
  } else if (process.env.SKIP_POST_PROCESS === '1') {
    console.log('SKIP_POST_PROCESS=1: skipping _next/data JSON, extra .json, unoptimized chunk rewrite.');
  }

  if (saved > 0) {
    await writeMirrorRootIndex(mirrorRoot);
    console.log(`Wrote root redirect: ${mirrorRoot}/index.html → /en/index.html`);
  }

  await Dataset.pushData({
    finishedAt: new Date().toISOString(),
    startUrlCount: startUrls.length,
    pagesWritten: saved,
    mirrorDir: mirrorRoot,
  });
  console.log(`Done. HTML under ${mirrorRoot} (see storage/datasets for crawl log).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
