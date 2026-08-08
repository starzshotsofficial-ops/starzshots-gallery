const gallerySlug = "nakshathra-half-saree-function";
const gallerySource = `/api/galleries/${gallerySlug}`;
const galleryMetaSource = `/api/galleries/${gallerySlug}/meta`;

const state = {
  gallery: null,
  galleryMeta: null,
  scene: "all",
  favoritesOnly: false,
  favorites: new Set(),
  role: null,
  accessCode: null,
  viewerId: null,
  viewerLabel: null,
  permissions: {},
  visibleImages: [],
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
  showAll: document.querySelector("#showAll"),
  showFavorites: document.querySelector("#showFavorites"),
  downloadAll: document.querySelector("#downloadAll"),
  downloadFavoritesCsv: document.querySelector("#downloadFavoritesCsv"),
  visitorRole: document.querySelector("#visitorRole"),
  favoriteCount: document.querySelector("#favoriteCount"),
  lightbox: document.querySelector("#lightbox"),
  lightboxImage: document.querySelector("#lightboxImage"),
  lightboxScene: document.querySelector("#lightboxScene"),
  lightboxFilename: document.querySelector("#lightboxFilename"),
  lightboxFavorite: document.querySelector("#lightboxFavorite"),
  lightboxRemove: document.querySelector("#lightboxRemove"),
  lightboxDownload: document.querySelector("#lightboxDownload"),
  closeLightbox: document.querySelector("#closeLightbox"),
  previousImage: document.querySelector("#previousImage"),
  nextImage: document.querySelector("#nextImage")
};

let fullGalleryPromise = null;

async function loadGallery() {
  if (window.STARZ_SAMPLE_GALLERY && window.location.protocol === "file:") {
    state.gallery = window.STARZ_SAMPLE_GALLERY;
    state.galleryMeta = buildMetaFromGallery(window.STARZ_SAMPLE_GALLERY);
    renderAccess();
    return;
  }

  try {
    const response = await fetch(galleryMetaSource);
    if (!response.ok) {
      throw new Error("Gallery data could not be loaded.");
    }
    state.galleryMeta = await response.json();
    prefetchFullGallery();
  } catch (error) {
    if (!window.STARZ_SAMPLE_GALLERY) {
      throw error;
    }
    state.gallery = window.STARZ_SAMPLE_GALLERY;
    state.galleryMeta = buildMetaFromGallery(window.STARZ_SAMPLE_GALLERY);
  }

  renderAccess();
}

function renderAccess() {
  const meta = state.galleryMeta || state.gallery;
  if (!meta) return;

  elements.accessTitle.textContent = meta.eventName;
  elements.accessMeta.textContent = `${meta.clientName} - ${formatDate(meta.eventDate)}`;
  elements.viewerId.focus();
}

function openGallery() {
  elements.accessView.classList.add("hidden");
  elements.galleryView.classList.remove("hidden");

  elements.coverImage.src = state.gallery.coverImage;
  elements.coverImage.alt = `${state.gallery.eventName} cover`;
  elements.eventName.textContent = state.gallery.eventName;
  elements.eventDate.textContent = formatDate(state.gallery.eventDate);
  elements.clientName.textContent = state.gallery.clientName;
  elements.visitorRole.textContent = `${state.role === "client" ? "Client" : "Guest"}: ${state.viewerLabel}`;
  applyPermissions();

  renderScenes();
  renderGrid();
}

function applyPermissions() {
  elements.showFavorites.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.downloadAll.classList.toggle("hidden", !state.permissions.canDownloadAll);
  elements.downloadFavoritesCsv.classList.toggle("hidden", !canManageGallery());
  elements.lightboxFavorite.classList.toggle("hidden", !state.permissions.canFavorite);
  elements.lightboxDownload.classList.toggle("hidden", !state.permissions.canDownloadSingle);
  elements.lightboxRemove.classList.toggle("hidden", !canManageGallery());
}

