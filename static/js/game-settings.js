import { api } from "./api.js";
import { notifyGamePublished } from "./develop-sync.js";
import { showToast } from "./toast.js";

let loadToken = 0;

function $(id) {
  return document.getElementById(id);
}

function setBusy(btn, busy, loadingLabel, idleLabel) {
  if (!btn) return;
  if (busy) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (loadingLabel != null) btn.textContent = loadingLabel;
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    if (idleLabel != null) btn.textContent = idleLabel;
  }
}

function showLoadError(msg) {
  const el = $("develop-settings-load-error");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

function showFormError(msg) {
  const el = $("develop-settings-form-error");
  if (!el) return;
  if (msg) {
    el.textContent = msg;
    el.hidden = false;
  } else {
    el.textContent = "";
    el.hidden = true;
  }
}

/** @param {"loading" | "ready" | "error"} state */
function setLoadingUi(state) {
  const form = $("form-game-settings");
  const loadingEl = $("develop-settings-loading");
  const danger = $("develop-settings-danger");
  const ready = state === "ready";

  if (loadingEl) loadingEl.hidden = state !== "loading";
  if (form) form.hidden = !ready;
  if (danger) danger.hidden = !ready;
}

function applyGameToForm(game) {
  const title = $("game-settings-title");
  const desc = $("game-settings-description");
  const status = $("game-settings-status");
  const heading = $("develop-settings-heading");

  if (title) title.value = game.title != null ? String(game.title) : "";
  if (desc) desc.value = game.description != null ? String(game.description) : "";
  if (status) {
    const s = (game.status || "private").toLowerCase();
    status.value = ["private", "unlisted", "public"].includes(s) ? s : "private";
  }
  if (heading) {
    const t =
      game.title != null && String(game.title).trim() !== ""
        ? String(game.title).trim()
        : "Game settings";
    heading.textContent = t;
  }

  const ed = $("develop-settings-editor-link");
  if (ed && game.id != null) {
    ed.href = `/develop/game/${game.id}/editor`;
  }
}

/**
 * @param {string | undefined} gameId
 */
export async function refreshGameSettingsView(gameId) {
  const form = $("form-game-settings");
  if (!form || !gameId) return;

  const token = ++loadToken;
  showLoadError("");
  showFormError("");
  setLoadingUi("loading");

  try {
    const game = await api.get(`/api/develop/games/${gameId}`);
    if (token !== loadToken) return;
    applyGameToForm(game);
  } catch (e) {
    if (token !== loadToken) return;
    const msg = e instanceof Error ? e.message : "Could not load game";
    showLoadError(msg);
    setLoadingUi("error");
    return;
  }

  if (token !== loadToken) return;
  setLoadingUi("ready");
}

function bindOnce() {
  const form = $("form-game-settings");
  if (!form || form.dataset.bound === "1") return;
  form.dataset.bound = "1";

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const gid = form.dataset.gameId;
    if (!gid) return;

    showFormError("");
    const submitBtn = form.querySelector('button[type="submit"]');
    const idle = submitBtn ? submitBtn.textContent : "Save changes";
    setBusy(submitBtn, true, "Saving…", null);

    const title = ($("game-settings-title")?.value ?? "").trim();
    const description = ($("game-settings-description")?.value ?? "").trim();
    const status = ($("game-settings-status")?.value ?? "private").toLowerCase();

    const payload = {
      title: title === "" ? null : title,
      description: description === "" ? null : description,
      status,
    };

    try {
      const game = await api.patch(`/api/develop/games/${gid}`, payload);
      applyGameToForm(game);
      showToast("Settings saved", "success");
    } catch (err) {
      showFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(submitBtn, false, null, idle);
    }
  });

  const delBtn = $("btn-game-delete");
  if (delBtn && delBtn.dataset.bound !== "1") {
    delBtn.dataset.bound = "1";
    delBtn.addEventListener("click", async () => {
      const gid = form.dataset.gameId;
      if (!gid) return;
      const ok = window.confirm(
        "Delete this game permanently? This cannot be undone."
      );
      if (!ok) return;

      const idle = delBtn.textContent;
      setBusy(delBtn, true, "Deleting…", null);
      try {
        await api.delete(`/api/develop/games/${gid}`);
        showToast("Game deleted", "success");
        history.pushState({}, "", "/develop");
        window.dispatchEvent(new Event("popstate"));
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Delete failed", "error");
      } finally {
        setBusy(delBtn, false, null, idle);
      }
    });
  }

  const pubBtn = $("btn-game-publish");
  if (pubBtn && pubBtn.dataset.bound !== "1") {
    pubBtn.dataset.bound = "1";
    pubBtn.addEventListener("click", async () => {
      const gid = form.dataset.gameId;
      if (!gid) return;

      const idle = pubBtn.textContent;
      setBusy(pubBtn, true, "Publishing…", null);
      try {
        await api.post(`/api/develop/games/${gid}/publish`, {});
        notifyGamePublished(gid);
        showToast("Game published", "success");
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Publish failed", "error");
      } finally {
        setBusy(pubBtn, false, null, idle);
      }
    });
  }
}

bindOnce();

/**
 * @param {string | undefined} gameId
 */
export function syncGameSettingsGameId(gameId) {
  const form = $("form-game-settings");
  if (form && gameId) {
    form.dataset.gameId = String(gameId);
  }
}
