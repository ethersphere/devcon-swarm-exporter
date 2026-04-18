import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import type { AnyNode } from 'domhandler';
import * as cheerio from 'cheerio';

export type AssetLog = {
  info: (msg: string) => void;
  warning: (msg: string) => void;
};

const URL_IN_CSS =
  /url\(\s*(?:(?<q>["'])(?<quoted>[\s\S]*?)\k<q>|(?<bare>[^)"'\s][^)]*?))\s*\)/gi;

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** Relative URL from one on-disk file to another (for HTML/CSS). */
export function fileRelative(fromFile: string, toFile: string): string {
  let rel = relative(dirname(fromFile), toFile);
  if (!rel.startsWith('.')) {
    rel = `./${rel}`;
  }
  return toPosix(rel);
}

function isUnderMirror(mirrorRoot: string, absPath: string): boolean {
  const a = normalize(absPath);
  const m = normalize(mirrorRoot);
  return a === m || a.startsWith(`${m}${sep}`);
}

/** Map https://devcon.org/path/to/file.ext → mirrorRoot/path/to/file.ext */
export function absoluteUrlToMirrorAssetPath(
  mirrorRoot: string,
  baseOrigin: string,
  absoluteUrl: string,
): string | null {
  let u: URL;
  try {
    u = new URL(absoluteUrl);
  } catch {
    return null;
  }
  if (u.origin !== baseOrigin) {
    return null;
  }
  let pathname = u.pathname || '/';
  if (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1) || '/';
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  const rel = join(...segments);
  const resolved = normalize(join(mirrorRoot, rel));
  if (!isUnderMirror(mirrorRoot, resolved)) {
    return null;
  }
  return resolved;
}

/**
 * Next.js image optimizer → fetch the real static asset URL.
 * Returns null if this is not an /_next/image URL.
 */
export function resolveNextImageFetchUrl(baseOrigin: string, pageUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(pageUrl);
  } catch {
    return null;
  }
  if (u.origin !== baseOrigin || !u.pathname.startsWith('/_next/image')) {
    return null;
  }
  const inner = u.searchParams.get('url');
  if (!inner) {
    return null;
  }
  let path: string;
  try {
    path = decodeURIComponent(inner);
  } catch {
    path = inner;
  }
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const pathPart = path.startsWith('/') ? path : `/${path}`;
  return `${baseOrigin}${pathPart}`;
}

function normalizeFetchKey(urlStr: string): string {
  const u = new URL(urlStr);
  u.hash = '';
  return u.href;
}

function looksLikeCssPath(urlStr: string): boolean {
  const p = new URL(urlStr).pathname;
  return /\.css($|\?)/i.test(p);
}

export class AssetMirrorSession {
  private readonly cache = new Map<string, string>();
  /** In-flight downloads so parallel `<img>` with the same `src` share one fetch. */
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly mirrorRoot: string,
    private readonly baseOrigin: string,
    private readonly log: AssetLog,
  ) {}

  private async fetchBuffer(urlStr: string): Promise<Buffer> {
    const res = await fetch(urlStr, {
      headers: {
        'user-agent': 'devcon-export/0.1 (asset mirror; Crawlee)',
        accept: '*/*',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async fetchText(urlStr: string): Promise<string> {
    const res = await fetch(urlStr, {
      headers: {
        'user-agent': 'devcon-export/0.1 (asset mirror; Crawlee)',
        accept: 'text/css,*/*;q=0.1',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.text();
  }

  /** Resolve any devcon URL to the URL we actually fetch (unwrap /_next/image). */
  resolveFetchUrl(absoluteUrl: string): string | null {
    const fromImage = resolveNextImageFetchUrl(this.baseOrigin, absoluteUrl);
    if (fromImage) {
      return normalizeFetchKey(fromImage);
    }
    try {
      return normalizeFetchKey(absoluteUrl);
    } catch {
      return null;
    }
  }

  /**
   * Download asset if needed; returns absolute disk path.
   * Skips non-devcon URLs (returns null — caller keeps original href).
   * `cssCycle` is only used from `processCssContent` to detect circular `url()` / `@import` chains.
   */
  async ensureAsset(absoluteUrl: string, cssCycle?: Set<string>): Promise<string | null> {
    const fetchUrl = this.resolveFetchUrl(absoluteUrl);
    if (!fetchUrl) {
      return null;
    }
    let u: URL;
    try {
      u = new URL(fetchUrl);
    } catch {
      return null;
    }
    if (u.origin !== this.baseOrigin) {
      return null;
    }

    const key = fetchUrl;
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    if (cssCycle?.has(key)) {
      this.log.warning(`Skipping circular asset reference: ${key}`);
      return null;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      return pending;
    }

    const task = this.downloadToDisk(fetchUrl, key, cssCycle);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async downloadToDisk(fetchUrl: string, key: string, cssCycle?: Set<string>): Promise<string | null> {
    const diskPath = absoluteUrlToMirrorAssetPath(this.mirrorRoot, this.baseOrigin, fetchUrl);
    if (!diskPath) {
      return null;
    }

    await mkdir(dirname(diskPath), { recursive: true });

    try {
      if (looksLikeCssPath(fetchUrl)) {
        const raw = await this.fetchText(fetchUrl);
        const cycle = cssCycle ?? new Set<string>();
        cycle.add(key);
        try {
          const processed = await this.processCssContent(raw, fetchUrl, diskPath, cycle);
          await writeFile(diskPath, processed, 'utf8');
        } finally {
          cycle.delete(key);
        }
      } else {
        const buf = await this.fetchBuffer(fetchUrl);
        await writeFile(diskPath, buf);
      }
    } catch (e) {
      this.log.warning(`Asset fetch failed ${fetchUrl}: ${e}`);
      return null;
    }

    this.cache.set(key, diskPath);
    return diskPath;
  }

  /** Walk CSS url(...) and download sub-assets; rewrite to paths relative to this CSS file. */
  async processCssContent(
    cssText: string,
    cssAbsUrl: string,
    cssDiskPath: string,
    cssCycle: Set<string>,
  ): Promise<string> {
    const cssBase = new URL(cssAbsUrl);
    let out = cssText;
    const re = new RegExp(URL_IN_CSS.source, URL_IN_CSS.flags);
    const matches: Array<{ full: string; resolved: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(cssText)) !== null) {
      const full = m[0];
      const quoted = m.groups?.quoted;
      const bare = m.groups?.bare;
      const raw = (quoted ?? bare ?? '').trim();
      if (!raw || raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('#')) {
        continue;
      }
      let resolved: string;
      try {
        resolved = new URL(raw, cssBase).href;
      } catch {
        continue;
      }
      matches.push({ full, resolved });
    }

    const replaced = new Set<string>();
    for (const { full, resolved } of matches) {
      if (replaced.has(full)) {
        continue;
      }
      replaced.add(full);
      const disk = await this.ensureAsset(resolved, cssCycle);
      if (!disk) {
        continue;
      }
      const rel = fileRelative(cssDiskPath, disk);
      const replacement = `url(${rel})`;
      out = out.split(full).join(replacement);
    }
    return out;
  }
}

function resolveHref(documentUrl: string, href: string): string | null {
  const t = href.trim();
  if (!t || t.startsWith('data:') || t.startsWith('blob:') || t.startsWith('javascript:')) {
    return null;
  }
  if (t.startsWith('#')) {
    return null;
  }
  try {
    return new URL(t, documentUrl).href;
  } catch {
    return null;
  }
}

function splitSrcsetPart(part: string): { url: string; suffix: string } {
  const trimmed = part.trim();
  const match = /^(.*?)(\s+[\d.]+[wx])$/.exec(trimmed);
  if (match) {
    return { url: match[1].trim(), suffix: match[2] };
  }
  return { url: trimmed, suffix: '' };
}

export async function rewriteHtmlAssets(options: {
  html: string;
  documentUrl: string;
  documentFilePath: string;
  baseOrigin: string;
  log: AssetLog;
  session: AssetMirrorSession;
}): Promise<string> {
  const { html, documentUrl, documentFilePath, log, session } = options;
  const $ = cheerio.load(html);

  const patchAttr = async (attr: string, el: AnyNode) => {
    const v = $(el).attr(attr);
    if (!v || v.startsWith('#')) {
      return;
    }
    const abs = resolveHref(documentUrl, v);
    if (!abs) {
      return;
    }
    const disk = await session.ensureAsset(abs);
    if (!disk) {
      return;
    }
    $(el).attr(attr, fileRelative(documentFilePath, disk));
  };

  const patchSrcset = async (el: AnyNode, attr: string) => {
    const v = $(el).attr(attr);
    if (!v) {
      return;
    }
    const parts = v
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const out: string[] = [];
    for (const part of parts) {
      const { url: u, suffix } = splitSrcsetPart(part);
      if (u.startsWith('#')) {
        out.push(part);
        continue;
      }
      const abs = resolveHref(documentUrl, u);
      if (!abs) {
        out.push(part);
        continue;
      }
      const disk = await session.ensureAsset(abs);
      if (!disk) {
        out.push(part);
        continue;
      }
      out.push(`${fileRelative(documentFilePath, disk)}${suffix}`);
    }
    $(el).attr(attr, out.join(', '));
  };

  const nodes = [
    ...$('link[href]').toArray(),
    ...$('script[src]').toArray(),
    ...$('img[src]').toArray(),
    ...$('source[src]').toArray(),
    ...$('video[poster]').toArray(),
  ];

  for (const el of nodes) {
    const tag = el.tagName?.toLowerCase();
    if (tag === 'link') {
      await patchAttr('href', el);
    } else if (tag === 'script') {
      await patchAttr('src', el);
    } else if (tag === 'img') {
      await patchAttr('src', el);
      if ($(el).attr('srcset')) {
        await patchSrcset(el, 'srcset');
      }
    } else if (tag === 'source') {
      await patchAttr('src', el);
      if ($(el).attr('srcset')) {
        await patchSrcset(el, 'srcset');
      }
    } else if (tag === 'video') {
      await patchAttr('poster', el);
    }
  }

  if ($('[style*="url("]').length > 0) {
    log.info('Some inline styles contain url(); those were not rewritten.');
  }

  // devcon-swarm-exporter: drop third-party analytics (avoids 499 / wrong MIME offline).
  $('script[src*="matomo"], script[src*="ethereumfoundation.matomo"], script[src*="matomo.cloud"]').remove();
  $('link[href*="matomo"]').remove();
  // Preload image URLs often still point at /_next/image?… at runtime; removing reduces broken preload fetches.
  $('link[rel="preload"][as="image"]').remove();

  return $.html();
}
