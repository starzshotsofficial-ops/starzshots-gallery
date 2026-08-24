const basePath = resolveBasePath();
const gallerySlug = new URLSearchParams(window.location.search).get("event") || "";
const pageSize = 60;

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11"/><path d="m8 11 4 4 4-4"/><path d="M5 21h14"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>`;

const state = {
  meta: null,
  summary: null,
  scene: "all",
  favoritesOnly: false,
  favorites: new Set(),
  removed: new Set(),
  role: null,
  viewerId: null,
  viewerLabel: null,
  permissions: {},
  images: [],
  total: 0,
  offset: 0,
  loading: false,
  exhausted: false,
  lightboxIndex: 0
};

const elements = {
  accessView: document.querySelector('[data-view="access"]'),
  galleryView: document.querySelector('[data-view="gallery"]'),
  accessForm: document.querySelector("#accessForm"),
  viewerId: document.querySelector("#viewerId"),
  accessCode: document.querySelector("#accessCode"),
  accessError: document.querySelector("#accessError"),
  accessTitle: document.querySelector("#accessTitle"),
  accessMeta: document.querySelector("#accessMeta"),
  coverImage: document.querySelector("#coverImage"),
  eventName: document.querySelector("#eventName"),
  eventDate: document.querySelector("#eventDate"),
  clientName: document.querySelector("#clientName"),
  sceneTabs: document.querySelector("#sceneTabs"),
  galleryGrid: document.querySelector("#galleryGrid"),
  gridSentinel: document.querySelector("#gridSentinel"),
  gridStatus: document.querySelector("#gridStatus"),
  syncNotice: document.querySelector("#syncNotice"),
  showAll: document.querySelector("#showAll"),
  showFavorites: document.querySelector("#showFavorites"),
  downloadAll: document.querySelector("#downloadAll"),
  downloadFavoritesCsv: document.querySelector("#downloadFavoritesCsv"),
  findMyPhotos: document.querySelector("#findMyPhotos"),
  visitorRole: document.querySelector("#visitorRole"),
  favoriteCount: document.querySelector("#favoriteCount"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxScene: document.querySelector("#lightboxScene"),
  lightboxFilename: document.querySelector("#lightboxFilename"),
  lightboxFavorite: document.querySelector("#lightboxFavorite"),
  lightboxDownload: document.querySelector("#lightboxDownload"),
  closeLightbox: document.querySelector("#closeLightbox"),
  previousImage: document.querySelector("#previousImage"),
  nextImage: document.querySelector("#nextImage"),
  downloadDialog: document.querySelector("#downloadDialog"),
  downloadParts: document.querySelector("#downloadParts"),
  closeDownloadDialog: document.querySelector("#closeDownloadDialog")
};

function resolveBasePath() {
  return window.location.pathname
    .replace(/\/(index|admin)\.html$/, "")
    .replace(/\/admin\/?$/, "")
    .replace(/\/$/, "");
}

function apiUrl(suffix) {
  return `${basePath}/api/galleries/${encodeURIComponent(gallerySlug)}${suffix}`;
}

async function apiFetch(suffix, options) {
  const response = await fetch(apiUrl(suffix), options);
  if (response.ok) return response;

  const payload = await response.json().catch(() => ({}));
  throw new Error(payload.error || `Request failed with status ${response.status}.`);
}

async function loadMeta() {
  const response = await apiFetch("/meta");
  state.meta = await response.json();
  elements.accessTitle.textContent = state.meta.eventName;
  elements.accessMeta.textContent = `${state.meta.clientName} - ${formatDate(state.meta.eventDate)}`;
  elements.viewerId.focus();
}

async function handleAccessFormSubmit(event) {
  event.preventDefault();
  elements.accessError.textContent = "";

  const viewerId = elements.viewerId.value.trim();
  const accessCode = elements.accessCode.value.trim();

  if (!viewerId || !accessCode) {
    elements.accessError.textContent = "Please enter both your name/email and access code.";
    return;
  }

  try {
    const response = await apiFetch("/access", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ viewerId, accessCode })
    });

    const session = await response.json();
    state.role = session.role;
    state.viewerId = session.viewerId;
    state.viewerLabel = session.viewerId;
    state.permissions = session.permissions || {};
    state.favorites = new Set(readFavorites());
    state.removed = new Set();

    await openGallery();
  } catch (error) {
    elements.accessError.textContent = error.message || "Unable to open the gallery.";
  }
}

