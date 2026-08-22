# Starz Shots Gallery — SpaceByte edition (MilesWeb deployment)

SpaceByte stays the single source of truth for full-resolution photos. This
build adds a local **thumbnail cache** so galleries with thousands of photos
open quickly without re-fetching from SpaceByte on every page view.

## How it works

### Background cache job

Creating (or editing the SpaceByte folders of) an event in `/admin` queues a
background job. The request returns immediately. The job:

1. Resolves the event folder (by `spacebyteRootFolderId`, folder name, or path).
2. Lists every scene sub-folder and every image inside it.
3. Writes the image index to disk, one file per scene.
4. Downloads each original once and stores a **low-resolution JPEG** (resized
   with `sharp` to `THUMBNAIL_SIZE`) in a folder named after the event, with one
   sub-folder per scene.

```text
data/
  thumbnails/<event-slug>/<scene-folder>/<hash>.jpg   ~30-60 KB each
  previews/<event-slug>/<scene-folder>/<hash>.jpg     cached on first lightbox view
  index/<event-slug>/index.json                       scene names + counts
  index/<event-slug>/scene-1.json                     image list for scene 1
  index/<event-slug>/sync-state.json                  progress for the admin screen
```

Because SpaceByte has no thumbnail endpoint, the job downloads each full image
once to produce the low-res copy. This is one-time bandwidth; afterwards every
view is served from disk. It runs one event at a time with `SYNC_CONCURRENCY`
parallel resizes, so a 2,000-photo sync never starves web requests. Progress is
visible in `/admin` under the **Cache** column, and viewers see a banner while a
sync is still running.

### Cache-first serving

| Request | Served from |
| --- | --- |
| Grid thumbnail | Local cache. On a miss, fetched from SpaceByte, resized, cached, then returned. |
| Lightbox preview | Local cache (`PREVIEW_SIZE`), populated lazily on first view. |
| Single-photo download | Streamed straight from SpaceByte, never cached. |
| Scene tabs / counts / paging | Local index files only — zero SpaceByte calls. |

### Handling scenes with 1,000–2,000+ photos

- **Server-side paging** — `/images?scene=…&offset=…&limit=60` reads only that
  scene's index file; scene tabs come from a small summary file.
- **Infinite scroll** with a 600 px pre-fetch, so viewing 40 photos downloads 40
  thumbnails, not 2,000.
- **Cheap tiles** — reserved aspect ratio, `loading="lazy"`, `content-visibility`.
- **Chunked "Download all"** — split into parts (`ZIP_PART_MAX_FILES` /
  `ZIP_PART_MAX_BYTES`), each streamed as a store-only ZIP one file at a time.

### Access control

Access codes are validated on the server and exchanged for a signed, HttpOnly
session cookie scoped to that event. Every image, preview, download, and paging
endpoint requires it and only serves file hashes belonging to that event.

## Deploy on MilesWeb

1. In **Setup Node.js App**, create the app with Node.js 18+, application root
   `public_html/gallery`, application URL `/gallery`, startup file `server.js`.
2. Set the proxy **Port** and add `PORT` to the environment with the same value
   (defaults to 3001). The app binds to `0.0.0.0` on that port.
3. Run `npm install` from the application root — this compiles `sharp`.
4. Add the environment variables from `.env.example` (do not upload `.env`).
5. Restart, then confirm `https://YOUR-DOMAIN/gallery/healthz` → `{"ok":true}`.

### Required environment variables

`SPACEBYTE_BASE_URL`, `SPACEBYTE_TOKEN`, `ADMIN_TOKEN`, `SESSION_SECRET`,
`APP_BASE_PATH=/gallery`, and `PORT`. Optional tuning is documented in
`.env.example`.

### Writable application data

The app writes cached thumbnails and indexes to `public_html/gallery/data`.
Ensure it is writable and back it up before redeploying — deleting it only costs
a re-sync, but that re-sync re-downloads and re-resizes every photo.

## Day-to-day use

1. Open `/gallery/admin` and unlock with `ADMIN_TOKEN`.
2. Use **Find SpaceByte folder** to locate the event folder and click
   **Use this folder** to copy its ID into the create form.
3. Fill in **Create new event**. Leave scene folder names blank to include every
   sub-folder.
4. Watch the **Cache** column. `Ready` means every thumbnail is on disk.
5. Share `https://YOUR-DOMAIN/gallery/?event=<slug>` plus the access code.

Use **Rebuild cache** after adding photos in SpaceByte, or wait for the
automatic re-scan (`SYNC_REFRESH_MINUTES`, default every 6 hours).

## Files

- `server.js` — cache-first HTTP server and gallery/admin API.
- `lib/spacebyte-client.js` — SpaceByte Drive listing + download.
- `lib/sync-worker.js` — background indexing + thumbnail caching.
- `lib/image-processor.js` — `sharp` resize (falls back to originals if absent).
- `lib/gallery-cache.js` — on-disk index/thumbnail/preview store.
- `lib/zip-writer.js` — dependency-free store-only ZIP for bulk download.
- `app.js` / `admin.js` — viewer and admin UIs.
- `config/galleries.json` — gallery metadata.
