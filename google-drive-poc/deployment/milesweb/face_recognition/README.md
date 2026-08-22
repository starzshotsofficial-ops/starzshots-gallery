# Face recognition – "Find my photos"

Selfie-based face matching for the Starz Shots Gallery. A client uploads a selfie
and the app returns every gallery photo they appear in. Matches are shown as
thumbnails with a **Download** button that streams the original straight from
Google Drive – exactly like the rest of the gallery.

## How it works

1. The server indexes the thumbnails the gallery already caches. For each photo it
   detects every face and stores a 128-number face "descriptor" in
   `DATA_DIR/faces/<event-slug>/index.json`. This runs once in the background and
   updates automatically when photos are added or removed.
2. When a client uploads a selfie, the browser downscales it to a small JPEG and
   sends it to the server. The server computes the selfie's descriptor and returns
   the photos whose faces are closest to it.
3. The client clicks **Download** and the file comes from Google Drive through the
   existing `/files/:id` endpoint (subject to the same download permission as the
   main gallery).

Everything runs on a pure-JavaScript TensorFlow.js backend (`@vladmandic/face-api`
+ `jpeg-js`) with **no native modules**, so it works on MilesWeb / Passenger shared
hosting.

## Setup — automatic

You do **not** need to run `npm install` or `npm run setup` by hand. On the first
`npm start` the app self-bootstraps in the background:

1. installs `@vladmandic/face-api` + `jpeg-js` into `face_recognition/node_modules`
   (only if they are missing), and
2. downloads the ~7 MB model weights into `face_recognition/models`.

While that one-time step runs, the base gallery keeps working normally and the
"Find my photos" page shows a "Setting up…" message. Once ready, the app also
**auto-indexes each event as soon as its thumbnails finish caching**, so the very
first selfie search is fast.

If the host blocks outbound `npm`/network access, run these once manually instead:

```bash
cd face_recognition
npm install
npm run setup            # add --ssd for the heavier, higher-recall detector
```

## Configuration (optional environment variables)

| Variable                | Default | Meaning                                                        |
| ----------------------- | ------- | -------------------------------------------------------------- |
| `FACE_DETECTOR`         | `tiny`  | `tiny` (fast, low memory) or `ssd` (slower, better on groups). |
| `FACE_MATCH_THRESHOLD`  | `0.5`   | Max face distance to count as a match. Lower = stricter.       |

## Endpoints

| Method | Path                                        | Purpose                              |
| ------ | ------------------------------------------- | ------------------------------------ |
| GET    | `/find-my-photos?event=<slug>`              | Client selfie-upload page.           |
| GET    | `/api/galleries/:slug/face/status`          | Index readiness / progress.          |
| POST   | `/api/galleries/:slug/face/index`           | (Re)build the face index.            |
| POST   | `/api/galleries/:slug/face/search`          | Match an uploaded selfie.            |

All API routes require a valid gallery session cookie, the same one the main
gallery issues after the access code is entered.

## Privacy

Selfies are processed in memory and never written to disk. Only the numeric face
descriptors of the gallery photos are stored, under `DATA_DIR/faces/`.
