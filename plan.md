# Local mirror of devcon.org using Crawlee

This document is the implementation plan for a **read-only, offline-capable copy** of [https://devcon.org/](https://devcon.org/) (HTML and linked static assets), built with [Crawlee](https://crawlee.dev/) on Node.js.

---

## 1. Goals

| Goal | Description |
|------|-------------|
| **Primary** | Download pages under `https://devcon.org/` so they can be opened from disk (or served locally) without hitting the live site. |
| **Secondary** | Persist crawl state (queue, deduplication) so runs can be resumed or limited without starting from zero. |
| **Non-goals** | Perfect pixel-perfect replication of dynamic behavior (search, auth, third-party embeds); replacing the production site; crawling non-devcon domains. |

---

## 2. Constraints and compliance

### 2.1 Robots and policy

As of the plan date, `https://devcon.org/robots.txt` reports:

- `User-agent: *` → `Allow: /`
- `Sitemap: https://devcon.org/sitemap.xml`

You should **re-check robots.txt** before large or automated runs. This project should **only** crawl `devcon.org` (and optionally `www.devcon.org` if it redirects or hosts assets—see URL normalization).

### 2.2 Rate limiting and etiquette

- Use **conservative concurrency** (e.g. 1–3 parallel browser contexts for Playwright, or higher for pure HTTP if using Cheerio).
- Respect **retry/backoff** via Crawlee’s built-in retries; avoid hammering the origin during peak times.
- **Identify the client** with a clear `User-Agent` string that includes contact or project name (optional but good practice).

### 2.3 Legal

Mirroring is for **personal/archival/offline reading** use unless you have permission for redistribution. Do not assume scraped content can be republished.

---

## 3. Technical context: devcon.org

- **Hosting**: Response headers indicate **Netlify** and patterns consistent with **Next.js** (e.g. router prefetch headers).
- **Implication**: Many routes may be **HTML-first** but some content may rely on **client-side hydration**. A **browser-based crawler** (`PlaywrightCrawler`) is the default choice for faithful DOM and lazy-loaded sections. `CheerioCrawler` is faster but may miss JS-only content; it can be used as an optional “fast path” after validation.

---

## 4. High-level architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  Seed URLs      │────▶│  Request queue   │────▶│  Crawler            │
│  (start +       │     │  (dedupe,        │     │  PlaywrightCrawler  │
│   sitemap)      │     │   persistence)   │     │  or CheerioCrawler  │
└─────────────────┘     └──────────────────┘     └──────────┬──────────┘
                                                          │
                        ┌─────────────────────────────────┼────────────────────────┐
                        ▼                                 ▼                        ▼
                 ┌──────────────┐                 ┌─────────────────┐         ┌──────────────┐
                 │  HTML mirror │                 │  Asset fetcher  │         │  Dataset /   │
                 │  (path-based │                 │  (CSS/JS/img/   │         │  logs /      │
                 │   files)     │                 │   fonts)        │         │  snapshots   │
                 └──────────────┘                 └─────────────────┘         └──────────────┘
```

### 4.1 Crawlee components to use

| Component | Role |
|---------|------|
| **`PlaywrightCrawler`** | Navigate URLs, wait for network idle or selectors, read `page.content()`, follow internal links via `enqueueLinks`. |
| **`RequestQueue`** | Persistent URL frontier; survives restarts when using a named queue. |
| **`Dataset`** | Optional structured log: `{ url, status, savedPath, error }` per page. |
| **`KeyValueStore`** | Optional: Crawlee snapshots; or store crawl metadata (last run, version). |

### 4.2 URL discovery strategy (recommended order)

1. **Start URL**: `https://devcon.org/`
2. **Sitemap seed** (recommended): Fetch `https://devcon.org/sitemap.xml` (and nested sitemap indexes if present) and enqueue all `loc` entries under `https://devcon.org/`. This improves **coverage** compared to link-following alone.
3. **Link following**: In each page handler, `enqueueLinks` with:
   - **Glob** or **regex** restricting to `https://devcon.org/**`
   - **Excludes** for non-HTML assets if they are enqueued as separate requests (see below).

### 4.3 Same-origin and normalization

- Normalize `http://devcon.org` → `https://devcon.org/`
- Decide policy for `www.devcon.org`: follow redirects only, or allow both as internal—**one canonical host** avoids duplicates.
- Strip **tracking query parameters** (`utm_*`, `fbclid`, etc.) before deduplication keys if the site uses them.

---

## 5. Output layout (mirror on disk)

Target directory (example): `./mirror/` (gitignored).

Suggested mapping:

| URL | File path |
|-----|-----------|
| `https://devcon.org/` | `mirror/index.html` |
| `https://devcon.org/foo` | `mirror/foo/index.html` (if trailing slash or directory-style) |
| `https://devcon.org/bar.html` | `mirror/bar.html` |

**Assets**: Store under `mirror/_assets/` or preserve path segments from the URL path, e.g. `mirror/assets/...` matching public URLs. The implementation should **rewrite HTML** references from absolute `https://devcon.org/...` to **relative** paths so opening `index.html` from disk works. This is the hardest part of a “true” offline mirror; phase it:

- **Phase A**: Save raw HTML as fetched (absolute URLs still point online)—quick win.
- **Phase B**: Download linked CSS/JS/images/fonts and rewrite links to relative paths—full offline use.

---

## 6. Implementation phases

### Phase 0 — Project bootstrap

- Node.js **LTS**, **TypeScript**, `crawlee` + `playwright` (or `cheerio` only for experiments).
- Scripts: `npm run crawl`, `npm run postinstall` → `npx playwright install chromium` (or document manual install).
- `.gitignore`: `mirror/`, `storage/`, `node_modules/`, Playwright artifacts.

### Phase 1 — Playwright crawl + HTML dump (Phase A)

- Instantiate `PlaywrightCrawler` with:
  - `maxConcurrency` low (e.g. 2)
  - `requestHandler`: `page.goto` with reasonable timeout; optional `waitUntil: 'networkidle'` or wait for main content selector if known
  - Write `await page.content()` to the mapped file path under `mirror/`
  - `enqueueLinks({ glob: ['https://devcon.org/**'] })` excluding `mailto:`, `tel:`, external hosts
- Push row to **Dataset** per success/failure.

### Phase 2 — Sitemap ingestion

- Script or startup step: parse sitemap(s), enqueue all internal URLs (with dedupe).

### Phase 3 — Asset pipeline (Phase B, optional)

- From saved HTML (or live DOM), extract `<link href>`, `<script src>`, `<img src>`, `srcset`, CSS `url(...)`.
- Fetch assets with `got-scraping` / Crawlee `sendRequest` (respect same-origin or allow CDN hosts if devcon uses a separate asset domain—then extend allowlist carefully).
- Save files and rewrite HTML (and imported CSS) to relative paths. Consider a small library or custom rewriter; keep scope to devcon.org only.

### Phase 4 — Local verification

- Run a static server: `npx serve mirror` or `python -m http.server` from `mirror/`.
- Spot-check: home, schedule, blog, top nav, key images, no infinite spinners.

### Phase 5 — Hardening

- Retries, session rotation if needed, configurable **max pages** / **max depth** / **timeout** via env vars.
- Logging and a small README section on “how to resume” using named `RequestQueue`.

---

## 7. Risks and limitations

| Risk | Mitigation |
|------|------------|
| **Dynamic-only content** | Playwright + wait strategies; accept that some features won’t work offline. |
| **Duplicate or infinite URL space** | Strict `enqueueLinks` globs; normalize URLs; optional max requests. |
| **Large media** | Exclude `*.mp4` etc. unless explicitly wanted; max file size checks. |
| **Third-party scripts** | May block or fail offline; consider stripping analytics for archive use. |
| **Next.js data routes** | May expose JSON/RSC endpoints; link follower might enqueue them—filter by content-type or path patterns if noise appears. |

---

## 8. Testing checklist

- [ ] Crawler completes without unhandled exceptions on a **small** max-requests run (e.g. 20 pages).
- [ ] `mirror/` contains expected `index.html` for `/`.
- [ ] Dataset lists successful URLs and on-disk paths.
- [ ] Re-run uses **deduplication** (no duplicate work for same URL) when using persistent queue.

---

## 9. Future enhancements (optional)

- **CLI flags**: `--max-pages`, `--dry-run`, `--resume`, `--output ./mirror`.
- **Diff runs**: Compare dataset hashes between runs to detect site updates.
- **Dockerfile**: Pin Node + Playwright deps for reproducible crawls on servers.

---

## 10. References

- Crawlee docs: [https://crawlee.dev/](https://crawlee.dev/)
- PlaywrightCrawler: [https://crawlee.dev/docs/guides/playwright-crawler](https://crawlee.dev/docs/guides/playwright-crawler)
- devcon.org sitemap: [https://devcon.org/sitemap.xml](https://devcon.org/sitemap.xml)

This plan matches the scaffold in this repository (`src/main.ts`, `package.json`): start with Phase 0–1 and Phase 2 as implemented; Phase 3 remains optional follow-up work.
