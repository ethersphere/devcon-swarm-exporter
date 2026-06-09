# devcon-swarm-exporter

A Node.js crawler that mirrors [devcon.org](https://devcon.org/) for offline reading, then publishes the static snapshot to [Ethereum Swarm](https://www.ethswarm.org/). Built with [Crawlee](https://crawlee.dev/) and [Playwright](https://playwright.dev/).

The mirror captures HTML pages, linked static assets (CSS, JS, images, fonts), and Next.js data files, rewriting URLs to relative paths so the site works without hitting the live origin.

---

## Table of contents

- [How it works](#how-it-works)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Environment variables](#environment-variables)
- [Output layout](#output-layout)
- [Serving the mirror locally](#serving-the-mirror-locally)
- [Resuming and re-crawling](#resuming-and-re-crawling)
- [Post-processing](#post-processing)
- [Swarm deployment (CI)](#swarm-deployment-ci)
- [Architecture](#architecture)
- [Limitations](#limitations)
- [Legal and etiquette](#legal-and-etiquette)
- [Development](#development)
- [References](#references)

---

## How it works

1. **Seed URLs** — Starts from `https://devcon.org/` and recursively parses `https://devcon.org/sitemap.xml` (including nested sitemap indexes).
2. **Crawl** — A `PlaywrightCrawler` visits each page, waits for the DOM, and saves rendered HTML to disk.
3. **Asset mirroring** — While saving each page, linked assets on `devcon.org` are downloaded and HTML/CSS references are rewritten to relative paths.
4. **Post-process** — After the crawl, Next.js-specific artifacts are fetched and patched for offline use.
5. **Deploy (optional)** — A GitHub Actions workflow uploads `./mirror` to Swarm and updates a feed for stable, versioned access.

```
┌──────────────┐     ┌─────────────────┐     ┌────────────────────┐
│ Sitemap +    │────▶│ Request queue   │────▶│ PlaywrightCrawler  │
│ home URL     │     │ (persistent)    │     │ (max 2 concurrent) │
└──────────────┘     └─────────────────┘     └─────────┬──────────┘
                                                        │
          ┌─────────────────────────────────────────────┼──────────────────────┐
          ▼                                             ▼                      ▼
   ┌─────────────┐                              ┌──────────────┐        ┌─────────────┐
   │ HTML mirror │                              │ Asset fetch  │        │ Dataset log │
   │ ./mirror/   │                              │ + rewrite    │        │ storage/    │
   └─────────────┘                              └──────────────┘        └─────────────┘
                                                        │
                                                        ▼
                                               ┌──────────────────┐
                                               │ Post-process     │
                                               │ (_next/data,     │
                                               │  JSON, chunks)   │
                                               └────────┬─────────┘
                                                        │
                                                        ▼
                                               ┌──────────────────┐
                                               │ Swarm upload     │
                                               │ (GitHub Actions) │
                                               └──────────────────┘
```

---

## Features

| Area | What it does |
|------|----------------|
| **Browser crawl** | Uses Playwright (Chromium) so client-rendered Next.js content is captured faithfully. |
| **Sitemap seeding** | Enqueues all `https://devcon.org/` URLs from the sitemap for better coverage than link-following alone. |
| **Same-origin only** | Only `https://devcon.org` URLs are written to disk; off-origin links are left unchanged. |
| **Asset pipeline** | Downloads CSS, JS, images, fonts; rewrites `url()` in CSS; unwraps `/_next/image` optimizer URLs to real assets. |
| **Next.js offline fixes** | Fetches `/_next/data/{buildId}/*.json`, discovers extra `.json` references in HTML/JS, and patches image chunks to use unoptimized mode. |
| **Analytics stripping** | Removes Matomo scripts and broken image preload links that fail offline. |
| **Persistent queue** | Named `RequestQueue` survives restarts; supports resume or full reset. |
| **Swarm publishing** | Scheduled/manual CI uploads the mirror and maintains a feed for updatable references. |

---

## Requirements

- **Node.js** ≥ 20 (CI uses 22)
- **npm** or **pnpm** for package management
- **Chromium** — installed automatically via `postinstall` (`playwright install chromium`)
- Network access to `https://devcon.org` during crawls

---

## Installation

```bash
git clone <this-repo>
cd devcon-swarm-exporter
npm ci
```

`npm ci` runs `postinstall`, which downloads the Playwright Chromium browser. On Linux CI or headless servers you may also need system dependencies:

```bash
npx playwright install chromium --with-deps
```

---

## Usage

Run a full crawl (default: all pages from sitemap + discovered links):

```bash
npm run crawl
```

Limit the crawl to a small number of pages (useful for testing):

```bash
MAX_PAGES=20 npm run crawl
```

Skip post-processing (faster, but Next.js client navigation may be incomplete offline):

```bash
SKIP_POST_PROCESS=1 npm run crawl
```

On completion, HTML and assets are written under `./mirror/`. Crawl metadata is appended to Crawlee's dataset in `./storage/datasets/`.

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_PAGES` | *(unlimited)* | Cap the number of pages processed in one run. Set to `0` or omit for no limit. |
| `RESUME` | `0` | `1` — continue an interrupted crawl using the existing request queue. `0` or unset — drop the queue and start fresh. |
| `SKIP_POST_PROCESS` | `0` | `1` — skip `_next/data` JSON downloads, extra `.json` fetches, and unoptimized chunk rewrites. |

---

## Output layout

All mirrored content lives in `./mirror/` (gitignored).

| URL | File path |
|-----|-----------|
| `https://devcon.org/` | `mirror/index.html` (root redirect → `/en/index.html`) |
| `https://devcon.org/en/` | `mirror/en/index.html` |
| `https://devcon.org/foo/bar` | `mirror/foo/bar/index.html` |
| `https://devcon.org/file.html` | `mirror/file.html` |
| `https://devcon.org/_next/static/...` | `mirror/_next/static/...` |
| `https://devcon.org/assets/...` | `mirror/assets/...` |

Crawlee persistence (queue, datasets, key-value stores) is stored under `./storage/` (also gitignored).

### URL → file mapping

The `urlToMirrorFile()` function in `src/main.ts` maps page URLs to paths:

- Root `/` → `index.html`
- Paths ending in a file extension (e.g. `.html`) → same path under `mirror/`
- Directory-style paths → `{path}/index.html`

Path traversal is guarded: resolved paths must stay inside `mirror/`.

---

## Serving the mirror locally

After a crawl, serve the mirror with any static file server:

```bash
npx serve mirror
```

or:

```bash
python3 -m http.server -d mirror 8080
```

Open `http://localhost:3000` (or your chosen port). The root `index.html` redirects to `/en/index.html`, matching devcon.org's locale structure.

**Spot-check:** home page, navigation, schedule, images, and a few deep links. Some interactive features (search, third-party embeds, live APIs) will not work offline.

---

## Resuming and re-crawling

The crawler uses a **named** `RequestQueue` (`devcon-mirror`). Named queues are **not** auto-purged when a crawl finishes — all URLs remain marked as handled.

| Intent | Command |
|--------|---------|
| **Fresh full crawl** | `npm run crawl` (default: `RESUME` unset or `0` drops the queue first) |
| **Continue interrupted crawl** | `RESUME=1 npm run crawl` |

Re-running without `RESUME=1` after a successful crawl will reset the queue and re-fetch everything.

---

## Post-processing

After pages are saved, `runMirrorPostProcess()` in `src/postProcess.ts` runs unless `SKIP_POST_PROCESS=1`:

1. **Next.js data JSON** — Extracts the build ID from `_buildManifest.js` in saved HTML, then downloads `/_next/data/{buildId}/{route}.json` for every crawled page URL.
2. **Discovered JSON** — Scans mirrored HTML/JS for absolute `/path/to/file.json` references (e.g. glyph or content JSON) and downloads them.
3. **Image chunk patch** — Rewrites `unoptimized:!1` → `unoptimized:!0` in `/_next/static/chunks/*.js` so Next.js Image components load static files instead of the optimizer endpoint.

These steps mirror techniques used in production Swarm exporters for Next.js sites.

---

## Swarm deployment (CI)

The workflow [`.github/workflows/swarm-upload.yml`](.github/workflows/swarm-upload.yml) builds the mirror and publishes it to Swarm.

**Triggers:**

- Manual: **Actions → Upload mirror to Swarm → Run workflow**
- Scheduled: daily at 05:15 UTC (`15 5 * * *`)

**Steps:**

1. Install dependencies and Playwright Chromium
2. Run `npm run crawl` with `RESUME=0`
3. Upload `./mirror` via [`ethersphere/swarm-actions/upload-dir`](https://github.com/ethersphere/swarm-actions)
4. Write a feed update (`topic: devcon-export-mirror`) for mutable references
5. Print the bzz.link URL in the job summary

### Required GitHub secrets

| Secret | Purpose |
|--------|---------|
| `PRIVATE_BEE_URL` | Bee node API URL |
| `PRIVATE_POSTAGE_BATCH_ID` | Swarm postage batch for uploads |
| `PRIVATE_SIGNER` | Private key for feed updates |

### Optional repository variable

| Variable | Purpose |
|----------|---------|
| `MAX_PAGES` | Cap crawl size in CI (e.g. for staging or cost control) |

---

## Architecture

### Source files

| File | Role |
|------|------|
| [`src/main.ts`](src/main.ts) | Entry point: sitemap seeding, crawler setup, orchestration |
| [`src/assets.ts`](src/assets.ts) | Asset download, HTML/CSS rewriting, `/_next/image` unwrapping |
| [`src/postProcess.ts`](src/postProcess.ts) | Next.js data JSON, extra JSON, chunk patches, root redirect |
| [`plan.md`](plan.md) | Original design document (phases, risks, testing checklist) |

### Crawler settings

- **Concurrency:** 2 parallel browser contexts
- **Timeout:** 120 seconds per request handler
- **Link discovery:** `enqueueLinks` with glob `https://devcon.org/**`
- **Excluded extensions:** `.png`, `.jpg`, `.gif`, `.webp`, `.svg`, `.ico`, `.woff`, `.ttf`, `.pdf`, `.zip`, `.mp4`, `.webm` (assets are fetched via HTML parsing, not as separate queue entries)
- **User-Agent:** `devcon-export/0.1 (Crawlee mirror; +https://github.com/)`

### Asset rewriting

During each page save, `rewriteHtmlAssets()`:

- Rewrites `link[href]`, `script[src]`, `img[src]`, `srcset`, `source[src]`, and `video[poster]`
- Processes nested `url()` references inside downloaded CSS
- Deduplicates concurrent downloads via an in-flight cache
- Skips `data:`, `blob:`, `javascript:`, and fragment-only URLs

---

## Limitations

| Limitation | Notes |
|------------|-------|
| **Dynamic features** | Client-side search, auth, and third-party widgets may not work offline. |
| **External assets** | CDN or third-party origins are not mirrored; those references stay absolute. |
| **Inline styles** | `style="...url(...)"` attributes are not rewritten. |
| **Large media** | Video files (`.mp4`, `.webm`) are excluded from link enqueueing; they are not automatically downloaded. |
| **Next.js RSC** | Some React Server Component payloads may still require the live origin. |
| **Crawl time** | A full sitemap crawl can take hours; CI sets a 360-minute timeout. |

See [`plan.md`](plan.md) for a fuller risk matrix and testing checklist.

---

## Legal and etiquette

- **Robots.txt:** As of the project plan, `https://devcon.org/robots.txt` allows all crawlers. Re-check before large automated runs.
- **Rate limiting:** Concurrency is capped at 2; use `MAX_PAGES` for test runs.
- **Use case:** Intended for personal, archival, and offline reading — not redistribution of scraped content without permission.
- **Identification:** Requests include a descriptive `User-Agent` string.

---

## Development

```bash
# Type-check (no emit)
npx tsc --noEmit

# Small test crawl
MAX_PAGES=5 npm run crawl

# Inspect Crawlee storage
ls storage/datasets/
```

### Project structure

```
devcon-swarm-exporter/
├── src/
│   ├── main.ts          # Crawler entry point
│   ├── assets.ts        # Asset mirror + HTML rewrite
│   └── postProcess.ts   # Next.js offline fixes
├── .github/workflows/
│   └── swarm-upload.yml # Swarm CI pipeline
├── mirror/              # Generated mirror (gitignored)
├── storage/             # Crawlee persistence (gitignored)
├── plan.md              # Design plan
├── package.json
└── tsconfig.json
```

---

## References

- [Crawlee documentation](https://crawlee.dev/)
- [PlaywrightCrawler guide](https://crawlee.dev/docs/guides/playwright-crawler)
- [devcon.org sitemap](https://devcon.org/sitemap.xml)
- [Ethereum Swarm](https://www.ethswarm.org/)
- [swarm-actions](https://github.com/ethersphere/swarm-actions)
