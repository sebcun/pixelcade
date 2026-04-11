import { api } from "./api.js";
import { createGameCardEl } from "./home-discovery.js";
import { showToast } from "./toasts.js";

const CATEGORIES = [
  { key: "base", label: "Base" },
  { key: "eyes", label: "Eyes" },
  { key: "hair", label: "Hair" },
  { key: "accessory", label: "Accessory" },
];

const state = {
  username: "",
  profile: null,
  isOwner: false,
  avatarItemsByCategory: null,
  selectedTab: "base",
  selectedAvatarNames: {
    base: null,
    eyes: null,
    hair: null,
    accessory: null,
  },
  selectedAvatarLayers: {
    base: null,
    eyes: null,
    hair: null,
    accessory: null,
  },
};

function getPageRoot() {
  return document.querySelector(".profile-page");
}

function formatJoinDate(isoValue) {
  if (!isoValue) return "Joined recently";
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return "Joined recently";
  return `Joined ${date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}

function computeXpProgress(level, xp) {
  const safeLevel = Math.max(1, Number(level) || 1);
  const safeXp = Math.max(0, Number(xp) || 0);
  const threshold = Math.max(1, Math.floor(100 * safeLevel ** 1.5));
  const pct = Math.max(0, Math.min(100, (safeXp / threshold) * 100));
  return { pct, threshold, safeXp, safeLevel };
}

function normalizeImagePath(rawPath) {
  if (rawPath == null) return null;
  const p = String(rawPath).trim().replace(/\\/g, "/");
  if (!p) return null;
  if (p.startsWith("http://") || p.startsWith("https://")) return p;
  if (p.startsWith("/")) return p;
  if (p.startsWith("static/")) return `/${p}`;
  return `/static/${p.replace(/^\/+/, "")}`;
}

function renderAvatarStack(container, layers) {
  if (!container) return;
  container.replaceChildren();
  for (const category of CATEGORIES) {
    const src = normalizeImagePath(layers?.[category.key]);
    const img = document.createElement("img");
    img.className = "profile-avatar-layer";
    img.alt = "";
    img.width = 32;
    img.height = 32;
    if (src) img.src = src;
    container.appendChild(img);
  }
}

function profileGameForHomeCard(game) {
  const rawUrl =
    game.thumbnail_url != null && String(game.thumbnail_url).trim() !== ""
      ? String(game.thumbnail_url).trim()
      : null;
  const thumbUrl = rawUrl || normalizeImagePath(game.thumbnail_path);
  const owner =
    state.profile?.username != null && String(state.profile.username).trim() !== ""
      ? String(state.profile.username).trim()
      : null;
  return {
    id: game.id,
    title: game.title,
    thumbnail_url: thumbUrl,
    owner_username: owner,
    like_count: game.like_count,
    play_count: game.play_count,
  };
}

function renderGames(games) {
  const grid = document.getElementById("profile-games-grid");
  const empty = document.getElementById("profile-games-empty");
  if (!grid || !empty) return;
  grid.replaceChildren();
  if (!Array.isArray(games) || games.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  for (const game of games) {
    grid.appendChild(createGameCardEl(profileGameForHomeCard(game), "grid"));
  }
  if (typeof window.lucide !== "undefined") window.lucide.createIcons();
}

function renderProfile(profile) {
  document.getElementById("profile-loading")?.setAttribute("hidden", "true");
  const content = document.getElementById("profile-content");
  if (content) content.hidden = false;

  const username = String(profile?.username || "");
  const level = Number(profile?.level) || 1;
  const xp = Number(profile?.xp) || 0;
  const pixels = Number(profile?.pixels) || 0;
  const joined = formatJoinDate(profile?.created_at);
  const xpProgress = computeXpProgress(level, xp);

  const usernameEl = document.getElementById("profile-username");
  const joinedEl = document.getElementById("profile-joined");
  const levelEl = document.getElementById("profile-level");
  const xpText = document.getElementById("profile-xp-text");
  const xpFill = document.getElementById("profile-xp-fill");
  const balance = document.getElementById("profile-balance");

  if (usernameEl) usernameEl.textContent = `@${username}`;
  if (joinedEl) joinedEl.textContent = joined;
  if (levelEl) levelEl.textContent = `Level ${xpProgress.safeLevel}`;
  if (xpText) {
    xpText.textContent = `${Math.floor(xpProgress.pct)}% (${xpProgress.safeXp}/${xpProgress.threshold})`;
  }
  if (xpFill) xpFill.style.width = `${xpProgress.pct}%`;
  if (balance) balance.textContent = `${pixels.toLocaleString()} Pixels`;

  renderAvatarStack(document.getElementById("profile-avatar-stack"), profile?.avatar_layers || {});
  renderGames(profile?.games || []);
}

function setError(message) {
  const loading = document.getElementById("profile-loading");
  const error = document.getElementById("profile-error");
  if (loading) loading.hidden = true;
  if (error) {
    error.hidden = false;
    error.textContent = message || "Could not load profile.";
  }
}

function isCurrentUserProfile(profileUsername) {
  const current = window.currentUser;
  if (!current || !current.username) return false;
  return String(current.username).toLowerCase() === String(profileUsername || "").toLowerCase();
}

function openAvatarEditor() {
  const root = document.getElementById("avatar-editor-root");
  if (!root) return;
  root.classList.add("is-open");
  root.setAttribute("aria-hidden", "false");
  document.body.classList.add("avatar-editor-is-open");
  renderAvatarStack(document.getElementById("avatar-editor-preview"), state.selectedAvatarLayers);
}

function closeAvatarEditor() {
  const root = document.getElementById("avatar-editor-root");
  if (!root) return;
  root.classList.remove("is-open");
  root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("avatar-editor-is-open");
}

function renderTabs() {
  const tabs = document.getElementById("avatar-tabs");
  if (!tabs) return;
  tabs.replaceChildren();
  for (const category of CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-tab-btn";
    btn.textContent = category.label;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", state.selectedTab === category.key ? "true" : "false");
    if (state.selectedTab === category.key) btn.classList.add("is-active");
    btn.addEventListener("click", () => {
      state.selectedTab = category.key;
      renderTabs();
      renderItemsGrid();
    });
    tabs.appendChild(btn);
  }
}

function itemIsSelected(item) {
  const currentName = state.selectedAvatarNames?.[state.selectedTab];
  return String(currentName || "") === String(item?.name || "");
}

async function saveSelectedAvatar(categoryKey, item) {
  const payload = {
    avatar_base: state.selectedAvatarNames.base,
    avatar_eyes: state.selectedAvatarNames.eyes,
    avatar_hair: state.selectedAvatarNames.hair,
    avatar_accessory: state.selectedAvatarNames.accessory,
  };
  const patchResult = await api.patch("/api/profile/me", payload);
  const returnedUser = patchResult?.user;
  if (returnedUser && returnedUser.avatar) {
    state.selectedAvatarNames = {
      base: returnedUser.avatar.base ?? null,
      eyes: returnedUser.avatar.eyes ?? null,
      hair: returnedUser.avatar.hair ?? null,
      accessory: returnedUser.avatar.accessory ?? null,
    };
  }
  state.selectedAvatarLayers[categoryKey] = item.image_path || null;
  if (state.profile) {
    state.profile.avatar = { ...state.selectedAvatarNames };
    state.profile.avatar_layers = { ...state.selectedAvatarLayers };
  }
  renderAvatarStack(document.getElementById("profile-avatar-stack"), state.selectedAvatarLayers);
  renderAvatarStack(document.getElementById("avatar-editor-preview"), state.selectedAvatarLayers);
  showToast("Avatar saved.", "success");
}

function markItemUnlocked(itemId, categoryKey) {
  const list = state.avatarItemsByCategory?.[categoryKey];
  if (!Array.isArray(list)) return;
  const item = list.find((entry) => Number(entry.id) === Number(itemId));
  if (item) item.locked = false;
}

async function handlePurchase(item, categoryKey) {
  const cost = Number(item?.cost) || 0;
  const ok = window.confirm(`Purchase for ${cost} Pixels?`);
  if (!ok) return false;
  const result = await api.post(`/api/avatar/items/${item.id}/purchase`, {}, { asResult: true });
  if (!result.ok) {
    const msg = String(result?.data?.error || "Purchase failed");
    if (msg.toLowerCase().includes("insufficient")) {
      showToast("Insufficient Pixels.", "error");
    } else {
      showToast(msg, "error");
    }
    return false;
  }
  markItemUnlocked(item.id, categoryKey);
  const newBalance = Number(result?.data?.new_pixel_balance);
  if (Number.isFinite(newBalance)) {
    if (window.currentUser) window.currentUser.pixels = newBalance;
    if (state.profile) state.profile.pixels = newBalance;
    const balance = document.getElementById("profile-balance");
    if (balance) balance.textContent = `${newBalance.toLocaleString()} Pixels`;
    if (typeof window.pixelcadeSetNavPixelsDisplay === "function") {
      window.pixelcadeSetNavPixelsDisplay(newBalance);
    }
  }
  return true;
}

async function handleItemClick(item, categoryKey) {
  const isLocked = item.locked === true;
  if (isLocked) {
    const purchased = await handlePurchase(item, categoryKey);
    if (!purchased) return;
  }
  state.selectedAvatarNames[categoryKey] = item.name || null;
  state.selectedAvatarLayers[categoryKey] = item.image_path || null;
  renderItemsGrid();
  renderAvatarStack(document.getElementById("avatar-editor-preview"), state.selectedAvatarLayers);
  try {
    await saveSelectedAvatar(categoryKey, item);
  } catch (err) {
    showToast(err instanceof Error ? err.message : "Could not save avatar.", "error");
  }
}

function renderItemsGrid() {
  const grid = document.getElementById("avatar-items-grid");
  if (!grid) return;
  grid.replaceChildren();
  const items = state.avatarItemsByCategory?.[state.selectedTab] || [];
  if (!Array.isArray(items) || items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "profile-games-empty";
    empty.textContent = "No items found in this category.";
    grid.appendChild(empty);
    return;
  }
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "avatar-item-btn";
    if (itemIsSelected(item)) btn.classList.add("is-selected");
    const locked = item.locked === true;
    if (locked) btn.classList.add("is-locked");

    const thumbWrap = document.createElement("span");
    thumbWrap.className = "avatar-item-thumb-wrap";
    const img = document.createElement("img");
    img.className = "avatar-item-thumb";
    img.alt = item.name ? `${item.name} item` : "Avatar item";
    img.width = 32;
    img.height = 32;
    const src = normalizeImagePath(item.image_path);
    if (src) img.src = src;
    thumbWrap.appendChild(img);

    if (locked) {
      const lockIcon = document.createElement("span");
      lockIcon.className = "avatar-item-lock";
      lockIcon.innerHTML = '<i data-lucide="lock" aria-hidden="true"></i>';
      thumbWrap.appendChild(lockIcon);

      const badge = document.createElement("span");
      badge.className = "avatar-item-cost";
      badge.textContent = `${Number(item.cost || 0)} px`;
      btn.appendChild(badge);
    }

    const name = document.createElement("span");
    name.className = "avatar-item-name";
    name.textContent = String(item.name || "Item");

    btn.appendChild(thumbWrap);
    btn.appendChild(name);
    btn.addEventListener("click", () => {
      void handleItemClick(item, state.selectedTab);
    });
    grid.appendChild(btn);
  }
  if (typeof window.lucide !== "undefined") window.lucide.createIcons();
}

async function loadAvatarItems() {
  state.avatarItemsByCategory = await api.get("/api/avatar/items");
  renderTabs();
  renderItemsGrid();
}

function bindAvatarEditor() {
  const editBtn = document.getElementById("profile-edit-avatar-btn");
  if (editBtn) {
    editBtn.hidden = !state.isOwner;
    editBtn.addEventListener("click", () => {
      openAvatarEditor();
      if (!state.avatarItemsByCategory) {
        void loadAvatarItems().catch((err) => {
          showToast(err instanceof Error ? err.message : "Could not load avatar items.", "error");
        });
      }
    });
  }
  document.querySelectorAll("[data-avatar-editor-close]").forEach((node) => {
    node.addEventListener("click", () => closeAvatarEditor());
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAvatarEditor();
  });
}

function refreshOwnerControls() {
  if (!state.profile) return;
  state.isOwner = isCurrentUserProfile(state.profile.username);
  const editBtn = document.getElementById("profile-edit-avatar-btn");
  if (editBtn) editBtn.hidden = !state.isOwner;
}

async function initProfilePage() {
  const root = getPageRoot();
  if (!root) return;
  const username = root.getAttribute("data-profile-username") || "";
  state.username = username;

  try {
    const profile = await api.get(`/api/profile/${encodeURIComponent(username)}`);
    state.profile = profile;
    state.isOwner = isCurrentUserProfile(profile?.username);
    state.selectedAvatarNames = {
      base: profile?.avatar?.base ?? null,
      eyes: profile?.avatar?.eyes ?? null,
      hair: profile?.avatar?.hair ?? null,
      accessory: profile?.avatar?.accessory ?? null,
    };
    state.selectedAvatarLayers = {
      base: profile?.avatar_layers?.base ?? null,
      eyes: profile?.avatar_layers?.eyes ?? null,
      hair: profile?.avatar_layers?.hair ?? null,
      accessory: profile?.avatar_layers?.accessory ?? null,
    };
    renderProfile(profile);
    bindAvatarEditor();
    window.addEventListener("pixelcade-user-sync", refreshOwnerControls);
    refreshOwnerControls();
  } catch (err) {
    setError(err instanceof Error ? err.message : "Could not load profile.");
  }
}

void initProfilePage();
