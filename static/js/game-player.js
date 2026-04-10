import { api } from "./api.js";
import { run as runPixelScript, stop as stopPixelScript } from "./pixelscript/runtime.js";
import { showToast } from "./toasts.js";

function normalizeNameKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase();
}

function buildPublishedSpriteLibrary(sprites) {
  const lib = Object.create(null);
  for (const s of sprites || []) {
    const key = normalizeNameKey(s.name);
    if (!key) continue;
    const url =
      s.published_image_url != null ? String(s.published_image_url).trim() : "";
    if (url) lib[key] = url;
  }
  return lib;
}

function publishedSourcesForScene(gamePayload, sceneId) {
  const scenes = gamePayload.scenes || [];
  const sc = scenes.find((x) => Number(x.id) === Number(sceneId));
  if (!sc) return [];
  return (sc.scripts || []).map((scr) =>
    scr.published_content != null ? String(scr.published_content) : "",
  );
}

function findSceneIdByName(scenes, sceneName) {
  const key = normalizeNameKey(sceneName);
  const scene = (scenes || []).find((s) => normalizeNameKey(s.name) === key);
  return scene ? Number(scene.id) : null;
}

function resolveStartSceneId(gamePayload) {
  const scenes = gamePayload.scenes || [];
  const def = gamePayload.default_scene_id;
  if (def != null) {
    const sid = Number(def);
    if (scenes.some((s) => Number(s.id) === sid)) return sid;
  }
  const first = scenes[0];
  return first ? Number(first.id) : null;
}

function $(id) {
  return document.getElementById(id);
}

const LEVEL_BANNER_SLIDE_MS = 350;
const LEVEL_BANNER_VISIBLE_MS = 5000;

function requestElementFullscreen(el) {
  if (!el) return;
  const fn =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.msRequestFullscreen;
  if (typeof fn === "function") fn.call(el);
}

function createGamePlayerLevelUpBanner(root) {
  const wrap = $("game-player-level-banner-wrap");
  const titleEl = $("game-player-level-banner-title");
  const subEl = $("game-player-level-banner-sub");
  const actions = $("game-player-level-banner-actions");
  const loginLink = $("game-player-level-banner-login");
  const banner = $("game-player-level-banner");
  if (!wrap || !titleEl || !subEl || !actions || !banner) {
    return { show() {} };
  }

  const loginUrl =
    (root && root.getAttribute("data-login-url")) || "/auth/login";
  if (loginLink) loginLink.setAttribute("href", loginUrl);

  let hideTimer = null;

  function clearTimer() {
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = null;
  }

  function closeBanner() {
    wrap.classList.remove("game-player-level-banner-wrap--open");
    window.setTimeout(() => {
      wrap.setAttribute("aria-hidden", "true");
      actions.hidden = true;
      banner.classList.remove("game-player-level-banner--guest");
    }, LEVEL_BANNER_SLIDE_MS);
  }

  return {
    show(payload) {
      clearTimer();
      const saved = Boolean(payload?.saved);
      const newLevel = Number(payload?.newLevel);
      const lv = Number.isFinite(newLevel) ? newLevel : 1;
      const pg = Math.max(0, Math.floor(Number(payload?.pixelsGained) || 0));
      if (saved) {
        banner.classList.remove("game-player-level-banner--guest");
        titleEl.textContent = `Level Up! You are now level ${lv}`;
        subEl.textContent = `+${pg} Pixels`;
        actions.hidden = true;
      } else {
        banner.classList.add("game-player-level-banner--guest");
        titleEl.textContent = "You would have leveled up";
        subEl.textContent =
          "You are not logged in — sign in to save XP, levels, and Pixels.";
        actions.hidden = false;
      }
      wrap.setAttribute("aria-hidden", "false");
      void wrap.offsetWidth;
      requestAnimationFrame(() => {
        wrap.classList.add("game-player-level-banner-wrap--open");
      });
      hideTimer = window.setTimeout(closeBanner, LEVEL_BANNER_VISIBLE_MS + LEVEL_BANNER_SLIDE_MS);
    },
  };
}

