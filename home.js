const photoGrid = document.querySelector("#photo-grid");

function shuffle(items) {
  return [...items].sort(() => Math.random() - 0.5);
}

async function renderPhotos() {
  try {
    const response = await fetch("/api/home-photos", { cache: "no-store" });
    if (!response.ok) throw new Error("Portfolio photos could not be loaded.");
    const { photos } = await response.json();

    shuffle(Array.isArray(photos) ? photos : []).slice(0, 18).forEach((src, index) => {
      const figure = document.createElement("figure");
      figure.className = `photo-card photo-card-${(index % 6) + 1}`;
      const image = document.createElement("img");
      image.src = src;
      image.alt = "Starz Shots photography portfolio";
      image.loading = index < 4 ? "eager" : "lazy";
      image.addEventListener("error", () => figure.remove());
      figure.append(image);
      photoGrid.append(figure);
    });
  } catch (error) {
    photoGrid.innerHTML = '<p class="photo-note">Portfolio images are being prepared.</p>';
  }
}

renderPhotos();