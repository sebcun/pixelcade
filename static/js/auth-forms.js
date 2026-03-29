export const USERNAME_MAX = 20;
export const USERNAME_MIN = 3;

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function filterUsernameValue(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, "").slice(0, USERNAME_MAX);
}

/** @returns {{ ok: boolean | null, hint: string }} null = neutral (empty) */
export function usernameLiveState(value) {
  if (value.length === 0) {
    return { ok: null, hint: "3–20 characters: letters, numbers, and underscores only." };
  }
  if (value.length < USERNAME_MIN) {
    return {
      ok: false,
      hint: `At least ${USERNAME_MIN} characters (${value.length}/${USERNAME_MIN}).`,
    };
  }
  return { ok: true, hint: "" };
}

export function stripEmailSpaces(value) {
  return value.replace(/\s/g, "");
}

export function emailLiveState(value) {
  if (value.length === 0) {
    return { ok: null, hint: "" };
  }
  if (!EMAIL_RE.test(value)) {
    return { ok: false, hint: "Enter a valid email address." };
  }
  return { ok: true, hint: "" };
}

export function passwordRuleState(password) {
  return {
    len: password.length >= 8,
    letter: /[A-Za-z]/.test(password),
    number: /\d/.test(password),
  };
}

export function passwordMeetsRules(password) {
  const r = passwordRuleState(password);
  return r.len && r.letter && r.number;
}

export function bindPasswordToggles(root) {
  root.querySelectorAll("[data-password-toggle]").forEach((btn) => {
    const id = btn.getAttribute("aria-controls");
    const input = id ? document.getElementById(id) : null;
    if (!input) return;
    btn.addEventListener("click", () => {
      const showing = input.getAttribute("type") === "text";
      input.setAttribute("type", showing ? "password" : "text");
      btn.setAttribute("aria-pressed", showing ? "false" : "true");
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
  });
}

export function applyPasswordRulesUi(container, password) {
  if (!container) return;
  const r = passwordRuleState(password);
  container.querySelectorAll("[data-rule]").forEach((li) => {
    const key = li.getAttribute("data-rule");
    const met = key && r[key];
    li.classList.toggle("password-rules__item--met", Boolean(met));
  });
}
