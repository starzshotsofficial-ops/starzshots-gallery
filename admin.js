const state = {
  adminToken: sessionStorage.getItem("starz-admin-token") || ""
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
  folderBrowserForm: document.querySelector("#folderBrowserForm"),
  folderSearch: document.querySelector("#folderSearch"),
  browseFoldersButton: document.querySelector("#browseFoldersButton"),
  folderBrowserError: document.querySelector("#folderBrowserError"),
  folderBrowserResults: document.querySelector("#folderBrowserResults")
};

async function adminFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "X-Admin-Token": state.adminToken
    }
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
  elements.unlockView.classList.remove("hidden");
  elements.contentView.classList.add("hidden");
  elements.unlockError.textContent = message || "";
}

function unlock() {
  elements.unlockView.classList.add("hidden");
  elements.contentView.classList.remove("hidden");
  loadEvents();
}

async function loadEvents() {
  elements.eventsError.textContent = "";

  try {
    const response = await adminFetch("/api/admin/events");
    if (!response.ok) {
      throw new Error("Unable to load events.");
    }
    const payload = await response.json();
    renderEvents(payload.events || []);
  } catch (error) {
    elements.eventsError.textContent = error.message || "Unable to load events.";
  }
}

function renderEvents(events) {
  elements.eventsTableBody.replaceChildren(
    ...events.map((event) => createEventRow(event))
  );
}

function createEventRow(event) {
  const row = document.createElement("tr");

  const fields = {
    eventName: createCell("text", event.eventName),
    eventDate: createCell("date", event.eventDate),
    clientName: createCell("text", event.clientName),
    spacebyteFolderName: createCell("text", event.spacebyteFolderName),
    sceneFolderNames: createCell("text", (event.sceneFolderNames || []).join(", ")),
    coverImage: createCell("text", event.coverImage),
    clientCode: createCell("text", event.clientCode),
    guestCode: createCell("text", event.guestCode)
  };

  Object.values(fields).forEach(({ cell }) => row.append(cell));

  const actionsCell = document.createElement("td");
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "icon-button";
  saveButton.textContent = "Save";

  const status = document.createElement("span");
  status.className = "row-status muted";

  saveButton.addEventListener("click", async () => {
    status.textContent = "";
    status.classList.remove("error", "success");

    const body = {
      eventName: fields.eventName.input.value.trim(),
      eventDate: fields.eventDate.input.value.trim(),
      clientName: fields.clientName.input.value.trim(),
      spacebyteFolderName: fields.spacebyteFolderName.input.value.trim(),
      sceneFolderNames: fields.sceneFolderNames.input.value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
      coverImage: fields.coverImage.input.value.trim(),
      clientCode: fields.clientCode.input.value.trim(),
      guestCode: fields.guestCode.input.value.trim()
    };

    try {
      const response = await adminFetch(`/api/admin/events/${encodeURIComponent(event.slug)}`, {
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

  actionsCell.append(saveButton, status);
  row.append(actionsCell);

  return row;
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
    const response = await fetch("/api/admin/events", {
      headers: { "X-Admin-Token": token }
    });

    if (!response.ok) {
      throw new Error("Invalid admin token.");
    }

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
    spacebyteFolderPath: String(form.get("spacebyteFolderPath") || "").trim(),
    sceneFolderNames: String(form.get("sceneFolderNames") || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    coverImage: String(form.get("coverImage") || "").trim(),
    clientCode: String(form.get("clientCode") || "").trim(),
    guestCode: String(form.get("guestCode") || "").trim()
  };

  try {
    const response = await adminFetch("/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(payload.error || "Unable to create event.");
    }

    elements.createSuccess.textContent = `Created '${payload.event.eventName}'.`;
    elements.createForm.reset();
    elements.createForm.sceneFolderNames.value = "T.Photo, C.Photo";
    elements.createForm.guestCode.value = "guest";
    loadEvents();
  } catch (error) {
    elements.createError.textContent = error.message || "Unable to create event.";
  }
}

async function handleBrowseFolders() {
  elements.folderBrowserError.textContent = "";
  elements.folderBrowserResults.innerHTML = "";

  const searchTerm = elements.folderSearch.value.trim().toLowerCase();

  try {
    elements.folderBrowserError.textContent = "Searching folders...";
    const response = await adminFetch("/api/admin/browse-spacebyte-folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchTerm })
    });
    
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Unable to browse folders");
    }
    
    const payload = await response.json();
    elements.folderBrowserError.textContent = "";
    
    if (!payload.folders || payload.folders.length === 0) {
      elements.folderBrowserResults.innerHTML = "<p class='muted'>No folders found</p>";
      return;
    }
    
    const resultsHtml = payload.folders.map((folder) => `
      <div class="folder-result">
        <div class="folder-name">${folder.name}</div>
        <div class="folder-path-small">Path: ${folder.path || 'N/A'}</div>
        <div class="folder-id-small">ID: ${folder.id}</div>
        <button type="button" class="copy-path-button" data-path="${folder.path}" data-id="${folder.id}">Copy path</button>
      </div>
    `).join("");
    
    elements.folderBrowserResults.innerHTML = `<div class="folder-results">${resultsHtml}</div>`;
    
    // Add event listeners to copy buttons
    document.querySelectorAll(".copy-path-button").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const path = btn.getAttribute("data-path") || btn.getAttribute("data-id");
        elements.createForm.spacebyteFolderPath.value = path;
        elements.folderBrowserResults.innerHTML = "<p class='success'>Folder path copied to form!</p>";
      });
    });
  } catch (error) {
    elements.folderBrowserError.textContent = error.message || "Unable to browse folders";
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

  if (state.adminToken) {
    unlock();
  }
}

init();
