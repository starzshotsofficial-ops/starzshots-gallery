# Starz Shots Gallery — Google Drive edition (MilesWeb deployment)

Clean upload package for MilesWeb. It intentionally contains no `.env`, no
`node_modules`, and no existing event configuration.

Google Drive stays the single source of truth for full-resolution photos. This
build adds a local **thumbnail cache** so galleries with thousands of photos open
quickly without hammering the Drive API on every page view.

---

## 1. How it works

### Background cache job

Creating (or editing the Drive folders of) an event in `/admin` queues a
background job. Nothing about the request waits for it.

The job:

1. Resolves the event folder under `GOOGLE_DRIVE_ROOT_FOLDER_ID`.
2. Lists every scene sub-folder and every image inside it.
3. Writes the image index to disk, one file per scene.
4. Downloads Google Drive's own **lowest-resolution thumbnail** for each photo
   (`thumbnailLink` resized to `THUMBNAIL_SIZE`) into a folder named after the
   event, with one sub-folder per scene.

No image-processing library is used, so there is nothing to compile on shared
hosting and CPU usage stays near zero.

```text
data/
  thumbnails/<event-slug>/<scene-folder>/<fileId>.jpg    ~30-60 KB each
  previews/<event-slug>/<scene-folder>/<fileId>.jpg      cached on first lightbox view
  index/<event-slug>/index.json                          scene names + counts
  index/<event-slug>/scene-1.json                        image list for scene 1
  index/<event-slug>/sync-state.json                     progress for the admin screen
```

Sizing guide: 2,000 photos ≈ 100 MB of cached thumbnails at `THUMBNAIL_SIZE=400`.

The job is queued one event at a time with `SYNC_CONCURRENCY` parallel downloads,
so a large sync never starves the web requests. Progress is visible in
`/admin` under the **Cache** column, and the viewer sees a banner while a sync
is still running.

### Cache-first serving

| Request | Served from |
| --- | --- |
| Grid thumbnail | Local cache. On a miss, fetched from Drive, written to the cache, then returned — so each miss happens at most once. |
| Lightbox preview | Local cache (`PREVIEW_SIZE`), populated lazily on first view. |
| Single-photo download | Streamed straight from Drive, never cached (full-resolution files are too large for shared hosting). |
| Scene tabs / counts / paging | Local index files only — zero Drive calls. |

A restart never invalidates the cache; it lives on disk.

### Handling scenes with 1,000–2,000+ photos

The gallery never loads a whole scene at once:

- **Server-side paging.** `GET /api/galleries/:slug/images?scene=…&offset=…&limit=60`
  reads only the scene's index file and returns one page. The scene tabs come
  from a small summary file, so switching tabs never parses a 2,000-entry list.
- **Infinite scroll.** The browser requests the next page only when the sentinel
  approaches the viewport (600 px pre-fetch), so a viewer who looks at 40 photos
  downloads 40 thumbnails, not 2,000.
- **Cheap tiles.** Each tile has a reserved aspect ratio plus
  `loading="lazy"`, `decoding="async"`, and `content-visibility: auto`, so
  off-screen tiles cost almost nothing to keep in the DOM.
- **Small payloads.** Thumbnails are ~30–60 KB, so a full page of 60 tiles is a
  few megabytes at most.
- **Chunked "Download all".** Bulk download is split into parts
  (`ZIP_PART_MAX_FILES` / `ZIP_PART_MAX_BYTES`). Each part is streamed as a
  store-only ZIP built one file at a time through a temp file, so memory stays
  flat and no single request runs unbounded.

### Access control

Access codes are validated **on the server**. A successful code exchange sets a
signed, HttpOnly session cookie scoped to that event; every image, preview,
download, and paging endpoint requires it and only serves file IDs that belong
to that event. Codes are no longer sent to the browser, and Drive file IDs
cannot be used to read arbitrary files from the Drive account.

---

## 2. Upload and run

1. In MilesWeb mPanel, open **Setup Node.js App**. If it is not available, the
   hosting plan cannot run Node.js — ask support to enable Node.js/Passenger.
2. Create an application for the target domain or subdomain, using Node.js 18+.
3. Upload and extract this folder's contents directly into
   `public_html/gallery` (so `public_html/gallery/server.js` exists — not inside
   an extra nested folder).
4. Set the application root to `public_html/gallery`, the application URL to
   `/gallery`, and the startup file to `server.js`.
5. Run `npm install` from the application root if mPanel does not do it
   automatically. There are no third-party dependencies, so this is a no-op.
6. In the environment-variable screen, add the values from `.env.example`.
   Do not upload a local `.env` file.
7. Restart the application, then confirm `https://YOUR-DOMAIN/gallery/healthz`
   returns `{"ok":true}`.

### Google Drive access

Share the **Starz Shots** root folder in Google Drive with the service account's
`client_email`. Grant **Editor** so the client "remove" action can move photos to
the Google Drive trash (Viewer is enough only if you never use remove). Put that
folder's ID in `GOOGLE_DRIVE_ROOT_FOLDER_ID`.

### Required environment variables

`GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (or `GOOGLE_SERVICE_ACCOUNT_JSON`),
`GOOGLE_DRIVE_ROOT_FOLDER_ID`, `ADMIN_TOKEN`, `SESSION_SECRET`, and
`APP_BASE_PATH=/gallery`. MilesWeb assigns `PORT`; do not set it unless their
Node.js screen tells you to.

Optional tuning values are documented in `.env.example`.

### Writable application data

The application writes to `public_html/gallery/data`. Ensure the Node.js
application user can write there, and back the folder up before redeploying —
deleting it only costs a re-sync, but that re-sync re-downloads every thumbnail.

---

## 3. Day-to-day use

1. Open `https://YOUR-DOMAIN/gallery/admin` and unlock with `ADMIN_TOKEN`.
2. Use **Find Google Drive folder** to confirm the exact event folder name.
3. Fill in **Create new event**. Leave scene folder names blank to include every
   sub-folder of the event folder.
4. Watch the **Cache** column. `Ready` means every thumbnail is on disk.
5. Share `https://YOUR-DOMAIN/gallery/?event=<slug>` plus the access code.

Use **Rebuild cache** after adding photos to Drive, or wait for the automatic
re-scan (`SYNC_REFRESH_MINUTES`, default every 6 hours).

## 4. Deployment check

- `https://YOUR-DOMAIN/gallery/healthz` → `{"ok":true}` verifies the Node app.
- `/gallery/admin` → unlock, then **Browse folders** verifies the Drive
  service-account connection.
- Open an event with its access code and scroll — the **Cache** column and the
  viewer banner confirm the background job is progressing.
