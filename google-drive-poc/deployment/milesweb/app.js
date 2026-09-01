const basePath = resolveBasePath();
const gallerySlug = new URLSearchParams(window.location.search).get("event") || "";
const pageSize = 60;

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v11"/><path d="m8 11 4 4 4-4"/><path d="M5 21h14"/></svg>`;
const TRASH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/></svg>`;
const CROWN_ICON = `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2l3 6h6l-5 4 2 6-6-4-6 4 2-6-5-4h6z"/></svg>`;
const HIDE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/><path d="M21 9.88M3 9.88"/></svg>`;
const HIDDEN_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m3 3 18 18"/><path d="M10.58 10.58a2 2 0 0 0 2.83 2.83"/><path d="M9.88 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a20.86 20.86 0 0 1-3.13 4.19"/><path d="M6.61 6.61C3.9 8.46 1 12 1 12s4 8 11 8a10.88 10.88 0 0 0 4.24-.85"/></svg>`;
const CHECK_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const CLOSE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>`;

const state = {
  meta: null,
  summary: null,
  scene: "all",
  favoritesOnly: false,
  favorites: new Set(),
  removed: new Set(),
  hidden: new Set(),
  selected: new Set(),
  tiles: new Map(),
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
  downloadFavoritesCsv: document.querySelector("#downloadFavoritesCsv"),
  findMyPhotos: document.querySelector("#findMyPhotos"),
  visitorRole: document.querySelector("#visitorRole"),
  selectionBar: document.querySelector("#selectionBar"),
  selectionCount: document.querySelector("#selectionCount"),
  selectionDownload: document.querySelector("#selectionDownload"),
  selectionHide: document.querySelector("#selectionHide"),
  selectionCover: document.querySelector("#selectionCover"),
  selectionDelete: document.querySelector("#selectionDelete"),
  selectionClear: document.querySelector("#selectionClear"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxScene: document.querySelector("#lightboxScene"),
  lightboxFilename: document.querySelector("#lightboxFilename"),
  lightboxFavorite: document.querySelector("#lightboxFavorite"),
  lightboxHide: document.querySelector("#lightboxHide"),
  lightboxRemove: document.querySelector("#lightboxRemove"),
  lightboxDownload: document.querySelector("#lightboxDownload"),
  closeLightbox: document.querySelector("#closeLightbox"),
  previousImage: document.querySelector("#previousImage"),
  nextImage: document.querySelector("#nextImage")
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
  await loadHidden();
  await resetGrid();
  observeSentinel();
  scrollToGalleryTop();
}

// The access form can leave the page scrolled down (e.g. mobile keyboard); jump to the gallery's title card.
// Runs after the grid has rendered (double rAF) so later layout/image loads can't undo the scroll.
function scrollToGalleryTop() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      elements.galleryView.scrollIntoView({ block: "start", behavior: "auto" });
    });
  });
}

function applyPermissions() {
  elements.showFavorites.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.downloadFavoritesCsv.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.lightboxFavorite.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.lightboxHide.classList.toggle("hidden", state.role !== "client");
  elements.lightboxRemove.classList.toggle("hidden", state.role !== "client");
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
      label.textContent = scene.name === "all" ? "All" : scene.name;
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
  state.tiles.clear();
  state.selected.clear();
  renderSelectionBar();
  elements.galleryGrid.replaceChildren();
  elements.showAll.classList.toggle("active", !state.favoritesOnly);
  elements.showFavorites.classList.toggle("active", state.favoritesOnly);
  updateFavoriteCount();
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
  const isClient = state.role === "client";
  const tile = document.createElement("article");
  tile.className = "photo-tile";
  tile.dataset.imageId = image.id;
  tile.classList.toggle("selected", state.selected.has(image.id));
  tile.classList.toggle("is-hidden-from-guests", isClient && state.hidden.has(image.id));

  const img = document.createElement("img");
  img.src = image.thumbnailUrl;
  img.alt = image.filename;
  img.loading = "lazy";
  img.decoding = "async";
  // Once a selection is in progress, tapping a photo extends the selection instead of opening it.
  img.addEventListener("click", () => {
    if (isClient && state.selected.size) toggleSelect(image.id);
    else openLightbox(index);
  });

  const numberTag = document.createElement("span");
  numberTag.className = "image-number-tag";
  numberTag.textContent = `#${image.sceneIndex}`;

  tile.append(img, numberTag);

  const topOverlay = document.createElement("div");
  topOverlay.className = "tile-overlay tile-overlay-top";

  const bottomOverlay = document.createElement("div");
  bottomOverlay.className = "tile-overlay tile-overlay-bottom";

  if (state.permissions.canFavorite) {
    const favorite = document.createElement("button");
    favorite.type = "button";
    favorite.className = `favorite-button ${state.favorites.has(image.id) ? "active" : ""}`;
    favorite.innerHTML = "&hearts;";
    favorite.title = "Toggle favorite";
    favorite.setAttribute("aria-label", "Toggle favorite");
    favorite.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavorite(image.id);
      favorite.classList.toggle("active", state.favorites.has(image.id));
    });
    topOverlay.append(favorite);
  }

  if (isClient) {
    const select = document.createElement("button");
    select.type = "button";
    select.className = `tile-select ${state.selected.has(image.id) ? "active" : ""}`;
    select.title = "Select photo";
    select.setAttribute("aria-label", "Select photo");
    select.setAttribute("aria-pressed", String(state.selected.has(image.id)));
    select.innerHTML = CHECK_ICON;
    select.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSelect(image.id);
    });
    bottomOverlay.append(select);
  } else if (state.permissions.canDownloadSingle) {
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
    bottomOverlay.append(download);
  }

  tile.append(topOverlay, bottomOverlay);
  state.tiles.set(image.id, tile);
  return tile;
}