function renderScenes() {
  const sceneNames = ["all", ...state.gallery.scenes.map((scene) => scene.name)];
  const favoriteCounts = getFavoriteCountsByScene();
  const totalCounts = getTotalCountsByScene();

  elements.sceneTabs.replaceChildren(
    ...sceneNames.map((sceneName) => {
      const button = document.createElement("button");
      const label = document.createElement("span");
      const count = document.createElement("span");
      const favoritesForScene = sceneName === "all" ? state.favorites.size : favoriteCounts.get(sceneName) || 0;
      const totalForScene = sceneName === "all"
        ? state.gallery.scenes.reduce((total, scene) => total + scene.images.length, 0)
        : totalCounts.get(sceneName) || 0;

      button.type = "button";
      button.className = `tab ${state.scene === sceneName ? "active" : ""}`;
      label.textContent = sceneName === "all" ? "All Scenes" : sceneName;
      button.append(label);
      count.className = `tab-count ${favoritesForScene > 0 ? "has-favorites" : ""}`;
      count.textContent = `${favoritesForScene} / ${totalForScene}`;
      count.title = `${favoritesForScene} selected out of ${totalForScene} photos`;
      button.append(count);
      button.addEventListener("click", () => {
        state.scene = sceneName;
        state.favoritesOnly = false;
        renderScenes();
        renderGrid();
      });
      return button;
    })
  );
}

function renderGrid() {
  state.visibleImages = getFilteredImages();
  elements.galleryGrid.replaceChildren(
    ...state.visibleImages.map((image, index) => createTile(image, index))
  );

  elements.showAll.classList.toggle("active", !state.favoritesOnly);
  elements.showFavorites.classList.toggle("active", state.favoritesOnly);
  elements.favoriteCount.textContent = state.favorites.size;

  if (state.visibleImages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No photos in this view yet.";
    elements.galleryGrid.append(empty);
  }
}

function createTile(image, index) {
  const tile = document.createElement("article");
  tile.className = "photo-tile";

  const img = document.createElement("img");
  img.src = image.thumbnailUrl || image.url;
  img.alt = image.filename;
  img.loading = "lazy";
  img.addEventListener("click", () => openLightbox(index));

  const favorite = document.createElement("button");
  favorite.type = "button";
  favorite.className = `favorite-button ${state.favorites.has(image.id) ? "active" : ""}`;
  favorite.innerHTML = "&hearts;";
  favorite.title = "Toggle favorite";
  favorite.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleFavorite(image.id);
  });

  const download = document.createElement("a");
  download.className = "tile-download";
  download.href = image.downloadUrl || image.url;
  download.target = "_blank";
  download.rel = "noopener";
  download.textContent = "Download";
  download.title = "Download photo";
  download.addEventListener("click", (event) => event.stopPropagation());

  const numberTag = document.createElement("span");
  numberTag.className = "image-number-tag";
  numberTag.textContent = `#${image.sceneIndex}`;

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "tile-remove";
  remove.textContent = "Remove";
  remove.title = "Remove photo permanently";
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    await removeImagePermanently(image);
  });

  tile.append(img);
  tile.append(numberTag);
  if (state.permissions.canFavorite) {
    tile.append(favorite);
  }
  if (state.permissions.canDownloadSingle) {
    tile.append(download);
  }
  if (canManageGallery()) {
    tile.append(remove);
  }
  return tile;
}

function getFilteredImages() {
  const allImages = state.gallery.scenes.flatMap((scene) =>
    scene.images.map((image, index) => ({ ...image, scene: scene.name, sceneIndex: index + 1 }))
  );

  return allImages.filter((image) => {
    const sceneMatches = state.scene === "all" || image.scene === state.scene;
    const favoriteMatches = !state.favoritesOnly || state.favorites.has(image.id);
    return sceneMatches && favoriteMatches;
  });
}

function toggleFavorite(imageId) {
  if (!state.permissions.canFavorite) return;

  if (state.favorites.has(imageId)) {
    state.favorites.delete(imageId);
  } else {
    state.favorites.add(imageId);
  }

  writeFavorites([...state.favorites]);
  renderScenes();
  renderGrid();

  if (elements.lightbox.open) {
    renderLightbox();
  }
}

function getFavoriteCountsByScene() {
  return state.gallery.scenes.reduce((counts, scene) => {
    const count = scene.images.filter((image) => state.favorites.has(image.id)).length;
    counts.set(scene.name, count);
    return counts;
  }, new Map());
}

function getTotalCountsByScene() {
  return state.gallery.scenes.reduce((counts, scene) => {
    counts.set(scene.name, scene.images.length);
    return counts;
  }, new Map());
}

function openLightbox(index) {
  state.lightboxIndex = index;
  renderLightbox();
  elements.lightbox.showModal();
}

