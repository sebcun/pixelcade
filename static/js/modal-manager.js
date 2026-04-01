function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = String(text);
  return el;
}

class ModalManager {
  constructor() {
    this.root = null;
    this.active = null;
    this.lastFocused = null;
  }

  ensureRoot() {
    if (this.root && document.body.contains(this.root)) return this.root;
    let root = document.getElementById("system-modal-root");
    if (!root) {
      root = createEl("div", "system-modal-root");
      root.id = "system-modal-root";
      root.setAttribute("aria-hidden", "true");
      document.body.appendChild(root);
    }
    this.root = root;
    return root;
  }

  closeActive(result) {
    if (!this.active) return;
    const { root, cleanup, resolve } = this.active;
    cleanup();
    root.classList.remove("is-open");
    root.setAttribute("aria-hidden", "true");
    document.body.classList.remove("system-modal-is-open");
    root.replaceChildren();
    this.active = null;
    if (this.lastFocused && typeof this.lastFocused.focus === "function") {
      this.lastFocused.focus();
    }
    this.lastFocused = null;
    resolve(result);
  }

  open(config) {
    const root = this.ensureRoot();
    if (this.active) {
      this.closeActive({ action: "dismissed", values: {} });
    }

    this.lastFocused = document.activeElement;

    const title = String(config?.title ?? "Dialog");
    const description = config?.description != null ? String(config.description) : "";
    const fields = Array.isArray(config?.fields) ? config.fields : [];
    const buttons = Array.isArray(config?.buttons) && config.buttons.length
      ? config.buttons
      : [{ id: "ok", label: "OK", variant: "primary", closeOnClick: true }];

    root.replaceChildren();

    const backdrop = createEl("div", "system-modal__backdrop");
    backdrop.setAttribute("aria-hidden", "true");

    const dialog = createEl("div", "system-modal__dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "system-modal-title");

    const card = createEl("section", "system-modal__card");
    const closeBtn = createEl("button", "system-modal__close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close dialog");

    const titleEl = createEl("h2", "system-modal__title font-display", title);
    titleEl.id = "system-modal-title";

    const descEl = createEl("p", "system-modal__description", description);
    if (!description) descEl.hidden = true;

    const form = createEl("form", "system-modal__form");
    form.noValidate = true;
    const globalError = createEl("p", "system-modal__error system-modal__error--global");
    globalError.hidden = true;
    const fieldState = new Map();

    for (const field of fields) {
      const name = String(field.name || "");
      if (!name) continue;
      const wrap = createEl("div", "system-modal__field");
      const label = createEl("label", "system-modal__label", field.label || name);
      label.setAttribute("for", `system-modal-field-${name}`);

      const input = createEl("input", "system-modal__input");
      input.id = `system-modal-field-${name}`;
      input.name = name;
      input.type = field.type || "text";
      input.value = field.value != null ? String(field.value) : "";
      input.placeholder = field.placeholder != null ? String(field.placeholder) : "";
      if (field.maxLength != null) input.maxLength = Number(field.maxLength);
      if (field.required) input.required = true;

      const err = createEl("p", "system-modal__error");
      err.hidden = true;

      wrap.appendChild(label);
      wrap.appendChild(input);
      wrap.appendChild(err);
      form.appendChild(wrap);
      fieldState.set(name, { config: field, input, err });
    }

    form.appendChild(globalError);

    const footer = createEl("div", "system-modal__footer");
    const buttonEls = [];
    for (const btn of buttons) {
      const b = createEl(
        "button",
        `btn ${btn.variant === "danger" ? "btn--danger" : btn.variant === "primary" ? "btn--nav-primary" : "btn--nav-secondary"} system-modal__button`,
        btn.label || btn.id || "Action",
      );
      b.type = btn.submit ? "submit" : "button";
      b.dataset.action = String(btn.id || "");
      footer.appendChild(b);
      buttonEls.push({ config: btn, el: b });
    }

    card.appendChild(closeBtn);
    card.appendChild(titleEl);
    card.appendChild(descEl);
    form.appendChild(footer);
    card.appendChild(form);
    dialog.appendChild(card);
    root.appendChild(backdrop);
    root.appendChild(dialog);

    const readValues = () => {
      const out = {};
      for (const [name, state] of fieldState.entries()) {
        out[name] = state.input.value;
      }
      return out;
    };

    const clearErrors = () => {
      globalError.hidden = true;
      globalError.textContent = "";
      for (const state of fieldState.values()) {
        state.err.hidden = true;
        state.err.textContent = "";
        state.input.classList.remove("input--invalid");
      }
    };

    const validate = () => {
      clearErrors();
      const values = readValues();
      let valid = true;
      for (const [name, state] of fieldState.entries()) {
        const raw = String(values[name] ?? "");
        const value = state.config.trim === false ? raw : raw.trim();
        if (state.config.required && !value) {
          state.err.textContent = state.config.requiredMessage || "This field is required.";
          state.err.hidden = false;
          state.input.classList.add("input--invalid");
          valid = false;
          continue;
        }
        if (typeof state.config.validate === "function") {
          const msg = state.config.validate(value, values);
          if (msg) {
            state.err.textContent = String(msg);
            state.err.hidden = false;
            state.input.classList.add("input--invalid");
            valid = false;
          }
        }
      }
      return valid;
    };

    const setGlobalError = (msg) => {
      if (!msg) {
        globalError.hidden = true;
        globalError.textContent = "";
        return;
      }
      globalError.textContent = String(msg);
      globalError.hidden = false;
    };

    const runButtonAction = async (btnConfig, btnEl) => {
      if (!btnConfig) return;
      clearErrors();
      const mustValidate = btnConfig.validate !== false;
      if (mustValidate && !validate()) return;

      const values = readValues();
      const trimmedValues = {};
      for (const [k, v] of Object.entries(values)) trimmedValues[k] = String(v).trim();

      const close = (result) => this.closeActive(result);
      if (btnConfig.closeOnClick && !btnConfig.action) {
        close({ action: btnConfig.id || "close", values: trimmedValues });
        return;
      }

      if (typeof btnConfig.action === "function") {
        btnEl.disabled = true;
        const idle = btnEl.textContent;
        if (btnConfig.loadingLabel) btnEl.textContent = String(btnConfig.loadingLabel);
        try {
          const outcome = await btnConfig.action({
            values: trimmedValues,
            close,
            setGlobalError,
          });
          if (outcome !== false && btnConfig.closeOnClick !== false) {
            close({ action: btnConfig.id || "action", values: trimmedValues });
          }
        } catch (err) {
          setGlobalError(err instanceof Error ? err.message : "Action failed");
        } finally {
          btnEl.disabled = false;
          btnEl.textContent = idle;
        }
        return;
      }

      if (btnConfig.closeOnClick !== false) {
        close({ action: btnConfig.id || "close", values: trimmedValues });
      }
    };

    let lastPressedAction = null;

    const onButtonClick = (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;
      e.preventDefault();
      const entry = buttonEls.find((x) => x.el === btn);
      if (!entry) return;
      lastPressedAction = entry.config.id || null;
      void runButtonAction(entry.config, btn);
    };

    const onSubmit = (e) => {
      e.preventDefault();
      const entry = buttonEls.find((x) => x.config.id === lastPressedAction && x.config.submit)
        || buttonEls.find((x) => x.config.submit)
        || buttonEls[0];
      if (!entry) return;
      void runButtonAction(entry.config, entry.el);
    };

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeActive({ action: "dismissed", values: readValues() });
      }
    };

