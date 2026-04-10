import { api } from "./api.js";
import { showToast } from "./toasts.js";

const LS_KEY = "pixelcade_daily_checkin";

export function utcDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function applyDailyCheckinFromStorage() {
  const u = window.currentUser;
  if (!u || u.id == null) return;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && Number(o.userId) === Number(u.id) && o.dateUtc) {
      u.daily_checkin_utc_date = o.dateUtc;
    }
  } catch {
    /* ignore */
  }
}

function persistDailyCheckin(userId) {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({ userId: Number(userId), dateUtc: utcDateString() }),
  );
}

export function isDailyCheckedInToday(userId) {
  if (userId == null) return false;
  const u = window.currentUser;
  if (
    u &&
    Number(u.id) === Number(userId) &&
    u.daily_checkin_utc_date === utcDateString()
  ) {
    return true;
  }
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    return (
      o &&
      Number(o.userId) === Number(userId) &&
      o.dateUtc === utcDateString()
    );
  } catch {
    return false;
  }
}

function markDailyCheckedIn(userId) {
  if (userId == null) return;
  if (window.currentUser && Number(window.currentUser.id) === Number(userId)) {
    window.currentUser.daily_checkin_utc_date = utcDateString();
  }
  persistDailyCheckin(userId);
}

export function setNavPixelsDisplay(value) {
  const el = document.getElementById("nav-pixels-balance");
  if (!el) return;
  const n = Math.max(0, Math.floor(Number(value) || 0));
  el.textContent = `${n.toLocaleString()} Pixels`;
}

function syncModalGiftMuted(done) {
  const wrap = document.getElementById("daily-reward-gift-wrap");
  if (!wrap) return;
  wrap.classList.toggle("daily-reward-gift-wrap--muted", done);
}

export function refreshNavDailyRewardUI() {
  const btn = document.getElementById("nav-daily-reward-btn");
  const u = window.currentUser;
  if (!btn) return;
  if (!u || u.id == null) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.classList.toggle(
    "nav-daily-reward-btn--claimed",
    isDailyCheckedInToday(u.id),
  );

  const root = document.getElementById("daily-reward-modal-root");
  if (root && root.classList.contains("is-open")) {
    syncModalToState();
  }
}

function syncModalToState() {
  const u = window.currentUser;
  const msg = document.getElementById("daily-reward-message");
  const claimWrap = document.getElementById("daily-reward-claim-wrap");
  if (!msg || !claimWrap) return;

  const done = u && u.id != null && isDailyCheckedInToday(u.id);
  if (done) {
    msg.textContent = "Already checked in today  come back tomorrow!";
    msg.hidden = false;
    claimWrap.hidden = true;
    syncModalGiftMuted(true);
  } else {
    msg.textContent = "";
    msg.hidden = true;
    claimWrap.hidden = false;
    syncModalGiftMuted(false);
  }
}

function openDailyRewardModal() {
  const root = document.getElementById("daily-reward-modal-root");
  if (!root) return;
  syncModalToState();
  root.classList.add("is-open");
  root.setAttribute("aria-hidden", "false");
  document.body.classList.add("daily-reward-modal-is-open");
  if (typeof window.lucide !== "undefined") window.lucide.createIcons();
}

function closeDailyRewardModal() {
  const root = document.getElementById("daily-reward-modal-root");
  if (!root) return;
  root.classList.remove("is-open");
  root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("daily-reward-modal-is-open");
}

let bound = false;

export function initNavDailyReward() {
  if (bound) return;
  bound = true;

  const openBtn = document.getElementById("nav-daily-reward-btn");
  const root = document.getElementById("daily-reward-modal-root");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      if (!window.currentUser || window.currentUser.id == null) return;
      openDailyRewardModal();
    });
  }
  if (root) {
    root.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.closest && t.closest("[data-daily-reward-dismiss]")) {
        closeDailyRewardModal();
      }
    });
  }

  const claimBtn = document.getElementById("daily-reward-claim-btn");
  if (claimBtn) {
    claimBtn.addEventListener("click", async () => {
      const u = window.currentUser;
      if (!u || u.id == null) return;
      if (isDailyCheckedInToday(u.id)) {
        syncModalToState();
        return;
      }
      if (claimBtn.getAttribute("aria-busy") === "true") return;
      claimBtn.setAttribute("aria-busy", "true");
      claimBtn.disabled = true;
      try {
        const data = await api.post("/api/auth/checkin", {});
        const already = Boolean(data && data.already_checked_in);
        if (already) {
          markDailyCheckedIn(u.id);
          showToast("You already checked in today.", "success");
        } else {
          const gained = Number(data?.pixels_gained) || 0;
          markDailyCheckedIn(u.id);
          const next =
            (Number(window.currentUser.pixels) || 0) + (Number.isFinite(gained) ? gained : 0);
          window.currentUser.pixels = next;
          setNavPixelsDisplay(next);
          showToast(
            gained > 0
              ? `Daily reward claimed  +${gained} Pixels!`
              : "Daily reward claimed!",
            "success",
          );
        }
        refreshNavDailyRewardUI();
        syncModalToState();
      } catch (e) {
        const m = e instanceof Error ? e.message : "Could not claim reward";
        showToast(m, "error");
      } finally {
        claimBtn.removeAttribute("aria-busy");
        claimBtn.disabled = false;
      }
    });
  }

  window.addEventListener("pixelcade-user-sync", () => {
    refreshNavDailyRewardUI();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const root = document.getElementById("daily-reward-modal-root");
    if (root && root.classList.contains("is-open")) {
      closeDailyRewardModal();
    }
  });
}