function renderLightbox() {
  const image = state.visibleImages[state.lightboxIndex];
  if (!image) return;

  elements.lightboxImage.src = image.url;
  elements.lightboxImage.alt = image.filename;
  elements.lightboxScene.textContent = `${image.scene} #${image.sceneIndex}`;
  elements.lightboxFilename.textContent = image.filename;
  elements.lightboxFavorite.textContent = state.favorites.has(image.id) ? "Remove Favorite" : "Favorite";
  elements.lightboxDownload.href = image.downloadUrl || image.url;
  elements.lightboxDownload.setAttribute("download", image.filename);
}

function moveLightbox(direction) {
  const total = state.visibleImages.length;
  state.lightboxIndex = (state.lightboxIndex + direction + total) % total;
  renderLightbox();
}

function readFavorites() {
  const key = favoriteStorageKey();
  try {
    return JSON.parse(localStorage.getItem(key)) || [];
  } catch {
    return [];
  }
}

function writeFavorites(favorites) {
  localStorage.setItem(favoriteStorageKey(), JSON.stringify(favorites));
}

function favoriteStorageKey() {
  return `starz-shots:favorites:${state.gallery.slug}:${state.role}:${state.viewerId}`;
}

function formatDate(dateValue) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric"
  }).format(new Date(dateValue));
}

function getRoleForAccessCode(accessCode) {
  const enteredCode = accessCode.toLowerCase().trim();
  const meta = state.galleryMeta || state.gallery;
  const accessCodes = meta?.accessCodes || [
    {
      code: meta?.accessCode,
      role: "client",
      permissions: {
        canFavorite: true,
        canDownloadSingle: true,
        canDownloadAll: true
      }
    }
  ];

  return accessCodes.find((entry) => entry.code.toLowerCase().trim() === enteredCode);
}