    const onDismiss = () => {
      this.closeActive({ action: "dismissed", values: readValues() });
    };

    backdrop.addEventListener("click", onDismiss);
    closeBtn.addEventListener("click", onDismiss);
    root.addEventListener("keydown", onKeyDown);
    footer.addEventListener("click", onButtonClick);
    form.addEventListener("submit", onSubmit);

    root.classList.add("is-open");
    root.setAttribute("aria-hidden", "false");
    document.body.classList.add("system-modal-is-open");

    queueMicrotask(() => {
      const firstInput = form.querySelector("input, textarea, select");
      if (firstInput && typeof firstInput.focus === "function") firstInput.focus();
      else closeBtn.focus();
    });

    return new Promise((resolve) => {
      this.active = {
        root,
        resolve,
        cleanup: () => {
          backdrop.removeEventListener("click", onDismiss);
          closeBtn.removeEventListener("click", onDismiss);
          root.removeEventListener("keydown", onKeyDown);
          footer.removeEventListener("click", onButtonClick);
          form.removeEventListener("submit", onSubmit);
        },
      };
    });
  }

  async confirm(options) {
    const result = await this.open({
      title: options?.title || "Confirm action",
      description: options?.description || "",
      buttons: [
        { id: "cancel", label: options?.cancelLabel || "Cancel", variant: "secondary", closeOnClick: true },
        { id: "confirm", label: options?.confirmLabel || "Confirm", variant: options?.danger ? "danger" : "primary", closeOnClick: true },
      ],
    });
    return result?.action === "confirm";
  }

  async prompt(options) {
    const result = await this.open({
      title: options?.title || "Enter value",
      description: options?.description || "",
      fields: [
        {
          name: "value",
          label: options?.label || "Value",
          value: options?.initialValue || "",
          placeholder: options?.placeholder || "",
          required: options?.required !== false,
          requiredMessage: options?.requiredMessage,
          maxLength: options?.maxLength,
          validate: options?.validate,
        },
      ],
      buttons: [
        { id: "cancel", label: options?.cancelLabel || "Cancel", variant: "secondary", closeOnClick: true, validate: false },
        { id: "confirm", label: options?.confirmLabel || "Save", variant: options?.danger ? "danger" : "primary", submit: true },
      ],
    });
    if (result?.action !== "confirm") return null;
    return String(result?.values?.value ?? "").trim();
  }
}

export const modalManager = new ModalManager();
