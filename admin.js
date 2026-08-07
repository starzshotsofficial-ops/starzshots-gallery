const storageKey = "starz-shots:admin-token";

const elements = {
  adminToken: document.querySelector("#adminToken"),
  saveToken: document.querySelector("#saveToken"),
  tokenStatus: document.querySelector("#tokenStatus"),
  createEventForm: document.querySelector("#createEventForm"),
  eventName: document.querySelector("#eventName"),
  eventDate: document.querySelector("#eventDate"),
  clientName: document.querySelector("#clientName"),
  slug: document.querySelector("#slug"),
  spacebyteRootFolderId: document.querySelector("#spacebyteRootFolderId"),
  spacebyteFolderPath: document.querySelector("#spacebyteFolderPath"),
  clientCode: document.querySelector("#clientCode"),
  guestCode: document.querySelector("#guestCode"),
  allowedViewers: document.querySelector("#allowedViewers"),
  createStatus: document.querySelector("#createStatus"),
  refreshEvents: document.querySelector("#refreshEvents"),
  eventsTableBody: document.querySelector("#eventsTableBody")
};

init();

function init() {
  const saved = localStorage.getItem(storageKey) || "";
  elements.adminToken.value = saved;
  elements.tokenStatus.textContent = saved ? "Token loaded from browser storage." : "Token is required for admin APIs.";

  elements.eventName.addEventListener("input", () => {
    if (!elements.slug.dataset.userEdited) {
      elements.slug.value = toSlug(elements.eventName.value);
    }
  });

  elements.slug.addEventListener("input", () => {
    elements.slug.dataset.userEdited = "true";
  });

  elements.saveToken.addEventListener("click", () => {
    const token = elements.adminToken.value.trim();
    if (!token) {
      elements.tokenStatus.textContent = "Enter a token first.";
      return;
    }

    localStorage.setItem(storageKey, token);
    elements.tokenStatus.textContent = "Token saved.";
    refreshEvents();
  });

  elements.refreshEvents.addEventListener("click", refreshEvents);

  elements.createEventForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.createStatus.textContent = "Creating event...";

    try {
      const payload = {
        eventName: elements.eventName.value.trim(),
        eventDate: elements.eventDate.value,
        clientName: elements.clientName.value.trim(),
        slug: elements.slug.value.trim(),
        spacebyteRootFolderId: elements.spacebyteRootFolderId.value.trim(),
        spacebyteFolderPath: elements.spacebyteFolderPath.value.trim(),
        clientCode: elements.clientCode.value.trim(),
        guestCode: elements.guestCode.value.trim() || "guest",
        allowedViewers: parseAllowedViewers(elements.allowedViewers.value)
      };

      await requestJson("/api/admin/events", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify(payload)
      });

      elements.createStatus.textContent = "Event created and saved to config/galleries.json.";
      elements.createEventForm.reset();
      elements.slug.dataset.userEdited = "";
      refreshEvents();
    } catch (error) {
      elements.createStatus.textContent = error.message;
    }
  });

  refreshEvents();
}

async function refreshEvents() {
  try {
    const payload = await requestJson("/api/admin/events?sync=true", { headers: adminHeaders() });
    renderEvents(payload.events || []);
  } catch (error) {
    elements.eventsTableBody.replaceChildren();
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.textContent = error.message;
    row.append(cell);
    elements.eventsTableBody.append(row);
  }
}

function renderEvents(events) {
  elements.eventsTableBody.replaceChildren(
    ...events.map((eventItem) => {
      const row = document.createElement("tr");
      row.append(createCell(eventItem.slug));
      row.append(createCell(eventItem.eventName));
      row.append(createCell(eventItem.eventDate));
      row.append(createCell(eventItem.clientName));
      row.append(createCell(eventItem.clientCode || "-"));
      row.append(createCell(eventItem.guestCode || "-"));
      row.append(createCell(eventItem.spacebyteRootFolderId || eventItem.spacebyteFolderPath || "-"));
      row.append(createCell(eventItem.allowedViewers || "-"));
      return row;
    })
  );
}

function createCell(value) {
  const cell = document.createElement("td");
  cell.textContent = value;
  return cell;
}

function parseAllowedViewers(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [nameRaw, identifiersRaw] = line.split("|");
      const name = (nameRaw || "").trim();
      const identifiers = String(identifiersRaw || "")
        .split(",")
        .map((identifier) => identifier.trim())
        .filter(Boolean);
      return { name, identifiers };
    })
    .filter((entry) => entry.name && entry.identifiers.length);
}

function toSlug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function adminHeaders() {
  const token = elements.adminToken.value.trim();
  return {
    "content-type": "application/json",
    "x-admin-token": token
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || "Request failed.");
  }

  return payload;
}