async function openGallery() {
  state.summary = await (await apiFetch("/summary")).json();

  elements.accessView.classList.add("hidden");
  elements.galleryView.classList.remove("hidden");

  if (state.summary.coverImage) {
    elements.coverImage.src = state.summary.coverImage;
    elements.coverImage.alt = `${state.summary.eventName} cover`;
  }
  elements.eventName.textContent = state.summary.eventName;
  elements.eventDate.textContent = formatDate(state.summary.eventDate);
  elements.clientName.textContent = state.summary.clientName;
  elements.visitorRole.textContent = `${state.role === "client" ? "Client" : "Guest"}: ${state.viewerLabel}`;

  if (elements.findMyPhotos) {
    elements.findMyPhotos.href = `${basePath}/find-my-photos?event=${encodeURIComponent(gallerySlug)}`;
  }

  applyPermissions();
  renderSyncNotice();
  renderScenes();
  await loadFavorites();
  await resetGrid();
  observeSentinel();
}

function applyPermissions() {
  elements.showFavorites.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.downloadAll.classList.toggle("hidden", !state.permissions.canDownloadAll);
  elements.downloadFavoritesCsv.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.lightboxFavorite.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.lightboxDownload.classList.toggle("hidden", !state.permissions.canDownloadSingle);
}

function renderSyncNotice() {
  const sync = state.summary.sync || {};
  const stillCaching = sync.status === "listing" || sync.status === "caching" || sync.status === "never-run";

  elements.syncNotice.classList.toggle("hidden", !stillCaching);
  if (stillCaching) {
    elements.syncNotice.textContent = `Photos are still being prepared (${sync.cachedThumbnails || 0} of ${sync.totalImages || 0} ready). Everything still opens, just a little slower until this finishes.`;
  }
}

function renderScenes() {
  const scenes = state.summary.scenes || [];
  const tabs = [{ name: "all", count: state.summary.totalImages || 0 }, ...scenes];

  elements.sceneTabs.replaceChildren(
    ...tabs.map((scene) => {
      const button = document.createElement("button");
      const label = document.createElement("span");
      const count = document.createElement("span");

      button.type = "button";
      button.className = `tab ${state.scene === scene.name ? "active" : ""}`;
      label.textContent = scene.name === "all" ? "All Scenes" : scene.name;
      count.className = "tab-count";
      count.textContent = String(scene.count);
      count.title = `${scene.count} photos`;
      button.append(label, count);

      button.addEventListener("click", async () => {
        state.scene = scene.name;
        state.favoritesOnly = false;
        renderScenes();
        await resetGrid();
      });

      return button;
    })
  );
}

async function resetGrid() {
  state.images = [];
  state.offset = 0;
  state.total = 0;
  state.exhausted = false;
  elements.galleryGrid.replaceChildren();
  elements.showAll.classList.toggle("active", !state.favoritesOnly);
  elements.showFavorites.classList.toggle("active", state.favoritesOnly);
  elements.favoriteCount.textContent = `${state.favorites.size} favorites`;
  await loadNextPage();
}

async function loadNextPage() {
  if (state.loading || state.exhausted) return;

  state.loading = true;
  elements.gridStatus.textContent = "Loading photos…";

  try {
    const batch = state.favoritesOnly ? await loadFavoritePage() : await loadScenePage();
    appendTiles(batch);
    elements.gridStatus.textContent = state.images.length
      ? `Showing ${state.images.length} of ${state.total} photos`
      : "No photos in this view yet.";
  } catch (error) {
    elements.gridStatus.textContent = error.message || "Photos could not be loaded.";
    state.exhausted = true;
  } finally {
    state.loading = false;
  }
}

async function loadScenePage() {
  const query = new URLSearchParams({ scene: state.scene, offset: String(state.offset), limit: String(pageSize) });
  const payload = await (await apiFetch(`/images?${query}`)).json();

  state.total = payload.total;
  state.offset += payload.images.length;
  if (!payload.images.length || state.offset >= payload.total) state.exhausted = true;

  return payload.images;
}

