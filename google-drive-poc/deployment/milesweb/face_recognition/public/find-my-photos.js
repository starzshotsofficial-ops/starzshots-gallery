"use strict";

const params = new URLSearchParams(window.location.search);
const slug = params.get("event") || "";
const basePath = window.location.pathname.replace(/\/find-my-photos.*$/, "");
const MAX_SELFIE_DIM = 720;

const state = {
  selfie: null,
  permissions: {},
  polling: false
};

const el = {
  eventName: document.querySelector("#eventName"),
  eventMeta: document.querySelector("#eventMeta"),
  backToGallery: document.querySelector("#backToGallery"),
  preview: document.querySelector("#preview"),
  selfieInput: document.querySelector("#selfieInput"),
  sensitivity: document.querySelector("#sensitivity"),
  searchButton: document.querySelector("#searchButton"),
  statusMessage: document.querySelector("#statusMessage"),
  progress: document.querySelector("#progress"),
  progressFill: document.querySelector("#progressFill"),
  progressLabel: document.querySelector("#progressLabel"),
  results: document.querySelector("#results"),
  resultsTitle: document.querySelector("#resultsTitle"),
  resultsCount: document.querySelector("#resultsCount"),
  resultsGrid: document.querySelector("#resultsGrid")
};

function galleryApi(suffix) {
  return `${basePath}/api/galleries/${encodeURIComponent(slug)}${suffix}`;
}

async function loadSummary() {
  el.backToGallery.href = `${basePath}/index.html?event=${encodeURIComponent(slug)}`;
  try {
    const response = await fetch(galleryApi("/summary"));
    if (response.status === 401) {
      window.location.href = `${basePath}/index.html?event=${encodeURIComponent(slug)}`;
      return;
    }
    if (!response.ok) return;
    const summary = await response.json();
    state.permissions = summary.permissions || {};
    el.eventName.textContent = summary.eventName || "Find my photos";
    el.eventMeta.textContent = summary.clientName
      ? `${summary.clientName} · upload a selfie to gather your photos.`
      : "Upload a selfie to gather your photos.";
  } catch {
    // The page still works without the summary; leave the defaults in place.
  }
}

function handleSelfieChange(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  setStatus("");

  const reader = new FileReader();
  reader.onload = () => downscaleToJpeg(reader.result);
  reader.onerror = () => setStatus("That file could not be read. Please try another photo.", true);
  reader.readAsDataURL(file);
}

function downscaleToJpeg(dataUrl) {
  const image = new Image();
  image.onload = () => {
    const scale = Math.min(1, MAX_SELFIE_DIM / Math.max(image.width, image.height));
    const width = Math.round(image.width * scale);
    const height = Math.round(image.height * scale);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);

    state.selfie = canvas.toDataURL("image/jpeg", 0.9);
    el.preview.style.backgroundImage = `url("${state.selfie}")`;
    el.preview.classList.add("has-image");
    el.searchButton.disabled = false;
  };
  image.onerror = () => setStatus("That image could not be opened. Please try another photo.", true);
  image.src = dataUrl;
}

async function runSearch() {
  if (!state.selfie) return;
  el.searchButton.disabled = true;
  hide(el.results);
  setStatus("Looking for your face…");

  try {
    const threshold = el.sensitivity.value;
    const response = await fetch(galleryApi(`/face/search?threshold=${threshold}`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: state.selfie })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setStatus(payload.error || "Something went wrong. Please try again.", true);
      el.searchButton.disabled = false;
      return;
    }

    if (payload.status === "indexing") {
      showProgress(payload.progress);
      scheduleReSearch();
      return;
    }

    if (payload.status === "preparing") {
      showSetup(payload.setup);
      scheduleReSearch();
      return;
    }

    hideProgress();
    if (payload.status === "no-face") {
      setStatus("We couldn't find a face in that selfie. Try a clearer, front-facing photo.", true);
      el.searchButton.disabled = false;
      return;
    }

    renderResults(payload.images || []);
    el.searchButton.disabled = false;
  } catch (error) {
    setStatus(error.message || "Network error. Please try again.", true);
    el.searchButton.disabled = false;
  }
}

function scheduleReSearch() {
  if (state.polling) return;
  state.polling = true;
  window.setTimeout(() => {
    state.polling = false;
    runSearch();
  }, 2500);
}

function showProgress(progress) {
  const total = Number(progress?.total || 0);
  const processed = Number(progress?.processed || 0);
  const percent = total ? Math.round((processed / total) * 100) : 0;
  setStatus("Preparing the gallery for face matching. This runs once and can take a few minutes.");
  show(el.progress);
  el.progressFill.style.width = `${percent}%`;
  el.progressLabel.textContent = total ? `${processed} of ${total} photos scanned` : "Starting…";
}

function showSetup(setup) {
  const phase = setup && setup.models !== "ready" && setup.deps === "ready" ? "Downloading face models" : "Setting up face matching";
  setStatus(`${phase}. This one-time step runs automatically — please keep this page open.`);
  show(el.progress);
  const info = setup && setup.progress;
  const percent = info && info.total ? Math.round((info.done / info.total) * 100) : 0;
  el.progressFill.style.width = `${percent}%`;
  el.progressLabel.textContent = info && info.total ? `${info.done} of ${info.total} model files` : "Getting things ready…";
}

function hideProgress() {
  hide(el.progress);
}

function renderResults(images) {
  el.resultsGrid.innerHTML = "";

  if (!images.length) {
    setStatus("No photos matched that selfie. Try the \"Loose\" sensitivity or a different selfie.", true);
    hide(el.results);
    return;
  }

  setStatus("");
  el.resultsTitle.textContent = "Your matches";
  el.resultsCount.textContent = `${images.length} photo${images.length === 1 ? "" : "s"} found`;

  const canDownload = state.permissions.canDownloadSingle !== false;
  const fragment = document.createDocumentFragment();

  for (const image of images) {
    const card = document.createElement("figure");
    card.className = "result-card";

    const link = document.createElement("a");
    link.href = image.url;
    link.target = "_blank";
    link.rel = "noopener";

    const thumb = document.createElement("img");
    thumb.loading = "lazy";
    thumb.src = image.thumbnailUrl;
    thumb.alt = image.scene ? `Photo from ${image.scene}` : "Matched photo";
    link.appendChild(thumb);
    card.appendChild(link);

    if (canDownload) {
      const download = document.createElement("a");
      download.className = "download-button";
      download.href = image.downloadUrl;
      download.textContent = "Download";
      download.setAttribute("download", "");
      card.appendChild(download);
    }

    fragment.appendChild(card);
  }

  el.resultsGrid.appendChild(fragment);
  show(el.results);
}

function setStatus(message, isError) {
  el.statusMessage.textContent = message;
  el.statusMessage.classList.toggle("error", Boolean(isError));
}

function show(node) {
  node.classList.remove("hidden");
}

function hide(node) {
  node.classList.add("hidden");
}

el.selfieInput.addEventListener("change", handleSelfieChange);
el.searchButton.addEventListener("click", runSearch);

loadSummary();