// ============================================================================
// Multi-select actions (client-only)
// ============================================================================

function toggleSelect(imageId) {
  if (state.role !== "client") return;

  if (state.selected.has(imageId)) state.selected.delete(imageId);
  else state.selected.add(imageId);

  paintSelection(imageId);
  renderSelectionBar();
}

function paintSelection(imageId) {
  const tile = state.tiles.get(imageId);
  if (!tile) return;

  const isSelected = state.selected.has(imageId);
  tile.classList.toggle("selected", isSelected);

  const button = tile.querySelector(".tile-select");
  if (button) {
    button.classList.toggle("active", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  }
}

function clearSelection() {
  const ids = [...state.selected];
  state.selected.clear();
  ids.forEach(paintSelection);
  renderSelectionBar();
}

function selectedImages() {
  return state.images.filter((image) => state.selected.has(image.id));
}

function renderSelectionBar() {
  if (!elements.selectionBar) return;

  const ids = [...state.selected];
  elements.selectionBar.classList.toggle("hidden", ids.length === 0);
  elements.selectionCount.textContent = String(ids.length);
  elements.selectionCover.classList.toggle("hidden", ids.length !== 1);
  elements.selectionDownload.classList.toggle("hidden", !state.permissions.canDownloadSingle);

  const allHidden = ids.length > 0 && ids.every((id) => state.hidden.has(id));
  elements.selectionHide.innerHTML = allHidden ? HIDDEN_ICON : HIDE_ICON;
  elements.selectionHide.classList.toggle("active", allHidden);
  elements.selectionHide.title = allHidden ? "Unhide from guests" : "Hide from guests";
  elements.selectionHide.setAttribute("aria-label", elements.selectionHide.title);
  elements.selectionHide.dataset.label = allHidden ? "Unhide" : "Hide";
}

function downloadSelected() {
  const images = selectedImages();
  if (!images.length) return;

  // Browsers throttle simultaneous downloads, so stagger the anchor clicks.
  images.forEach((image, position) => {
    setTimeout(() => {
      const link = document.createElement("a");
      link.href = image.downloadUrl;
      link.target = "_blank";
      link.rel = "noopener";
      link.download = image.filename;
      document.body.append(link);
      link.click();
      link.remove();
    }, position * 400);
  });
}

function hideSelected() {
  if (state.role !== "client") return;

  const ids = [...state.selected];
  if (!ids.length) return;

  const allHidden = ids.every((id) => state.hidden.has(id));
  ids.forEach((id) => {
    if (allHidden) state.hidden.delete(id);
    else state.hidden.add(id);
    state.tiles.get(id)?.classList.toggle("is-hidden-from-guests", state.hidden.has(id));
  });

  writeHidden([...state.hidden]);
  scheduleHiddenSync();
  renderSelectionBar();
  if (elements.lightbox.open) renderLightbox();
}

async function deleteSelected() {
  if (state.role !== "client") return;

  const images = selectedImages();
  if (!images.length) return;
  if (!window.confirm(`Permanently remove ${images.length} photo${images.length === 1 ? "" : "s"}? They are moved to the Google Drive trash and removed from the gallery for everyone.`)) return;

  let failures = 0;
  let driveFailures = 0;

  for (const image of images) {
    const result = await deleteImage(image, state.tiles.get(image.id));
    if (!result.ok) failures += 1;
    else if (result.driveTrashed === false) driveFailures += 1;
  }

  clearSelection();

  if (failures) window.alert(`${failures} photo${failures === 1 ? "" : "s"} could not be removed.`);
  else if (driveFailures) window.alert(`${driveFailures} photo${driveFailures === 1 ? "" : "s"} were removed from the gallery but could not be deleted from Google Drive (the service account lacks permission).`);
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
  updateFavoriteCount();
  if (elements.lightbox.open) renderLightbox();
}

function updateFavoriteCount() {
  elements.showFavorites.textContent = `Favorites (${state.favorites.size})`;
}

function openLightbox(index) {
  state.lightboxIndex = index;
  renderLightbox();
  elements.lightbox.showModal();
}

function renderLightbox() {
  const image = state.images[state.lightboxIndex];
  if (!image) return;

  elements.lightboxImage.src = image.thumbnailUrl || image.url;
  elements.lightboxImage.alt = image.filename;
  elements.lightboxScene.textContent = `${image.scene} #${image.sceneIndex}`;
  elements.lightboxFilename.textContent = image.filename;

  const isFavorite = state.favorites.has(image.id);
  elements.lightboxFavorite.classList.toggle("active", isFavorite);
  elements.lightboxFavorite.title = isFavorite ? "Remove favorite" : "Add favorite";
  elements.lightboxFavorite.setAttribute("aria-label", elements.lightboxFavorite.title);
  elements.lightboxFavorite.dataset.label = isFavorite ? "Favorited" : "Favorite";

  const isHidden = state.hidden.has(image.id);
  elements.lightboxHide.innerHTML = isHidden ? HIDDEN_ICON : HIDE_ICON;
  elements.lightboxHide.classList.toggle("active", isHidden);
  elements.lightboxHide.title = isHidden ? "Unhide from guests" : "Hide from guests";
  elements.lightboxHide.setAttribute("aria-label", elements.lightboxHide.title);
  elements.lightboxHide.dataset.label = isHidden ? "Unhide" : "Hide";

  elements.lightboxDownload.href = image.downloadUrl;
  elements.lightboxDownload.setAttribute("download", image.filename);

  if (image.url && image.url !== elements.lightboxImage.src) {
    const fullImage = new Image();
    fullImage.onload = () => {
      if (state.images[state.lightboxIndex]?.id === image.id) {
        elements.lightboxImage.src = image.url;
      }
    };
    fullImage.src = image.url;
  }
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

  void deleteImage(image, tile || state.tiles.get(image.id)).then((result) => {
    if (!result.ok) window.alert(result.error);
    else if (result.driveTrashed === false) {
      window.alert("Photo removed from the gallery. It could not be deleted from Google Drive (the service account lacks permission), so the original file still exists in Drive.");
    }
  });
}

async function deleteImage(image, tile) {
  let payload = {};
  try {
    const response = await apiFetch(`/files/${encodeURIComponent(image.id)}`, { method: "DELETE" });
    payload = await response.json().catch(() => ({}));
  } catch (error) {
    return { ok: false, error: error.message || "Unable to remove the photo." };
  }

  state.removed.add(image.id);
  state.selected.delete(image.id);
  state.tiles.delete(image.id);
  tile?.remove();
  if (elements.lightbox.open) elements.lightbox.close();

  return { ok: true, driveTrashed: payload?.driveTrashed };
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
  updateFavoriteCount();
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

// ============================================================================
// Hidden Photos (client-only feature)
// ============================================================================

function readHidden() {
  try {
    return JSON.parse(localStorage.getItem(hiddenStorageKey())) || [];
  } catch {
    return [];
  }
}

function writeHidden(hidden) {
  localStorage.setItem(hiddenStorageKey(), JSON.stringify(hidden));
}

function hiddenStorageKey() {
  return `starz-shots:hidden:${gallerySlug}`;
}

// Server is the source of truth; localStorage is an offline cache.
async function loadHidden() {
  try {
    const payload = await (await apiFetch("/hidden")).json();
    state.hidden = new Set(Array.isArray(payload.ids) ? payload.ids : []);
    writeHidden([...state.hidden]);
  } catch {
    state.hidden = new Set(readHidden());
  }
}

function toggleHide(imageId, tile = null) {
  if (state.role !== "client") return;

  if (state.hidden.has(imageId)) {
    state.hidden.delete(imageId);
  } else {
    state.hidden.add(imageId);
  }

  writeHidden([...state.hidden]);
  scheduleHiddenSync();

  const target = tile || state.tiles.get(imageId);
  target?.classList.toggle("is-hidden-from-guests", state.hidden.has(imageId));

  renderSelectionBar();
  if (elements.lightbox.open) renderLightbox();
}

let hiddenSyncTimer = null;

function scheduleHiddenSync() {
  if (hiddenSyncTimer) clearTimeout(hiddenSyncTimer);
  hiddenSyncTimer = setTimeout(syncHiddenToServer, 500);
}

async function syncHiddenToServer() {
  hiddenSyncTimer = null;
  try {
    await apiFetch("/hidden", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [...state.hidden] }),
      keepalive: true
    });
  } catch {
    // Still cached locally; the next toggle (or reload) will retry the sync.
  }
}