function normalizeViewerId(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function buildMetaFromGallery(gallery) {
  return {
    eventName: gallery.eventName,
    eventDate: gallery.eventDate,
    clientName: gallery.clientName,
    slug: gallery.slug,
    accessCodes: gallery.accessCodes || [],
    coverImage: gallery.coverImage || ""
  };
}

function prefetchFullGallery() {
  if (state.gallery || fullGalleryPromise) return;

  fullGalleryPromise = fetch(gallerySource)
    .then((response) => {
      if (!response.ok) {
        throw new Error("Gallery photos could not be loaded.");
      }
      return response.json();
    })
    .then((gallery) => {
      state.gallery = gallery;
      return gallery;
    });
}

async function ensureGalleryLoaded() {
  if (state.gallery) return;

  prefetchFullGallery();
  state.gallery = await fullGalleryPromise;
}

function isValidViewerId(value) {
  const normalized = normalizeViewerId(value);
  const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
  const digits = normalized.replace(/\D/g, "");
  return looksLikeEmail || digits.length >= 8;
}

function isAllowedClient(access, viewerId) {
  if (access.role !== "client" || !access.allowedViewers?.length) {
    return true;
  }

  return access.allowedViewers.some((viewer) =>
    viewer.identifiers.some((identifier) => normalizeViewerId(identifier) === viewerId)
  );
}

function getViewerLabel(access, viewerId) {
  const viewer = access.allowedViewers?.find((entry) =>
    entry.identifiers.some((identifier) => normalizeViewerId(identifier) === viewerId)
  );

  return viewer?.name || viewerId;
}

function downloadFullGallery() {
  if (!state.permissions.canDownloadAll) return;

  if (state.gallery.apiDownloadAllUrl) {
    window.location.href = state.gallery.apiDownloadAllUrl;
    return;
  }

  const imageUrls = state.gallery.scenes.flatMap((scene) =>
    scene.images.map((image) => image.downloadUrl || image.url)
  );

  if (!imageUrls.length) {
    window.alert("No images are available for download.");
    return;
  }

  window.alert("Bulk download is not supported for this gallery. Opening the first image instead.");
  window.open(imageUrls[0], "_blank");
}

function downloadFavoritesCsv() {
  if (!canManageGallery()) return;

  const favoriteItems = state.gallery.scenes.flatMap((scene) =>
    scene.images
      .filter((image) => state.favorites.has(image.id))
      .map((image, index) => ({
        scene: scene.name,
        sceneIndex: scene.images.indexOf(image) + 1,
        filename: image.filename,
        url: image.downloadUrl || image.url
      }))
  );

  if (!favoriteItems.length) {
    window.alert("No favorites selected.");
    return;
  }

  const header = ["scene", "sceneIndex", "filename", "url"];
  const csv = [header.join(",")].concat(
    favoriteItems.map((item) => header.map((key) => JSON.stringify(item[key] || "")).join(","))
  ).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${state.gallery.slug}-favorites.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function canManageGallery() {
  return state.role === "client";
}

async function removeImagePermanently(image) {
  if (!canManageGallery()) return;

  if (!window.confirm("Are you sure you want to remove this photo?")) {
    return;
  }

  try {
    const response = await fetch(`/api/files/${encodeURIComponent(image.id)}`, {
      method: "DELETE"
    });

    if (!response.ok) {
      throw new Error("Unable to remove the photo.");
    }

    state.gallery.scenes = state.gallery.scenes.map((scene) => ({
      ...scene,
      images: scene.images.filter((img) => img.id !== image.id)
    }));

    renderGrid();
    if (elements.lightbox.open) {
      elements.lightbox.close();
    }
  } catch (error) {
    window.alert(error.message || "Failed to remove image.");
  }
}

function setAccessError(message) {
  elements.accessError.textContent = message || "";
}

function getViewerLabelForRole(access, viewerId) {
  if (!access || !viewerId) return viewerId;

  const viewer = access.allowedViewers?.find((entry) =>
    entry.identifiers.some((identifier) => normalizeViewerId(String(identifier)) === viewerId)
  );

  return viewer?.name || viewerId;
}

async function handleAccessFormSubmit(event) {
  event.preventDefault();
  setAccessError("");

  const rawViewerId = elements.viewerId.value;
  const accessCode = elements.accessCode.value;

  if (!rawViewerId || !accessCode) {
    setAccessError("Please enter both your name/email and access code.");
    return;
  }

  if (!isValidViewerId(rawViewerId)) {
    setAccessError("Enter a valid name or email address.");
    return;
  }

  const access = getRoleForAccessCode(accessCode);
  if (!access) {
    setAccessError("Invalid access code.");
    return;
  }

  const normalizedViewerId = normalizeViewerId(rawViewerId);
  if (access.role === "client" && access.allowedViewers?.length) {
    const allowed = access.allowedViewers.some((viewer) =>
      viewer.identifiers.some((identifier) => normalizeViewerId(String(identifier)) === normalizedViewerId)
    );

    if (!allowed) {
      setAccessError("You are not authorized to access this gallery with that code.");
      return;
    }
  }

  try {
    await ensureGalleryLoaded();
    state.role = access.role;
    state.viewerId = normalizedViewerId;
    state.viewerLabel = getViewerLabelForRole(access, normalizedViewerId);
    state.accessCode = accessCode;
    state.permissions = access.permissions || {
      canFavorite: true,
      canDownloadSingle: true,
      canDownloadAll: false
    };
    state.favorites = new Set(readFavorites());
    openGallery();
  } catch (error) {
    setAccessError(error.message || "Unable to load gallery data.");
  }
}

function bindUiEvents() {
  elements.accessForm.addEventListener("submit", handleAccessFormSubmit);
  elements.showAll.addEventListener("click", () => {
    state.favoritesOnly = false;
    renderScenes();
    renderGrid();
  });
  elements.showFavorites.addEventListener("click", () => {
    state.favoritesOnly = true;
    renderScenes();
    renderGrid();
  });
  elements.downloadAll.addEventListener("click", downloadFullGallery);
  elements.downloadFavoritesCsv.addEventListener("click", downloadFavoritesCsv);
  elements.closeLightbox.addEventListener("click", () => {
    if (elements.lightbox.open) elements.lightbox.close();
  });
  elements.previousImage.addEventListener("click", () => moveLightbox(-1));
  elements.nextImage.addEventListener("click", () => moveLightbox(1));
  elements.lightboxFavorite.addEventListener("click", () => {
    const image = state.visibleImages[state.lightboxIndex];
    if (!image) return;
    toggleFavorite(image.id);
  });
  elements.lightboxRemove.addEventListener("click", async () => {
    const image = state.visibleImages[state.lightboxIndex];
    if (!image) return;
    await removeImagePermanently(image);
  });
}

async function init() {
  bindUiEvents();

  try {
    await loadGallery();
  } catch (error) {
    setAccessError(error.message || "Failed to load gallery metadata.");
  }
}

init();
