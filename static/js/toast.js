const DEFAULT_MS = 4500;

/**
 * @param {string} message
 * @param {"success" | "error"} [variant]
 */
export function showToast(message, variant = "success") {
  const root = document.getElementById("toast-root");
  if (!root) return;

  const el = document.createElement("div");
  el.className = `toast toast--${variant}`;
  el.setAttribute("role", "status");
  el.textContent = message;
  root.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add("toast--visible");
  });

  window.setTimeout(() => {
    el.classList.remove("toast--visible");
    el.addEventListener(
      "transitionend",
      () => {
        el.remove();
      },
      { once: true }
    );
  }, DEFAULT_MS);
}
