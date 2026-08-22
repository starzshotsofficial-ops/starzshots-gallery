const basePath = resolveBasePath();

const state = {
  adminToken: sessionStorage.getItem("starz-admin-token") || "",
  pollTimer: null
};

const elements = {
  unlockView: document.querySelector('[data-view="unlock"]'),
  contentView: document.querySelector('[data-view="content"]'),
  unlockForm: document.querySelector("#unlockForm"),
  adminToken: document.querySelector("#adminToken"),
  unlockError: document.querySelector("#unlockError"),
  lockButton: document.querySelector("#lockButton"),
  createForm: document.querySelector("#createForm"),
  createError: document.querySelector("#createError"),
  createSuccess: document.querySelector("#createSuccess"),
  eventsError: document.querySelector("#eventsError"),
  eventsTableBody: document.querySelector("#eventsTableBody"),
  folderSearch: document.querySelector("#folderSearch"),
  folderParentId: document.querySelector("#folderParentId"),
  browseFoldersButton: document.querySelector("#browseFoldersButton"),
  folderBrowserError: document.querySelector("#folderBrowserError"),
  folderBrowserResults: document.querySelector("#folderBrowserResults")
};

function resolveBasePath() {
  return window.location.pathname
    .replace(/\/(index|admin)\.html$/, "")
    .replace(/\/admin\/?$/, "")
    .replace(/\/$/, "");
}

async function adminFetch(suffix, options = {}) {
  const response = await fetch(`${basePath}/api/admin${suffix}`, {
    ...options,
    headers: { ...(options.headers || {}), "X-Admin-Token": state.adminToken }
  });

  if (response.status === 401) {
    lock("Invalid admin token.");
    throw new Error("Invalid admin token.");
  }

  return response;
}

function lock(message) {
  state.adminToken = "";
  sessionStorage.removeItem("starz-admin-token");
  clearInterval(state.pollTimer);
  elements.unlockView.classList.remove("hidden");
  elements.contentView.classList.add("hidden");
  elements.unlockError.textContent = message || "";
}

function unlock() {
  elements.unlockView.classList.add("hidden");
  elements.contentView.classList.remove("hidden");
  void loadEvents();
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(loadEvents, 10_000);
}

async function loadEvents() {
  elements.eventsError.textContent = "";

  try {
    const response = await adminFetch("/events");
    if (!response.ok) throw new Error("Unable to load events.");

    const payload = await response.json();
    elements.eventsTableBody.replaceChildren(...(payload.events || []).map(createEventRow));
  } catch (error) {
    elements.eventsError.textContent = error.message || "Unable to load events.";
  }
}

function createEventRow(event) {
  const row = document.createElement("tr");

  const fields = {
    eventName: createCell("text", event.eventName),
    eventDate: createCell("date", event.eventDate),
    clientName: createCell("text", event.clientName),
    spacebyteRootFolderId: createCell("text", event.spacebyteRootFolderId),
    spacebyteFolderName: createCell("text", event.spacebyteFolderName),
    sceneFolderNames: createCell("text", (event.sceneFolderNames || []).join(", ")),
    coverImage: createCell("text", event.coverImage),
    clientCode: createCell("text", event.clientCode),
    guestCode: createCell("text", event.guestCode)
  };

  Object.values(fields).forEach(({ cell }) => row.append(cell));
  row.append(createSyncCell(event));

  const actionsCell = document.createElement("td");
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "icon-button";
  saveButton.textContent = "Save";

  const syncButton = document.createElement("button");
  syncButton.type = "button";
  syncButton.className = "icon-button";
  syncButton.textContent = "Rebuild cache";

  const status = document.createElement("span");
  status.className = "row-status muted";

  saveButton.addEventListener("click", async () => {
    status.textContent = "";
    status.classList.remove("error", "success");

    const body = {
      eventName: fields.eventName.input.value.trim(),
      eventDate: fields.eventDate.input.value.trim(),
      clientName: fields.clientName.input.value.trim(),
      spacebyteRootFolderId: fields.spacebyteRootFolderId.input.value.trim(),
      spacebyteFolderName: fields.spacebyteFolderName.input.value.trim(),
      sceneFolderNames: fields.sceneFolderNames.input.value.split(",").map((name) => name.trim()).filter(Boolean),
      coverImage: fields.coverImage.input.value.trim(),
      clientCode: fields.clientCode.input.value.trim(),
      guestCode: fields.guestCode.input.value.trim()
    };

    try {
      const response = await adminFetch(`/events/${encodeURIComponent(event.slug)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || "Unable to save event.");
      }

      status.textContent = "Saved.";
      status.classList.add("success");
    } catch (error) {
      status.textContent = error.message || "Unable to save event.";
      status.classList.add("error");
    }
  });

  syncButton.addEventListener("click", async () => {
    status.textContent = "";
    status.classList.remove("error", "success");

    try {
      const response = await adminFetch(`/events/${encodeURIComponent(event.slug)}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: true })
      });

      if (!response.ok) throw new Error("Unable to start the cache job.");

      status.textContent = "Cache job queued.";
      status.classList.add("success");
    } catch (error) {
      status.textContent = error.message || "Unable to start the cache job.";
      status.classList.add("error");
    }
  });

  actionsCell.append(saveButton, syncButton, status);
  row.append(actionsCell);
  return row;
}

