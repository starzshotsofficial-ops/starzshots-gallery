# Upload package contents

This directory is the Node.js application root. Upload its contents, rather
than its parent folder, directly into `public_html/gallery`. `server.js` must
therefore be at `public_html/gallery/server.js`. In Setup Node.js App, assign
the application URL `/gallery` and set `APP_BASE_PATH=/gallery`.

Never upload a `.env` containing real credentials. Add the required values in
the Node.js application's Environment Variables panel instead.

The `data` directory begins empty. The server creates its favourite-submission
file on first start, so it must remain writable by the application user.
