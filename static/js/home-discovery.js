import { api } from "./api.js";

const DEBOUNCE_MS = 300;

let discoverDirty = true;
let cachedTrending = [];
let cachedNew = [];
let searchTimer = null;

function gameTitle(g) {
  const t = g.title;
  if (t != null && String(t).trim() !== "") return String(t).trim();
  return "Untitled";
}

export function createGameCardEl(g, variant) {
  const id = g.id;
  const title = gameTitle(g);
  const thumbUrl =
    g.thumbnail_url != null && String(g.thumbnail_url).trim() !== ""
      ? String(g.thumbnail_url).trim()
      : null;
  const author =
    g.owner_username != null && String(g.owner_username).trim() !== ""
      ? String(g.owner_username).trim()
      : null;
  const likes = Number(g.like_count) || 0;
  const plays = Number(g.play_count) || 0;

  const article = document.createElement("article");
  article.className =
    variant === "row"
      ? "home-game-card home-game-card--row"
      : "home-game-card home-game-card--grid";
  article.setAttribute("role", "listitem");

  const gameLink = document.createElement("a");
  gameLink.className = "home-game-card__game-link";
  gameLink.href = `/game/${encodeURIComponent(id)}`;

  const thumb = document.createElement("div");
  thumb.className = "home-game-card__thumb";
  if (thumbUrl) {
    const img = document.createElement("img");
    img.src = thumbUrl;
    img.alt = "";
    img.width = 128;
    img.height = 128;
    img.loading = "lazy";
    thumb.appendChild(img);
  } else {
    const ph = document.createElement("span");
    ph.className = "home-game-card__placeholder font-display";
    ph.setAttribute("aria-hidden", "true");
    ph.textContent = "?";
    thumb.appendChild(ph);
  }
  gameLink.appendChild(thumb);

  const h3 = document.createElement("h3");
  h3.className = "home-game-card__title";
  h3.textContent = title;
  gameLink.appendChild(h3);

  article.appendChild(gameLink);

  const meta = document.createElement("div");
  meta.className = "home-game-card__meta";

  if (author) {
    const au = document.createElement("a");
    au.className = "home-game-card__author";
    au.href = `/profile/${encodeURIComponent(author)}`;
    au.textContent = `@${author}`;
    meta.appendChild(au);
  } else {
    const span = document.createElement("span");
    span.className = "home-game-card__author home-game-card__author--unknown";
    span.textContent = "Unknown creator";
    meta.appendChild(span);
  }

  const stats = document.createElement("div");
  stats.className = "home-game-card__stats";
  stats.innerHTML = `<span><i data-lucide="play" class="home-stat-icon" aria-hidden="true"></i> ${plays.toLocaleString()}</span><span><i data-lucide="heart" class="home-stat-icon home-stat-icon--heart" aria-hidden="true"></i> ${likes.toLocaleString()}</span>`;
  meta.appendChild(stats);

  article.appendChild(meta);
  return article;
}

function renderRow(container, games, variant) {
  if (!container) return;
  container.replaceChildren();
  if (!Array.isArray(games) || games.length === 0) {
    const p = document.createElement("p");
    p.className = "home-row-empty";
    p.textContent = "No public games yet.";
    container.appendChild(p);
    return;
  }
  for (const g of games) {
    container.appendChild(createGameCardEl(g, variant));
  }
  if (typeof window.lucide !== "undefined") window.lucide.createIcons();
}

function setMode(searching) {
  const rowsEl = document.getElementById("home-discovery-rows");
  const searchEl = document.getElementById("home-search-results");
  const input = document.getElementById("home-game-search");
  if (rowsEl) rowsEl.hidden = searching;
  if (searchEl) searchEl.hidden = !searching;
  if (input) input.setAttribute("aria-expanded", searching ? "true" : "false");
}

function getSearchQuery() {
  const input = document.getElementById("home-game-search");
  if (!input) return "";
  return String(input.value ?? "").trim();
}

async function loadDiscoveryRows(options = {}) {
  const renderRows = options.renderRows !== false;
  const errEl = document.getElementById("home-discover-error");
  const trendingEl = document.getElementById("home-row-trending");
  const newEl = document.getElementById("home-row-new");
  if (!trendingEl || !newEl) return;

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  if (renderRows) {
    trendingEl.innerHTML =
      '<p class="home-row-loading" role="status">Loading…</p>';
    newEl.innerHTML = '<p class="home-row-loading" role="status">Loading…</p>';
  }

  try {
    const [tRes, nRes] = await Promise.all([
      api.get("/api/games?sort=trending"),
      api.get("/api/games?sort=new"),
    ]);
    cachedTrending = Array.isArray(tRes?.games) ? tRes.games : [];
    cachedNew = Array.isArray(nRes?.games) ? nRes.games : [];
    if (renderRows) {
      renderRow(trendingEl, cachedTrending, "row");
      renderRow(newEl, cachedNew, "row");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not load games";
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    if (renderRows) {
      trendingEl.replaceChildren();
      newEl.replaceChildren();
    }
  }
}

async function runSearch(query) {
  const grid = document.getElementById("home-search-grid");
  const emptyEl = document.getElementById("home-search-empty");
  const errEl = document.getElementById("home-discover-error");
  if (!grid) return;

  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }

  if (!query) {
    setMode(false);
    renderRow(document.getElementById("home-row-trending"), cachedTrending, "row");
    renderRow(document.getElementById("home-row-new"), cachedNew, "row");
    if (emptyEl) emptyEl.hidden = true;
    return;
  }

  setMode(true);
  grid.innerHTML = '<p class="home-search-loading" role="status">Searching…</p>';
  if (emptyEl) emptyEl.hidden = true;

  try {
    const q = encodeURIComponent(query);
    const res = await api.get(`/api/games?q=${q}`);
    const games = Array.isArray(res?.games) ? res.games : [];
    grid.replaceChildren();
    if (games.length === 0) {
      if (emptyEl) emptyEl.hidden = false;
    } else {
      if (emptyEl) emptyEl.hidden = true;
      for (const g of games) {
        grid.appendChild(createGameCardEl(g, "grid"));
      }
    }
    if (typeof window.lucide !== "undefined") window.lucide.createIcons();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Search failed";
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    grid.replaceChildren();
    if (emptyEl) emptyEl.hidden = true;
  }
}

function scheduleSearch() {
  if (searchTimer != null) clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    searchTimer = null;
    const q = getSearchQuery();
    void runSearch(q);
  }, DEBOUNCE_MS);
}

function bindSearchOnce() {
  const input = document.getElementById("home-game-search");
  if (!input || input.dataset.bound === "1") return;
  input.dataset.bound = "1";
  input.addEventListener("input", () => {
    scheduleSearch();
  });
}

export function syncNavSearchVisibility() {
  const wrap = document.getElementById("nav-game-search-wrap");
  if (!wrap) return;
  const home = document.getElementById("view-home");
  const visible = Boolean(home && !home.hidden);
  wrap.hidden = !visible;
}

export function syncHomeDiscovery() {
  if (window.location.pathname.startsWith("/develop")) {
    discoverDirty = true;
    return;
  }

  const trendingEl = document.getElementById("home-row-trending");
  if (!trendingEl) return;

  syncNavSearchVisibility();
  bindSearchOnce();

  if (!discoverDirty) return;
  discoverDirty = false;

  void (async () => {
    const q0 = getSearchQuery();
    await loadDiscoveryRows({ renderRows: !q0 });
    const q = getSearchQuery();
    if (q) {
      await runSearch(q);
    } else {
      setMode(false);
    }
  })();
}
