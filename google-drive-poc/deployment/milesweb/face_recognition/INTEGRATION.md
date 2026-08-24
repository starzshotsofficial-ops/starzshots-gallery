# Wiring `face_recognition` into `server.js`

The Starz Shots MilesWeb deployment in this folder is **already wired up**. Use this
guide to add the feature to another copy of the app. Four small edits, no changes to
the existing gallery logic.

### 1. Import the module (top of `server.js`, with the other `require`s)

```js
const { createFaceRecognition } = require("./face_recognition");
```

### 2. Create the instance (before the `sync` worker is created)

```js
const face = createFaceRecognition({
  cache,
  drive,
  config,
  dataDir,
  basePath,
  thumbnailSize,
  sendJson,
  readJsonBody,
  SECURITY_HEADERS,
  options: {
    detector: readString(env, "FACE_DETECTOR", "tiny"),
    matchThreshold: Number(readString(env, "FACE_MATCH_THRESHOLD", "0.5")) || 0.5
  }
});
```

### 2b. Auto-index each event when its thumbnails finish caching

Pass an `onGalleryReady` hook to the sync worker so a fresh event is indexed in the
background the moment its thumbnails are cached (makes the first selfie search fast):

```js
const sync = createSyncWorker({
  config,
  cache,
  drive,
  thumbnailSize,
  concurrency: readNumber(env, "SYNC_CONCURRENCY", 4),
  refreshMinutes: readNumber(env, "SYNC_REFRESH_MINUTES", 360),
  onGalleryReady: (slug) => face.onSyncComplete(slug)
});
```

### 3. Serve the client page (inside `route()`, after the `/api` branch)

```js
if (request.method === "GET" && (pathname === "/find-my-photos" || pathname.startsWith("/find-my-photos/"))) {
  return face.handlePage(request, response, url);
}
```

### 4. Handle the face API (inside `routeGallery()`, right after the session check)

```js
const session = sessions.read(request, slug);
if (!session) return sendJson(response, 401, { error: "Enter your access code to view this gallery." });

if (action === "face") return face.handleGallery(request, response, gallery, session, segments.slice(2), url);
```

### 5. Add the entry point (optional, in `index.html` + `app.js`)

In `index.html`, inside the toolbar `.actions`:

```html
<a id="findMyPhotos" class="icon-button" href="#">Find my photos</a>
```

In `app.js`, add the element reference and set its link in `openGallery()`:

```js
findMyPhotos: document.querySelector("#findMyPhotos"),
// ...
if (elements.findMyPhotos) {
  elements.findMyPhotos.href = `${basePath}/find-my-photos?event=${encodeURIComponent(gallerySlug)}`;
}
```

That's it. There is **no manual `npm install` / `npm run setup`** — the module
installs its own packages and downloads its models in the background on first start,
then indexes each event automatically as its thumbnails finish caching.