async function setCoverImage(imageId, tile) {
  if (state.role !== "client") return;

  try {
    const response = await apiFetch(`/cover-image/${encodeURIComponent(imageId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" }
    });

    if (response.ok) {
      const data = await response.json();
      if (data.ok) {
        if (elements.coverImage) {
          elements.coverImage.src = data.coverImage;
          elements.coverImage.alt = `Cover photo`;
        }

        const previousCover = elements.galleryGrid.querySelector(".photo-tile.is-cover");
        previousCover?.classList.remove("is-cover");
        (tile || state.tiles.get(imageId))?.classList.add("is-cover");
      }
    }
  } catch (error) {
    console.error("Error setting cover image:", error);
  }
}

function formatDate(dateValue) {
  if (!dateValue) return "";
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return String(dateValue);
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(parsed);
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

  elements.downloadFavoritesCsv.addEventListener("click", downloadFavoritesCsv);

  elements.selectionDownload.innerHTML = DOWNLOAD_ICON;
  elements.selectionHide.innerHTML = HIDE_ICON;
  elements.selectionCover.innerHTML = CROWN_ICON;
  elements.selectionDelete.innerHTML = TRASH_ICON;
  elements.selectionClear.innerHTML = CLOSE_ICON;

  elements.lightboxFavorite.innerHTML = "&hearts;";
  elements.lightboxHide.innerHTML = HIDE_ICON;
  elements.lightboxRemove.innerHTML = TRASH_ICON;
  elements.lightboxDownload.innerHTML = DOWNLOAD_ICON;

  elements.selectionDownload.addEventListener("click", downloadSelected);
  elements.selectionHide.addEventListener("click", hideSelected);
  elements.selectionDelete.addEventListener("click", () => void deleteSelected());
  elements.selectionClear.addEventListener("click", clearSelection);
  elements.selectionCover.addEventListener("click", () => {
    const [imageId] = [...state.selected];
    if (imageId) void setCoverImage(imageId);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.lightbox.open && state.selected.size) clearSelection();
  });

  elements.closeLightbox.addEventListener("click", () => elements.lightbox.close());
  elements.previousImage.addEventListener("click", () => moveLightbox(-1));
  elements.nextImage.addEventListener("click", () => moveLightbox(1));
  elements.lightboxFavorite.addEventListener("click", () => {
    const image = state.images[state.lightboxIndex];
    if (image) toggleFavorite(image.id);
  });
  elements.lightboxHide.addEventListener("click", () => {
    const image = state.images[state.lightboxIndex];
    if (image) toggleHide(image.id);
  });
  elements.lightboxRemove.addEventListener("click", () => {
    const image = state.images[state.lightboxIndex];
    if (image) removeImage(image);
  });

  // Flush a pending favorites/hidden save if the viewer leaves before the debounce fires.
  window.addEventListener("pagehide", () => {
    if (favoritesSyncTimer) {
      clearTimeout(favoritesSyncTimer);
      syncFavoritesToServer();
    }
    if (hiddenSyncTimer) {
      clearTimeout(hiddenSyncTimer);
      syncHiddenToServer();
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
