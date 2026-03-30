import { api } from "./api.js";
import {
  refreshGameSettingsView,
  syncGameSettingsGameId,
} from "./game-settings.js";

function normalizePath(pathname) {
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export function isDevelopSection() {
  return window.location.pathname.startsWith("/develop");
}

function parseDevelopRoute() {
  const p = window.location.pathname;
  if (!p.startsWith("/develop")) return { kind: "none" };
  if (/^\/develop\/?$/.test(p)) return { kind: "home" };
  const mS = p.match(/^\/develop\/game\/(\d+)\/settings\/?$/);
  if (mS) return { kind: "settings", gameId: mS[1] };
  const mE = p.match(/^\/develop\/game\/(\d+)\/editor\/?$/);
  if (mE) return { kind: "editor", gameId: mE[1] };
  return { kind: "unknown" };
}

function thumbnailSrc(thumbnailPath) {
  if (thumbnailPath == null || String(thumbnailPath).trim() === "") return null;
  const s = String(thumbnailPath).replace(/\\/g, "/").trim();
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  if (s.startsWith("/")) return s;
  if (s.startsWith("static/")) return "/" + s;
  return "/static/" + s.replace(/^\/+/, "");
}

function statusLabel(status) {
  const s = (status || "private").toLowerCase();
  if (s === "public") return "Public";
  if (s === "unlisted") return "Unlisted";
  return "Private";
}

function statusBadgeClass(status) {
  const s = (status || "private").toLowerCase();
  if (s === "public") return "develop-badge develop-badge--public";
  if (s === "unlisted") return "develop-badge develop-badge--unlisted";
  return "develop-badge develop-badge--private";
}

function applyNavMode() {
  const dev = isDevelopSection();
  const playerCluster = document.getElementById("nav-cluster-player");
  const developCluster = document.getElementById("nav-cluster-develop");
  const authSlot = document.getElementById("nav-auth-slot");
  const developUserSlot = document.getElementById("nav-develop-user-slot");

  if (playerCluster) playerCluster.hidden = dev;
  if (developCluster) developCluster.hidden = !dev;
  if (authSlot) {
    authSlot.hidden = dev;
    authSlot.setAttribute("aria-hidden", dev ? "true" : "false");
  }
  if (developUserSlot) {
    developUserSlot.hidden = !dev;
    developUserSlot.setAttribute("aria-hidden", dev ? "false" : "true");
  }

  fillDevelopUserSlot();
  if (typeof window.lucide !== "undefined") window.lucide.createIcons();
}

function fillDevelopUserSlot() {
  const slot = document.getElementById("nav-develop-user-slot");
  if (!slot || !isDevelopSection()) return;
  slot.replaceChildren();
  const u = window.currentUser;
  if (u && u.id != null && u.username) {
    const a = document.createElement("a");
    a.className = "btn btn--nav-secondary nav-develop-username";
    a.href = "/profile/" + encodeURIComponent(u.username);
    a.textContent = `@${u.username}`;
    slot.appendChild(a);
  } else {
    const home = document.createElement("a");
    home.className = "btn btn--nav-secondary";
    home.href = "/";
    home.setAttribute("data-spa-nav", "");
    home.textContent = "Log in";
    slot.appendChild(home);
  }
}

let gamesLoadToken = 0;

function renderDevelopGamesGrid(games) {
  const grid = document.getElementById("develop-games-grid");
  if (!grid) return;
  grid.replaceChildren();

  if (!Array.isArray(games) || games.length === 0) {
    const empty = document.createElement("p");
    empty.className = "develop-empty";
    empty.textContent =
      "No experiences yet. Create one with New Game to start building in the portal.";
    grid.appendChild(empty);
    return;
  }

  for (const g of games) {
    const id = g.id;
    const title =
      g.title != null && String(g.title).trim() !== ""
        ? String(g.title).trim()
        : "Untitled";
    const card = document.createElement("article");
    card.className = "develop-game-card";

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "develop-game-card__thumb";
    const src = thumbnailSrc(g.thumbnail_path);
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = "";
      img.width = 128;
      img.height = 128;
      img.loading = "lazy";
      thumbWrap.appendChild(img);
    } else {
      thumbWrap.innerHTML =
        '<span class="develop-game-card__placeholder font-display" aria-hidden="true">?</span>';
    }
    card.appendChild(thumbWrap);

    const body = document.createElement("div");
    body.className = "develop-game-card__body";

    const h2 = document.createElement("h2");
    h2.className = "develop-game-card__title";
    h2.textContent = title;
    body.appendChild(h2);

    const badge = document.createElement("span");
    badge.className = statusBadgeClass(g.status);
    badge.textContent = statusLabel(g.status);
    body.appendChild(badge);

    const stats = document.createElement("div");
    stats.className = "develop-game-card__stats";
    const plays = Number(g.play_count) || 0;
    const likes = Number(g.like_count) || 0;
    stats.innerHTML = `<span><i data-lucide="play" class="develop-stat-icon" aria-hidden="true"></i> ${plays.toLocaleString()} plays</span><span><i data-lucide="heart" class="develop-stat-icon develop-stat-icon--heart" aria-hidden="true"></i> ${likes.toLocaleString()} likes</span>`;
    body.appendChild(stats);

    const actions = document.createElement("div");
    actions.className = "develop-game-card__actions";
    const ed = document.createElement("a");
    ed.className = "btn btn--develop-editor";
    ed.href = `/develop/game/${id}/settings`;
    ed.setAttribute("data-spa-nav", "");
    ed.textContent = "Open";
    actions.appendChild(ed);
    body.appendChild(actions);

    card.appendChild(body);
    grid.appendChild(card);
  }

  if (typeof window.lucide !== "undefined") window.lucide.createIcons();
}