function createSyncCell(event) {
  const cell = document.createElement("td");
  cell.className = "sync-cell";

  const sync = event.sync || {};
  const label = document.createElement("div");
  label.textContent = describeSync(sync);

  const detail = document.createElement("div");
  detail.className = "muted";
  detail.textContent = `${sync.cachedThumbnails || 0} / ${sync.totalImages || 0} thumbnails`;

  cell.append(label, detail);

  if (sync.error) {
    const error = document.createElement("div");
    error.className = "error";
    error.textContent = sync.error;
    cell.append(error);
  }

  return cell;
}

function describeSync(sync) {
  if (sync.queued) return "Queued";
  if (sync.status === "listing") return "Reading SpaceByte…";
  if (sync.status === "caching") return "Caching thumbnails…";
  if (sync.status === "ready") return "Ready";
  if (sync.status === "error") return "Failed";
  return "Not cached yet";
}

function createCell(type, value) {
  const cell = document.createElement("td");
  const input = document.createElement("input");
  input.type = type;
  input.value = value || "";
  cell.append(input);
  return { cell, input };
}

async function handleUnlockSubmit(event) {
  event.preventDefault();
  elements.unlockError.textContent = "";

  const token = elements.adminToken.value.trim();
  if (!token) {
    elements.unlockError.textContent = "Enter an admin token.";
    return;
  }

  state.adminToken = token;

  try {
    const response = await adminFetch("/events");
    if (!response.ok) throw new Error("Invalid admin token.");

    sessionStorage.setItem("starz-admin-token", token);
    unlock();
  } catch (error) {
    state.adminToken = "";
    elements.unlockError.textContent = error.message || "Invalid admin token.";
  }
}

async function handleCreateSubmit(event) {
  event.preventDefault();
  elements.createError.textContent = "";
  elements.createSuccess.textContent = "";

  const form = new FormData(elements.createForm);
  const body = {
    eventName: String(form.get("eventName") || "").trim(),
    eventDate: String(form.get("eventDate") || "").trim(),
    clientName: String(form.get("clientName") || "").trim(),
    slug: String(form.get("slug") || "").trim(),
    spacebyteRootFolderId: String(form.get("spacebyteRootFolderId") || "").trim(),
    spacebyteFolderName: String(form.get("spacebyteFolderName") || "").trim(),
    sceneFolderNames: String(form.get("sceneFolderNames") || "").split(",").map((name) => name.trim()).filter(Boolean),
    coverImage: String(form.get("coverImage") || "").trim(),
    clientCode: String(form.get("clientCode") || "").trim(),
    guestCode: String(form.get("guestCode") || "").trim()
  };

  try {
    const response = await adminFetch("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to create event.");

    elements.createSuccess.textContent = `Created '${payload.event.eventName}'. The thumbnail cache job has been queued.`;
    elements.createForm.reset();
    elements.createForm.sceneFolderNames.value = "T.Photo, C.Photo";
    elements.createForm.guestCode.value = "guest";
    void loadEvents();
  } catch (error) {
    elements.createError.textContent = error.message || "Unable to create event.";
  }
}

async function handleBrowseFolders() {
  elements.folderBrowserError.textContent = "Searching folders…";
  elements.folderBrowserResults.replaceChildren();

  try {
    const response = await adminFetch("/browse-spacebyte-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        searchTerm: elements.folderSearch.value.trim().toLowerCase(),
        parentId: elements.folderParentId.value.trim()
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Unable to browse folders.");

    elements.folderBrowserError.textContent = "";

    if (!payload.folders?.length) {
      elements.folderBrowserResults.textContent = "No folders found.";
      return;
    }

    elements.folderBrowserResults.replaceChildren(
      ...payload.folders.map((folder) => {
        const item = document.createElement("div");
        item.className = "folder-result";

        const name = document.createElement("div");
        name.className = "folder-name";
        name.textContent = folder.name;

        const id = document.createElement("div");
        id.className = "folder-id-small muted";
        id.textContent = `ID: ${folder.id}`;

        const useButton = document.createElement("button");
        useButton.type = "button";
        useButton.className = "icon-button";
        useButton.textContent = "Use this folder";
        useButton.addEventListener("click", () => {
          elements.createForm.spacebyteRootFolderId.value = folder.id;
          elements.createForm.spacebyteFolderName.value = folder.name;
          elements.folderBrowserError.textContent = `'${folder.name}' (ID ${folder.id}) copied into the create form.`;
        });

        item.append(name, id, useButton);
        return item;
      })
    );
  } catch (error) {
    elements.folderBrowserError.textContent = error.message || "Unable to browse folders.";
  }
}

function bindUiEvents() {
  elements.unlockForm.addEventListener("submit", handleUnlockSubmit);
  elements.createForm.addEventListener("submit", handleCreateSubmit);
  elements.lockButton.addEventListener("click", () => lock(""));
  elements.browseFoldersButton.addEventListener("click", handleBrowseFolders);
}

function init() {
  bindUiEvents();
  if (state.adminToken) unlock();
}

init();
