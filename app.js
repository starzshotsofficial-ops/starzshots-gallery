const gallerySlug = "nakshathra-half-saree";
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
    scene.images.map((image) => `${scene.name}/${image.filename}: ${image.url}`)
  );
  const content = [
    state.gallery.eventName,
    `${state.gallery.clientName} - ${formatDate(state.gallery.eventDate)}`,
    "",
    ...imageUrls
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.gallery.slug}-download-links.txt`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function canManageGallery() {
  return state.role === "client";
}

async function removeImagePermanently(image) {
  if (!canManageGallery()) return;

  const confirmed = window.confirm(`Remove ${image.filename} permanently from SpaceByte? This cannot be undone.`);
  if (!confirmed) return;

  try {
    await requestJson(`/api/files/${encodeURIComponent(image.spacebyteEntryId)}`, {
      method: "DELETE",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        slug: state.gallery.slug,
        viewerId: state.viewerId,
        accessCode: state.accessCode
      })
    });

    for (const scene of state.gallery.scenes) {
      scene.images = scene.images.filter((entry) => String(entry.spacebyteEntryId) !== String(image.spacebyteEntryId));
    }

    state.favorites.delete(image.id);
    writeFavorites([...state.favorites]);
    renderScenes();
    renderGrid();

    if (elements.lightbox.open) {
      elements.lightbox.close();
    }
  } catch (error) {
    window.alert(error.message);
  }
}

function buildSubmissionFavorites() {
  const favoritesLookup = state.gallery.scenes.flatMap((scene) =>
    scene.images.map((image, index) => ({
      id: image.id,
      scene: scene.name,
      sceneIndex: index + 1,
      filename: image.filename,
      spacebyteEntryId: image.spacebyteEntryId,
      spacebyteHash: image.spacebyteHash
    }))
  );

  return favoritesLookup.filter((image) => state.favorites.has(image.id));
}

function downloadFavoritesCsv() {
  if (!canManageGallery()) return;

  const favorites = buildSubmissionFavorites();
  if (!favorites.length) {
    window.alert("No favorites selected yet.");
    return;
  }

  const rows = favorites.map((favorite) => `${csvEscape(`${favorite.scene} #${favorite.sceneIndex}`)},${csvEscape(favorite.filename)}`);
  const csv = ["Photo,Filename", ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.gallery.slug}-favorites.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || "Request failed.");
  }

  return payload;
}

elements.accessForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const access = getRoleForAccessCode(elements.accessCode.value);
  const viewerId = normalizeViewerId(elements.viewerId.value);

  if (!access) {
    elements.accessError.textContent = "That code does not match this gallery.";
    return;
  }

  if (!isValidViewerId(viewerId)) {
    elements.accessError.textContent = "Enter a valid email address or mobile number.";
    return;
  }

  if (!isAllowedClient(access, viewerId)) {
    elements.accessError.textContent = "This email or mobile number is not listed for client access.";
    return;
  }

  state.role = access.role;
  state.accessCode = elements.accessCode.value.trim();
  state.viewerId = viewerId;
  state.viewerLabel = getViewerLabel(access, viewerId);
  state.permissions = access.permissions;
  state.favorites = new Set(readFavorites());
  state.favoritesOnly = false;
  elements.accessError.textContent = "";

  try {
    await ensureGalleryLoaded();
  } catch (error) {
    elements.accessError.textContent = error.message;
    return;
  }

  openGallery();
});

elements.showAll.addEventListener("click", () => {
  state.favoritesOnly = false;
  renderGrid();
});

elements.showFavorites.addEventListener("click", () => {
  if (!state.permissions.canFavorite) return;

  state.favoritesOnly = true;
  renderGrid();
});

elements.downloadAll.addEventListener("click", downloadFullGallery);
elements.downloadFavoritesCsv.addEventListener("click", downloadFavoritesCsv);

elements.closeLightbox.addEventListener("click", () => elements.lightbox.close());
elements.previousImage.addEventListener("click", () => moveLightbox(-1));
elements.nextImage.addEventListener("click", () => moveLightbox(1));
elements.lightboxFavorite.addEventListener("click", () => {
  const image = state.visibleImages[state.lightboxIndex];
  if (image) toggleFavorite(image.id);
});
elements.lightboxRemove.addEventListener("click", async () => {
  const image = state.visibleImages[state.lightboxIndex];
  if (image) {
    await removeImagePermanently(image);
  }
});

document.addEventListener("keydown", (event) => {
  if (!elements.lightbox.open) return;
  if (event.key === "ArrowLeft") moveLightbox(-1);
  if (event.key === "ArrowRight") moveLightbox(1);
  if (event.key === "Escape") elements.lightbox.close();
});

loadGallery().catch((error) => {
  elements.accessError.textContent = error.message;
});
