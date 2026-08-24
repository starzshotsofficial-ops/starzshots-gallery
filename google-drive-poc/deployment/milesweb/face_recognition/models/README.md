# Face model weights

This folder holds the pre-trained face-api model weights. They are **not** committed
to the repo because they are binary blobs.

Generate them once with:

```bash
cd face_recognition
npm install
npm run setup        # downloads the model weights into this folder
```

`npm run setup` runs `download-models.js`, which fetches these files:

- `tiny_face_detector_model-*` – lightweight face detector (default)
- `face_landmark_68_model-*` – 68-point face alignment
- `face_recognition_model-*` – 128-d face descriptor network

Add the SSD MobileNet detector (slower but higher recall on group photos) with:

```bash
node download-models.js --ssd
```

then start the server with `FACE_DETECTOR=ssd` (see `../INTEGRATION.md`).