function playerResolutionScale() {
  if (typeof window === "undefined") return 2;
  const dpr = Number(window.devicePixelRatio);
  const n = Number.isFinite(dpr) && dpr >= 1 ? dpr : 1;
  const scaled = Math.ceil(n * 2);
  return Math.min(4, Math.max(2, scaled));
}

function setCounts(likeEl, dislikeEl, playEl, data) {
  if (likeEl) likeEl.textContent = String(data.like_count ?? 0);
  if (dislikeEl) dislikeEl.textContent = String(data.dislike_count ?? 0);
  if (playEl) playEl.textContent = String(data.play_count ?? 0);
}

export async function initGamePlayerPage() {
  const root = $("game-player-root");
  const loadingEl = $("game-player-loading");
  const errorEl = $("game-player-error");
  const contentEl = $("game-player-content");
  const canvas = $("game-player-canvas");

  if (!root || !canvas || !(canvas instanceof HTMLCanvasElement)) return;

  const levelUpBanner = createGamePlayerLevelUpBanner(root);
  const canvasStack = canvas.closest(".game-player__canvas-stack");

  const rawId = root.getAttribute("data-game-id");
  const gameId = Number(rawId);
  if (!Number.isFinite(gameId)) {
    if (loadingEl) loadingEl.hidden = true;
    if (errorEl) {
      errorEl.textContent = "Invalid game link.";
      errorEl.hidden = false;
    }
    return;
  }

  let gamePayload = null;
  let currentSceneId = null;

  async function postLike(value) {
    const result = await api.post(
      `/api/games/${gameId}/like`,
      { value },
      { asResult: true },
    );
    if (result.status === 401) {
      window.location.assign("/auth/login");
      return;
    }
    if (!result.ok) {
      const msg =
        result.data?.error != null && String(result.data.error) !== ""
          ? String(result.data.error)
          : "Could not save your vote.";
      showToast(msg, "error");
      return;
    }
    setCounts(
      $("game-player-like-count"),
      $("game-player-dislike-count"),
      null,
      result.data,
    );
  }

  function buildRuntimeOptions() {
    return {
      editorMode: false,
      gameId: String(gameId),
      resolutionScale: playerResolutionScale(),
      keyListenerRoot: "canvas",
      trapScrollKeys: true,
      spriteLibrary: buildPublishedSpriteLibrary(gamePayload.sprites),
      onScriptError: (payload) => {
        const text =
          payload?.formatted ??
          `Line ${payload?.line != null ? payload.line : "?"} — ${payload?.message ?? "Error"}`;
        showToast(text, "error");
      },
      onToast: (msg, type) => {
        const t =
          type === "error" || type === "warning" || type === "success"
            ? type
            : "success";
        showToast(String(msg), t);
      },
      onLevelUp: (payload) => {
        levelUpBanner.show(payload);
      },
      onGoToScene: async (sceneName) => {
        const sid = findSceneIdByName(gamePayload.scenes, sceneName);
        if (sid == null) {
          showToast(`Unknown scene "${sceneName}"`, "error");
          stopPixelScript();
          return;
        }
        currentSceneId = sid;
        const sources = publishedSourcesForScene(gamePayload, sid);
        await runPixelScript(sources, canvas, buildRuntimeOptions());
      },
      onRestartScene: async () => {
        const sid =
          currentSceneId != null
            ? currentSceneId
            : resolveStartSceneId(gamePayload);
        if (sid == null) {
          showToast("No scene to restart.", "error");
          stopPixelScript();
          return;
        }
        const sources = publishedSourcesForScene(gamePayload, sid);
        await runPixelScript(sources, canvas, buildRuntimeOptions());
      },
    };
  }

  async function startRunForScene(sceneId) {
    if (sceneId == null) return;
    currentSceneId = sceneId;
    const sources = publishedSourcesForScene(gamePayload, sceneId);
    await runPixelScript(sources, canvas, buildRuntimeOptions());
  }

  try {
    gamePayload = await api.get(`/api/games/${gameId}`);
  } catch (e) {
    if (loadingEl) loadingEl.hidden = true;
    if (errorEl) {
      errorEl.textContent =
        e instanceof Error ? e.message : "This game could not be loaded.";
      errorEl.hidden = false;
    }
    return;
  }

  const titleEl = $("game-player-title");
  const descEl = $("game-player-description");
  const authorLink = $("game-player-author-link");

  if (titleEl) titleEl.textContent = gamePayload.title ?? "Untitled";
  if (descEl) {
    const d = gamePayload.description != null ? String(gamePayload.description) : "";
    descEl.textContent = d;
    descEl.hidden = !d.trim();
  }

  const username =
    gamePayload.owner_username != null
      ? String(gamePayload.owner_username).trim()
      : "";
  if (authorLink) {
    if (username) {
      authorLink.href = `/profile/${encodeURIComponent(username)}`;
      authorLink.textContent = `@${username}`;
      authorLink.hidden = false;
    } else {
      authorLink.removeAttribute("href");
      authorLink.textContent = "Unknown";
      authorLink.hidden = false;
    }
  }

  document.title = `${gamePayload.title ?? "Game"} — Pixelcade`;

  setCounts(
    $("game-player-like-count"),
    $("game-player-dislike-count"),
    $("game-player-play-count"),
    gamePayload,
  );

  $("game-player-btn-like")?.addEventListener("click", () => {
    void postLike(1);
  });
  $("game-player-btn-dislike")?.addEventListener("click", () => {
    void postLike(-1);
  });

  $("game-player-btn-fullscreen")?.addEventListener("click", () => {
    requestElementFullscreen(canvasStack ?? canvas);
  });

  if (loadingEl) loadingEl.hidden = true;
  if (contentEl) contentEl.hidden = false;

  const startId = resolveStartSceneId(gamePayload);
  const overlay = $("game-player-start-overlay");
  const startBtn = $("game-player-btn-start");

  function clearPlayScrollLock() {
    document.documentElement.classList.remove("game-player-is-playing");
    document.body.classList.remove("game-player-is-playing");
  }

  window.addEventListener("beforeunload", () => {
    stopPixelScript();
    clearPlayScrollLock();
  });

  if (startId == null) {
    if (overlay) overlay.hidden = true;
    showToast("This game has no scenes to run.", "warning");
    return;
  }

  let sessionStarted = false;

  async function beginPlaySession() {
    if (sessionStarted) return;
    if (startBtn) {
      startBtn.disabled = true;
      startBtn.setAttribute("aria-busy", "true");
    }
    const result = await api.post(
      `/api/games/${gameId}/play`,
      {},
      { asResult: true },
    );
    if (!result.ok) {
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.removeAttribute("aria-busy");
      }
      const msg =
        result.data?.error != null && String(result.data.error) !== ""
          ? String(result.data.error)
          : "Could not start play session.";
      showToast(msg, "error");
      return;
    }
    sessionStarted = true;
    const playEl = $("game-player-play-count");
    if (playEl && result.data?.play_count != null) {
      playEl.textContent = String(result.data.play_count);
    }
    document.documentElement.classList.add("game-player-is-playing");
    document.body.classList.add("game-player-is-playing");
    if (overlay) {
      overlay.hidden = true;
      overlay.setAttribute("aria-hidden", "true");
    }
    canvas.focus();
    await startRunForScene(startId);
    if (startBtn) startBtn.removeAttribute("aria-busy");
  }

  if (overlay) {
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");
  }
  startBtn?.addEventListener("click", () => {
    void beginPlaySession();
  });
}
