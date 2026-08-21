Runtime data directory. The application creates and writes:

  thumbnails/<event-slug>/<scene-folder>/<fileId>.jpg
  previews/<event-slug>/<scene-folder>/<fileId>.jpg
  index/<event-slug>/index.json
  index/<event-slug>/scene-<n>.json
  index/<event-slug>/sync-state.json

Keep this directory writable by the Node.js application user and back it up
before redeploying.
