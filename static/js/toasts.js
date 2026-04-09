const TOAST_MS = 6000;

export function showToast(message, type = "success") {
  const root = document.getElementById("toast-root");
  if (!root) return;

  const t = type === "error" || type === "warning" ? type : "success";
  const el = document.createElement("div");
  el.className = `toast toast--${t}`;
  el.setAttribute("role", "status");

  const text = document.createElement("span");
  text.className = "toast__text";
  text.textContent = String(message ?? "");

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast__close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "";

  el.append(text, close);
  root.appendChild(el);

  requestAnimationFrame(() => {
    el.classList.add("toast--visible");
  });

  let timerId = 0;
  const dismiss = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = 0;
    }
    el.classList.remove("toast--visible");
    el.addEventListener(
      "transitionend",
      () => {
        el.remove();
      },
      { once: true },
    );
  };

  close.addEventListener("click", (e) => {
    e.stopPropagation();
    dismiss();
  });

  timerId = window.setTimeout(dismiss, TOAST_MS);
}

export function appendPreviewConsoleLine(message, kind = "log") {
  const logEl = document.getElementById("editor-preview-console-log");
  if (!logEl) return;

  const row = document.createElement("div");
  row.className =
    kind === "error"
      ? "develop-editor-preview__console-line develop-editor-preview__console-line--error"
      : "develop-editor-preview__console-line develop-editor-preview__console-line--log";
  row.textContent = String(message ?? "");
  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;
}

export function clearPreviewConsole() {
  const logEl = document.getElementById("editor-preview-console-log");
  if (logEl) logEl.replaceChildren();
}