async function loadFavoritePage() {
  const ids = [...state.favorites].slice(state.offset, state.offset + pageSize);
  state.total = state.favorites.size;

  if (!ids.length) {
    state.exhausted = true;
    return [];
  }

  const payload = await (
    await apiFetch("/images-by-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    })
  ).json();

  state.offset += ids.length;
  if (state.offset >= state.favorites.size) state.exhausted = true;
  return payload.images;
}

function appendTiles(images) {
  const fragment = document.createDocumentFragment();

  images.forEach((image) => {
    if (state.removed.has(image.id)) return;
    const index = state.images.length;
    state.images.push(image);
    fragment.append(createTile(image, index));
  });

  elements.galleryGrid.append(fragment);
}

function createTile(image, index) {
  const tile = document.createElement("article");
  tile.className = "photo-tile";

  const img = document.createElement("img");
  img.src = image.thumbnailUrl;
  img.alt = image.filename;
  img.loading = "lazy";
  img.decoding = "async";
  img.addEventListener("click", () => openLightbox(index));

  const numberTag = document.createElement("span");
  numberTag.className = "image-number-tag";
  numberTag.textContent = `#${image.sceneIndex}`;

  tile.append(img, numberTag);

  if (state.permissions.canFavorite) {
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `favorite-button ${state.favorites.has(image.id) ? "active" : ""}`;
    favorite.innerHTML = "&hearts;";
    favorite.title = "Toggle favorite";
    favorite.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(image.id);
      favorite.classList.toggle("active", state.favorites.has(image.id));
    });
    tile.append(favorite);
  }

  if (state.permissions.canDownloadSingle) {
    const download = document.createElement("a");
    download.className = "tile-download";
    download.href = image.downloadUrl;
    download.target = "_blank";
    download.rel = "noopener";
    download.title = "Download photo";
    download.setAttribute("aria-label", "Download photo");
    download.setAttribute("download", image.filename);
    download.innerHTML = DOWNLOAD_ICON;
    download.addEventListener("click", (event) => event.stopPropagation());
    tile.append(download);
  }

  if (state.role === "client") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "tile-remove";
    remove.title = "Remove photo";
    remove.setAttribute("aria-label", "Remove photo");
    remove.innerHTML = TRASH_ICON;
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeImage(image, tile);
    });
    tile.append(remove);
  }

  return tile;
}

function observeSentinel() {
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadNextPage();
    },
    { rootMargin: "600px 0px" }
  );
  observer.observe(elements.gridSentinel);
}

function toggleFavorite(imageId) {
  if (!state.permissions.canFavorite) return;

  if (state.favorites.has(imageId)) state.favorites.delete(imageId);
  else state.favorites.add(imageId);

  writeFavorites([...state.favorites]);
  scheduleFavoritesSync();
  elements.favoriteCount.textContent = `${state.favorites.size} favorites`;
  if (elements.lightbox.open) renderLightbox();
}

function openLightbox(index) {
  state.lightboxIndex = index;
  renderLightbox();
  elements.lightbox.showModal();
}

function renderLightbox() {
  const image = state.images[state.lightboxIndex];
  if (!image) return;

  elements.lightboxImage.src = image.url;
  elements.lightboxImage.alt = image.filename;
  elements.lightboxScene.textContent = `${image.scene} #${image.sceneIndex}`;
  elements.lightboxFilename.textContent = image.filename;
  elements.lightboxFavorite.textContent = state.favorites.has(image.id) ? "Remove Favorite" : "Favorite";
  elements.lightboxDownload.href = image.downloadUrl;
  elements.lightboxDownload.setAttribute("download", image.filename);
}

async function moveLightbox(direction) {
  let nextIndex = state.lightboxIndex + direction;
  while (nextIndex >= 0 && nextIndex < state.images.length && state.removed.has(state.images[nextIndex].id)) {
    nextIndex += direction;
  }

  if (nextIndex >= state.images.length - 5) await loadNextPage();
  if (nextIndex < 0 || nextIndex >= state.images.length) return;

  state.lightboxIndex = nextIndex;
  renderLightbox();
}

function removeImage(image, tile) {
  if (state.role !== "client") return;
  if (!window.confirm("Permanently remove this photo? It is moved to the Google Drive trash and removed from the gallery for everyone.")) return;

  void deleteImage(image, tile);
}

async function deleteImage(image, tile) {
  let payload = {};
  try {
    const response = await apiFetch(`/files/${encodeURIComponent(image.id)}`, { method: "DELETE" });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    window.alert(error.message || "Unable to remove the photo.");
    return;
  }

  state.removed.add(image.id);
  tile.remove();
  if (elements.lightbox.open) elements.lightbox.close();

  if (payload && payload.driveTrashed === false) {
    window.alert("Photo removed from the gallery. It could not be deleted from Google Drive (the service account lacks permission), so the original file still exists in Drive.");
  }
}