async function loadDevelopGames() {
  const errEl = document.getElementById("develop-home-error");
  const grid = document.getElementById("develop-games-grid");
  if (!grid) return;

  const token = ++gamesLoadToken;
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = "";
  }
  grid.innerHTML = `<p class="develop-loading" role="status">Loading your experiences…</p>`;

  try {
    const games = await api.get("/api/develop/games");
    if (token !== gamesLoadToken) return;
    renderDevelopGamesGrid(Array.isArray(games) ? games : []);
  } catch (e) {
    if (token !== gamesLoadToken) return;
    const msg = e instanceof Error ? e.message : "Could not load games";
    if (errEl) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    grid.replaceChildren();
  }
}

function bindNewGameOnce() {
  const btn = document.getElementById("btn-new-game");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    if (btn.getAttribute("aria-busy") === "true") return;
    const idle = btn.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Creating…";
    try {
      const created = await api.post("/api/develop/games", {});
      const id = created && created.id != null ? created.id : null;
      if (id == null) throw new Error("Invalid response from server");
      const path = `/develop/game/${id}/settings`;
      history.pushState({}, "", path);
      window.dispatchEvent(new Event("popstate"));
    } catch (e) {
      const errEl = document.getElementById("develop-home-error");
      if (errEl) {
        errEl.textContent =
          e instanceof Error ? e.message : "Could not create game";
        errEl.hidden = false;
      }
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = idle;
    }
  });
}

function setStubIds(gameId) {
  const e = document.getElementById("develop-editor-game-id");
  if (e) e.textContent = gameId != null ? String(gameId) : "—";

  const l = document.getElementById("develop-editor-settings-link");
  if (l) {
    l.href = gameId != null ? `/develop/game/${gameId}/settings` : "#";
  }
}

export function applyShellRoute() {
  applyNavMode();

  const viewHome = document.getElementById("view-home");
  const viewDevelopHome = document.getElementById("view-develop-home");
  const viewDevelopSettings = document.getElementById("view-develop-settings");
  const viewDevelopEditor = document.getElementById("view-develop-editor");
  const viewDevelopUnknown = document.getElementById("view-develop-unknown");

  const route = parseDevelopRoute();
  const onDev = isDevelopSection();

  if (viewHome) viewHome.hidden = onDev;

  const show = (el, on) => {
    if (!el) return;
    el.hidden = !on;
  };

  show(viewDevelopHome, onDev && route.kind === "home");
  show(viewDevelopSettings, onDev && route.kind === "settings");
  show(viewDevelopEditor, onDev && route.kind === "editor");
  show(viewDevelopUnknown, onDev && route.kind === "unknown");

  if (onDev && route.kind === "home") {
    bindNewGameOnce();
    loadDevelopGames();
    document.title = "Create — Pixelcade";
  } else if (onDev && route.kind === "settings") {
    syncGameSettingsGameId(route.gameId);
    refreshGameSettingsView(route.gameId);
    document.title = "Game settings — Pixelcade";
  } else if (onDev && route.kind === "editor") {
    setStubIds(route.gameId);
    document.title = "Editor — Pixelcade";
  } else if (onDev && route.kind === "unknown") {
    document.title = "Developer — Pixelcade";
  } else if (!onDev) {
    document.title = "Pixelcade";
  }
}

function spaPath(pathname) {
  const n = normalizePath(pathname);
  if (n === "/" || n.startsWith("/develop")) return true;
  return false;
}

function onSpaClick(e) {
  if (e.defaultPrevented) return;
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
    return;
  const a = e.target.closest("a");
  if (!a) return;
  if (a.hasAttribute("data-no-spa")) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#")) return;
  try {
    const url = new URL(a.href, window.location.origin);
    if (url.origin !== window.location.origin) return;
    if (!spaPath(url.pathname)) return;
    e.preventDefault();
    history.pushState({}, "", url.pathname + url.search + url.hash);
    window.dispatchEvent(new Event("popstate"));
  } catch {
    /* ignore */
  }
}

export function initShellRouter(onRoute) {
  document.addEventListener("click", onSpaClick);
  window.addEventListener("popstate", onRoute);
  window.addEventListener("pixelcade-user-sync", () => {
    fillDevelopUserSlot();
    onRoute();
  });
}