async function openDownloadDialog() {
  if (!state.permissions.canDownloadAll) return;

  elements.downloadParts.replaceChildren();
  elements.downloadDialog.showModal();

  try {
    const payload = await (await apiFetch("/download-parts")).json();

    if (!payload.parts.length) {
      elements.downloadParts.textContent = "No photos are available for download yet.";
      return;
    }

    elements.downloadParts.replaceChildren(
      ...payload.parts.map((part) => {
        const row = document.createElement("div");
        row.className = "download-part";

        const label = document.createElement("span");
        label.textContent =
          payload.parts.length > 1
            ? `Part ${part.part} — ${part.imageCount} photos (${formatBytes(part.approximateBytes)})`
            : `${part.imageCount} photos (${formatBytes(part.approximateBytes)})`;

        const link = document.createElement("a");
        link.className = "download-button";
        link.href = part.url;
        link.textContent = "Download";

        row.append(label, link);
        return row;
      })
    );
  } catch (error) {
    elements.downloadParts.textContent = error.message || "Download list could not be loaded.";
  }
}

async function downloadFavoritesCsv() {
  if (!state.permissions.canFavorite) return;

  if (!state.favorites.size) {
    window.alert("No favorites selected.");
    return;
  }

  const payload = await (
    await apiFetch("/images-by-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...state.favorites] })
    })
  ).json();

  const csv = ["scene,filename"]
    .concat(payload.images.map((image) => `${JSON.stringify(image.scene)},${JSON.stringify(image.filename)}`))
    .join("\n");

  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${gallerySlug}-favorites.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readFavorites() {
  try {
    return JSON.parse(localStorage.getItem(favoriteStorageKey())) || [];
  } catch {
    return [];
  }
}

function writeFavorites(favorites) {
  localStorage.setItem(favoriteStorageKey(), JSON.stringify(favorites));
}

function favoriteStorageKey() {
  return `starz-shots:favorites:${gallerySlug}:${state.role}:${state.viewerId}`;
}

// Server is the source of truth so favorites follow the viewer across devices; localStorage is an offline cache.
async function loadFavorites() {
  try {
    const payload = await (await apiFetch("/favorites")).json();
    state.favorites = new Set(Array.isArray(payload.ids) ? payload.ids : []);
    writeFavorites([...state.favorites]);
  } catch {
    state.favorites = new Set(readFavorites());
  }
  elements.favoriteCount.textContent = `${state.favorites.size} favorites`;
}

let favoritesSyncTimer = null;

function scheduleFavoritesSync() {
  if (favoritesSyncTimer) clearTimeout(favoritesSyncTimer);
  favoritesSyncTimer = setTimeout(syncFavoritesToServer, 500);
}

async function syncFavoritesToServer() {
  favoritesSyncTimer = null;
  try {
    await apiFetch("/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...state.favorites] }),
      keepalive: true
    });
  } catch {
    // Still cached locally; the next toggle (or reload) will retry the sync.
  }
}

function formatDate(dateValue) {
  if (!dateValue) return "";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(parsed);
}

function formatBytes(bytes) {
  if (!bytes) return "size unknown";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function bindUiEvents() {
  elements.accessForm.addEventListener("submit", handleAccessFormSubmit);

  elements.showAll.addEventListener("click", async () => {
    state.favoritesOnly = false;
    await resetGrid();
  });

  elements.showFavorites.addEventListener("click", async () => {
    state.favoritesOnly = true;
    await resetGrid();
  });

  elements.downloadAll.addEventListener("click", openDownloadDialog);
  elements.downloadFavoritesCsv.addEventListener("click", downloadFavoritesCsv);
  elements.closeDownloadDialog.addEventListener("click", () => elements.downloadDialog.close());

  elements.closeLightbox.addEventListener("click", () => elements.lightbox.close());
  elements.previousImage.addEventListener("click", () => moveLightbox(-1));
  elements.nextImage.addEventListener("click", () => moveLightbox(1));
  elements.lightboxFavorite.addEventListener("click", () => {
    const image = state.images[state.lightboxIndex];
    if (image) toggleFavorite(image.id);
  });

  // Flush a pending favorites save if the viewer leaves before the debounce fires.
  window.addEventListener("pagehide", () => {
    if (favoritesSyncTimer) {
      clearTimeout(favoritesSyncTimer);
      syncFavoritesToServer();
    }
  });
}

async function init() {
  bindUiEvents();

  if (!gallerySlug) {
    elements.accessMeta.textContent = "No event was selected. Open the link your photographer shared with you.";
    return;
  }

  try {
    await loadMeta();
  } catch (error) {
    elements.accessMeta.textContent = error.message || "Event details could not be loaded.";
  }
}

void init();
