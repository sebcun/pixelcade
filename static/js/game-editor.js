import { api } from "./api.js";
import { showToast } from "./toast.js";

const SPRITE_W = 32;
const SPRITE_H = 32;
const MAX_HISTORY_STEPS = 50;

const PALETTE_HEX = [
  "#000000",
  "#1D2B53",
  "#7E2553",
  "#008751",
  "#AB5236",
  "#5F574F",
  "#C2C3C7",
  "#FFF1E8",
  "#FF004D",
  "#FFA300",
  "#52FF00",
  "#00E5FF",
  "#3D00FF",
  "#FF77A8",
  "#00B6FF",
  "#FFD6A5",
];

function $(id) {
  return document.getElementById(id);
}

function clampInt(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.trunc(v)));
}

function normalizeHex(hex) {
  if (hex == null) return null;
  let h = String(hex).trim().toUpperCase();
  if (h === "") return null;
  if (!h.startsWith("#")) h = "#" + h;
  if (!/^#[0-9A-F]{6}$/.test(h)) return null;
  return h;
}

function hexToRgb(hex) {
  const h = normalizeHex(hex);
  if (!h) return null;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return { r, g, b };
}

function rgbToHex(r, g, b) {
  const to2 = (n) => {
    const s = clampInt(n, 0, 255).toString(16).toUpperCase();
    return s.length === 1 ? "0" + s : s;
  };
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function rgbaFromHexAndOpacity(hex, opacity) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255);
  return { r: rgb.r, g: rgb.g, b: rgb.b, a };
}

function rgbaEqualAt(data, i, rgba) {
  return (
    data[i] === rgba.r &&
    data[i + 1] === rgba.g &&
    data[i + 2] === rgba.b &&
    data[i + 3] === rgba.a
  );
}

function rgbaToPreviewStyle(rgba) {
  const { r, g, b, a } = rgba;
  const alpha = Math.max(0, Math.min(1, a / 255));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getCanvasCellFromEvent(canvasEl, evt) {
  const rect = canvasEl.getBoundingClientRect();
  const x = ((evt.clientX - rect.left) / rect.width) * SPRITE_W;
  const y = ((evt.clientY - rect.top) / rect.height) * SPRITE_H;
  return {
    x: clampInt(x, 0, SPRITE_W - 1),
    y: clampInt(y, 0, SPRITE_H - 1),
  };
}

function makeEmptyPixels() {
  return new Uint8ClampedArray(SPRITE_W * SPRITE_H * 4);
}

function pixelsEqual(a, b) {
  if (!(a && b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function ensureButtonAriaPressed(toolButtons, tool) {
  for (const [t, btn] of toolButtons.entries()) {
    if (!btn) continue;
    btn.setAttribute("aria-pressed", t === tool ? "true" : "false");
  }
}

let gameIdCurrent = null;
let bound = false;

let canvasEl = null;
let ctx = null;
let imgData = null; // ImageData for 32x32 (kept in sync with canvas)

let selectedSpriteId = null;
let sprites = [];

let spriteServerHasUnpublishedChanges = new Map(); // id -> bool
let spriteSidebarEls = new Map(); // id -> { itemEl, dotEl }

let history = [];
let historyIndex = 0;
let historyBasePixels = null; // loaded draft pixels, used for local dirty computation

let pendingEditStartPixels = null; // Uint8ClampedArray
let pendingEditHadChanges = false;

let isDrawing = false;
let currentTool = "pencil"; // pencil | eraser | fill | picker

// Pink is the default selected colour.
let selectedHex = "#FF004D";
let selectedOpacity = 1;

const toolButtons = new Map(); // tool -> buttonEl

let spriteLoadToken = 0;

function setHistoryUi() {
  const undoBtn = $("sprite-editor-undo");
  const redoBtn = $("sprite-editor-redo");
  if (undoBtn) undoBtn.disabled = !(historyIndex > 0);
  if (redoBtn) redoBtn.disabled = !(historyIndex < history.length - 1);
}

function setEditorVisible(visible) {
  const panel = $("sprite-editor-panel");
  const layout = $("sprite-editor-layout");
  if (panel) panel.hidden = !visible;
  if (layout) layout.classList.toggle("sprite-editor-layout--empty", !visible);
}

function setEditorButtonsEnabled(enabled) {
  const saveBtn = $("sprite-editor-save-draft");
  const renameBtn = $("sprite-editor-rename-sprite");
  const deleteBtn = $("sprite-editor-delete-sprite");
  if (saveBtn) saveBtn.disabled = !enabled;
  if (renameBtn) renameBtn.disabled = !enabled;
  if (deleteBtn) deleteBtn.disabled = !enabled;
}

function setSaveDraftEnabled(enabled) {
  const saveBtn = $("sprite-editor-save-draft");
  if (saveBtn) saveBtn.disabled = !enabled;
}

function computeLocalDirty() {
  if (selectedSpriteId == null || !historyBasePixels || !imgData?.data) return false;
  return !pixelsEqual(imgData.data, historyBasePixels);
}

function syncDirtyUiForSpriteId(spriteId) {
  const els = spriteSidebarEls.get(spriteId);
  if (!els?.dotEl) return;
  const serverDirty = Boolean(spriteServerHasUnpublishedChanges.get(spriteId));
  els.dotEl.hidden = !serverDirty;
}

function syncDirtyUiForCurrentSprite() {
  if (selectedSpriteId == null) return;
  const dirty = computeLocalDirty();
  syncDirtyUiForSpriteId(selectedSpriteId);
  setSaveDraftEnabled(dirty);
}

function pushHistorySnapshot() {
  const snap = new Uint8ClampedArray(imgData.data);
  if (historyIndex < history.length - 1) {
    history = history.slice(0, historyIndex + 1);
  }
  history.push(snap);
  historyIndex = history.length - 1;

  while (history.length > MAX_HISTORY_STEPS) {
    history.shift();
    historyIndex = Math.max(0, historyIndex - 1);
  }
  setHistoryUi();
}

function applyHistorySnapshot(pixels) {
  imgData.data.set(pixels);
  ctx.putImageData(imgData, 0, 0);
}

function setTool(tool) {
  currentTool = tool;
  ensureButtonAriaPressed(toolButtons, tool);
}

function updateColorUi() {
  const hexInput = $("sprite-editor-hex-input");
  const opacityRange = $("sprite-editor-opacity");
  const opacityValue = $("sprite-editor-opacity-value");
  const previewEl = $("sprite-editor-color-preview");

  if (hexInput) hexInput.value = selectedHex;
  if (opacityRange) opacityRange.value = String(selectedOpacity);
  if (opacityValue) opacityValue.textContent = String(Math.round(selectedOpacity * 100)) + "%";

  const rgba = rgbaFromHexAndOpacity(selectedHex, selectedOpacity);
  if (previewEl && rgba) previewEl.style.background = rgbaToPreviewStyle(rgba);
}

function renderPalette() {
  const paletteEl = $("sprite-editor-palette");
  if (!paletteEl) return;
  paletteEl.replaceChildren();

  for (const hex of PALETTE_HEX) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sprite-palette-swatch";
    btn.dataset.hex = hex;
    btn.style.background = hex;
    btn.setAttribute("aria-label", `Palette colour ${hex}`);
    btn.setAttribute("aria-pressed", hex === selectedHex ? "true" : "false");
    btn.addEventListener("click", () => {
      selectedHex = hex;
      updateColorUi();
      // Selecting a color implies pencil by default (faster UX).
      setTool("pencil");
    });
    paletteEl.appendChild(btn);
  }
}

function updatePaletteSelectedState() {
  const paletteEl = $("sprite-editor-palette");
  if (!paletteEl) return;
  paletteEl.querySelectorAll(".sprite-palette-swatch").forEach((sw) => {
    const hex = sw.dataset.hex;
    sw.setAttribute("aria-pressed", hex === selectedHex ? "true" : "false");
  });
}

function setPixel(x, y, rgba) {
  const idx = (y * SPRITE_W + x) * 4;
  if (rgbaEqualAt(imgData.data, idx, rgba)) return false;
  imgData.data[idx] = rgba.r;
  imgData.data[idx + 1] = rgba.g;
  imgData.data[idx + 2] = rgba.b;
  imgData.data[idx + 3] = rgba.a;
  return true;
}

function floodFill(startX, startY, targetRgba) {
  const data = imgData.data;

  const startIdx = (startY * SPRITE_W + startX) * 4;
  const sr = data[startIdx];
  const sg = data[startIdx + 1];
  const sb = data[startIdx + 2];
  const sa = data[startIdx + 3];

  if (
    sr === targetRgba.r &&
    sg === targetRgba.g &&
    sb === targetRgba.b &&
    sa === targetRgba.a
  ) {
    return false;
  }

  const stack = [[startX, startY]];
  let changed = false;

  while (stack.length) {
    const [x, y] = stack.pop();
    const idx = (y * SPRITE_W + x) * 4;
    if (
      data[idx] !== sr ||
      data[idx + 1] !== sg ||
      data[idx + 2] !== sb ||
      data[idx + 3] !== sa
    ) {
      continue;
    }

    // Paint this cell.
    data[idx] = targetRgba.r;
    data[idx + 1] = targetRgba.g;
    data[idx + 2] = targetRgba.b;
    data[idx + 3] = targetRgba.a;
    changed = true;

    if (x > 0) stack.push([x - 1, y]);
    if (x < SPRITE_W - 1) stack.push([x + 1, y]);
    if (y > 0) stack.push([x, y - 1]);
    if (y < SPRITE_H - 1) stack.push([x, y + 1]);
  }

  return changed;
}

function beginEdit() {
  pendingEditStartPixels = new Uint8ClampedArray(imgData.data);
  pendingEditHadChanges = false;
}

function endEdit() {
  if (!pendingEditStartPixels) return;
  if (pendingEditHadChanges) {
    pushHistorySnapshot();
  }
  pendingEditStartPixels = null;
  pendingEditHadChanges = false;
  syncDirtyUiForCurrentSprite();
}

function commitStrokePixelIfChanged(wrote) {
  if (wrote) pendingEditHadChanges = true;
}

async function loadImageIntoCanvas(imageUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load sprite image"));
    img.src = imageUrl;
  });
}

function loadBlankCanvas() {
  imgData = ctx.createImageData(SPRITE_W, SPRITE_H);
  ctx.putImageData(imgData, 0, 0);
}

function resetHistory() {
  history = [new Uint8ClampedArray(imgData.data)];
  historyIndex = 0;
  setHistoryUi();
}

async function loadSpriteIntoEditor(sprite) {
  const token = ++spriteLoadToken;

  const prevSelected = selectedSpriteId;
  selectedSpriteId = sprite.id;
  setEditorButtonsEnabled(true);
  setEditorVisible(true);

  const nameEl = $("sprite-editor-sprite-name");
  if (nameEl) nameEl.textContent = sprite.name != null ? String(sprite.name) : "Untitled";

  // Update selection styling in sidebar.
  for (const [sid, { itemEl }] of spriteSidebarEls.entries()) {
    if (!itemEl) continue;
    itemEl.classList.toggle("is-selected", Number(sid) === Number(selectedSpriteId));
  }

  setSaveDraftEnabled(false);
  syncDirtyUiForSpriteId(selectedSpriteId);

  if (sprite?.draft_image_url) {
    try {
      const img = await loadImageIntoCanvas(sprite.draft_image_url);
      if (token !== spriteLoadToken) return;

      // Draw into the actual canvas at 32x32.
      ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
      ctx.drawImage(img, 0, 0, SPRITE_W, SPRITE_H);
      imgData = ctx.getImageData(0, 0, SPRITE_W, SPRITE_H);
    } catch (e) {
      if (token !== spriteLoadToken) return;
      loadBlankCanvas();
      showToast(e instanceof Error ? e.message : "Failed to load sprite", "error");
    }
  } else {
    loadBlankCanvas();
  }

  historyBasePixels = new Uint8ClampedArray(imgData.data);
  resetHistory();
  syncDirtyUiForCurrentSprite();
}

function pickColorFromCell(x, y) {
  const data = imgData.data;
  const idx = (y * SPRITE_W + x) * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  const a = data[idx + 3];

  selectedHex = rgbToHex(r, g, b);
  selectedOpacity = Math.round((a / 255) * 100) / 100;
  updatePaletteSelectedState();
  updateColorUi();
  setTool("pencil");
}

function applyToolToCell(x, y) {
  if (currentTool === "picker") {
    pickColorFromCell(x, y);
    return;
  }

  if (currentTool === "fill") {
    const target = rgbaFromHexAndOpacity(selectedHex, selectedOpacity);
    if (!target) return;
    beginEdit();
    const changed = floodFill(x, y, target);
    if (changed) pendingEditHadChanges = true;
    ctx.putImageData(imgData, 0, 0);
    endEdit();
    return;
  }

  const target =
    currentTool === "eraser"
      ? { r: 0, g: 0, b: 0, a: 0 }
      : rgbaFromHexAndOpacity(selectedHex, selectedOpacity);
  if (!target) return;

  beginEdit();
  const wrote = setPixel(x, y, target);
  commitStrokePixelIfChanged(wrote);
  ctx.putImageData(imgData, 0, 0);
  endEdit();
}

function applyDrawingStrokePixel(x, y) {
  if (currentTool === "picker" || currentTool === "fill") return;
  const target =
    currentTool === "eraser"
      ? { r: 0, g: 0, b: 0, a: 0 }
      : rgbaFromHexAndOpacity(selectedHex, selectedOpacity);
  if (!target) return;
  const wrote = setPixel(x, y, target);
  commitStrokePixelIfChanged(wrote);
}

function bindOnce() {
  if (bound) return;
  bound = true;

  canvasEl = $("sprite-editor-canvas");
  ctx = canvasEl?.getContext("2d");
  if (!canvasEl || !ctx) return;

  imgData = ctx.getImageData(0, 0, SPRITE_W, SPRITE_H);

  // Tools
  toolButtons.set("pencil", $("sprite-tool-pencil"));
  toolButtons.set("eraser", $("sprite-tool-eraser"));
  toolButtons.set("fill", $("sprite-tool-fill"));
  toolButtons.set("picker", $("sprite-tool-picker"));

  for (const [tool, btn] of toolButtons.entries()) {
    if (!btn) continue;
    btn.addEventListener("click", () => {
      setTool(tool);
    });
  }

  // Color controls
  renderPalette();
  updateColorUi();

  const hexInput = $("sprite-editor-hex-input");
  if (hexInput) {
    const apply = () => {
      const n = normalizeHex(hexInput.value);
      if (!n) return;
      selectedHex = n;
      updatePaletteSelectedState();
      updateColorUi();
    };
    hexInput.addEventListener("input", apply);
    hexInput.addEventListener("blur", apply);
    hexInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") apply();
    });
  }

  const opacityRange = $("sprite-editor-opacity");
  if (opacityRange) {
    opacityRange.addEventListener("input", () => {
      const v = Number(opacityRange.value);
      if (!Number.isFinite(v)) return;
      selectedOpacity = Math.max(0, Math.min(1, v));
      updateColorUi();
    });
  }

  // Sidebar selection (delegated)
  const listEl = $("sprite-sidebar-list");
  if (listEl) {
    listEl.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sprite-id]");
      if (!btn) return;
      const id = Number(btn.dataset.spriteId);
      const sprite = sprites.find((s) => Number(s.id) === id);
      if (!sprite) return;
      void loadSpriteIntoEditor(sprite);
    });
  }

  // Undo/Redo
  const undoBtn = $("sprite-editor-undo");
  if (undoBtn) {
    undoBtn.addEventListener("click", () => {
      if (historyIndex <= 0) return;
      historyIndex--;
      applyHistorySnapshot(history[historyIndex]);
      setHistoryUi();
      syncDirtyUiForCurrentSprite();
    });
  }
  const redoBtn = $("sprite-editor-redo");
  if (redoBtn) {
    redoBtn.addEventListener("click", () => {
      if (historyIndex >= history.length - 1) return;
      historyIndex++;
      applyHistorySnapshot(history[historyIndex]);
      setHistoryUi();
      syncDirtyUiForCurrentSprite();
    });
  }

  // Keyboard shortcuts (scoped to editor route via focus)
  window.addEventListener("keydown", (e) => {
    if (!gameIdCurrent) return;
    if (!document.getElementById("view-develop-editor")?.hidden) {
      const key = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && key === "z" && !e.shiftKey) {
        e.preventDefault();
        if (historyIndex > 0) {
          historyIndex--;
          applyHistorySnapshot(history[historyIndex]);
          setHistoryUi();
          syncDirtyUiForCurrentSprite();
        }
      } else if (ctrl && (key === "y" || (key === "z" && e.shiftKey))) {
        e.preventDefault();
        if (historyIndex < history.length - 1) {
          historyIndex++;
          applyHistorySnapshot(history[historyIndex]);
          setHistoryUi();
          syncDirtyUiForCurrentSprite();
        }
      }
    }
  });

  // Canvas pointer drawing
  canvasEl.addEventListener("pointerdown", (e) => {
    if (!selectedSpriteId) return;
    if (e.button !== 0 && e.pointerType !== "touch") return;
    canvasEl.setPointerCapture?.(e.pointerId);

    const { x, y } = getCanvasCellFromEvent(canvasEl, e);

    if (currentTool === "picker") {
      applyToolToCell(x, y);
      return;
    }

    if (currentTool === "fill") {
      applyToolToCell(x, y);
      return;
    }

    // Pencil/eraser stroke.
    isDrawing = true;
    beginEdit();
    applyDrawingStrokePixel(x, y);
    ctx.putImageData(imgData, 0, 0);
    syncDirtyUiForSpriteId(selectedSpriteId);
    // Commit happens on pointerup.
    e.preventDefault();
  });

  canvasEl.addEventListener("pointermove", (e) => {
    if (!isDrawing) return;
    if (currentTool !== "pencil" && currentTool !== "eraser") return;
    const { x, y } = getCanvasCellFromEvent(canvasEl, e);
    applyDrawingStrokePixel(x, y);
    ctx.putImageData(imgData, 0, 0);
    e.preventDefault();
  });

  function endStroke() {
    if (!isDrawing) return;
    isDrawing = false;
    endEdit();
  }

  canvasEl.addEventListener("pointerup", endStroke);
  canvasEl.addEventListener("pointercancel", endStroke);
  canvasEl.addEventListener("pointerleave", endStroke);

  // Save Draft
  const saveBtn = $("sprite-editor-save-draft");
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      if (!selectedSpriteId || !gameIdCurrent) return;
      saveBtn.disabled = true;
      const idle = saveBtn.textContent;
      saveBtn.textContent = "Saving…";

      try {
        const spriteId = selectedSpriteId;
        await new Promise((resolve, reject) => {
          canvasEl.toBlob(async (blob) => {
            if (!blob) {
              reject(new Error("Could not export PNG from canvas"));
              return;
            }
            const fd = new FormData();
            fd.append("image", blob, `${spriteId}.png`);

            try {
              const updated = await api.patch(
                `/api/develop/games/${gameIdCurrent}/sprites/${spriteId}`,
                fd,
              );
              resolve(updated);
            } catch (e) {
              reject(e);
            }
          }, "image/png");
        });

        // Treat the current in-memory canvas as the saved draft baseline.
        historyBasePixels = new Uint8ClampedArray(imgData.data);
        setSaveDraftEnabled(false);
        syncDirtyUiForSpriteId(spriteId);

        // Fetch fresh list to update sidebar previews and the dot indicator.
        const list = await api.get(
          `/api/develop/games/${gameIdCurrent}/sprites`,
        );
        sprites = Array.isArray(list) ? list : [];
        renderSprites(sprites, /* preserveSelection */ true);
        syncDirtyUiForCurrentSprite();

        showToast("Draft saved", "success");
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Failed to save sprite draft",
          "error",
        );
      } finally {
        saveBtn.disabled = !computeLocalDirty();
        saveBtn.textContent = idle;
      }
    });
  }

  // New Sprite
  const newBtn = $("sprite-editor-new-sprite");
  if (newBtn) {
    newBtn.addEventListener("click", async () => {
      if (!gameIdCurrent) return;
      const name = window.prompt("Name for new sprite", "sprite");
      if (name == null) return;
      const trimmed = String(name).trim();
      if (!trimmed) {
        showToast("Name must not be empty", "error");
        return;
      }
      newBtn.disabled = true;
      const idle = newBtn.textContent;
      newBtn.textContent = "Creating…";
      try {
        const created = await api.post(
          `/api/develop/games/${gameIdCurrent}/sprites`,
          { name: trimmed },
        );
        // Reload + open.
        const list = await api.get(
          `/api/develop/games/${gameIdCurrent}/sprites`,
        );
        sprites = Array.isArray(list) ? list : [];
        renderSprites(sprites, /* preserveSelection */ true);
        const createdId = created && created.id != null ? created.id : null;
        const sprite = sprites.find((s) => Number(s.id) === Number(createdId));
        if (sprite) {
          await loadSpriteIntoEditor(sprite);
        }
        showToast("Sprite created", "success");
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Could not create sprite",
          "error",
        );
      } finally {
        newBtn.disabled = false;
        newBtn.textContent = idle;
      }
    });
  }

  // Rename
  const renameBtn = $("sprite-editor-rename-sprite");
  if (renameBtn) {
    renameBtn.addEventListener("click", async () => {
      if (!selectedSpriteId || !gameIdCurrent) return;
      const currentName = String(
        $("sprite-editor-sprite-name")?.textContent ?? "",
      );
      const name = window.prompt("Rename sprite", currentName || "sprite");
      if (name == null) return;
      const trimmed = String(name).trim();
      if (!trimmed) {
        showToast("Name must not be empty", "error");
        return;
      }
      renameBtn.disabled = true;
      const idle = renameBtn.textContent;
      renameBtn.textContent = "Renaming…";
      try {
        const updated = await api.patch(
          `/api/develop/games/${gameIdCurrent}/sprites/${selectedSpriteId}/rename`,
          { name: trimmed },
        );
        sprites = sprites.map((s) =>
          Number(s.id) === Number(selectedSpriteId) ? updated : s,
        );
        spriteServerHasUnpublishedChanges.set(
          selectedSpriteId,
          Boolean(updated.has_unpublished_changes),
        );
        renderSprites(sprites, /* preserveSelection */ true);
        const selected = sprites.find(
          (s) => Number(s.id) === Number(selectedSpriteId),
        );
        if (selected) {
          const nameEl = $("sprite-editor-sprite-name");
          if (nameEl) nameEl.textContent = updated.name ?? "Untitled";
        }
        showToast("Renamed", "success");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Rename failed", "error");
      } finally {
        renameBtn.disabled = false;
        renameBtn.textContent = idle;
      }
    });
  }

  // Delete
  const deleteBtn = $("sprite-editor-delete-sprite");
  if (deleteBtn) {
    deleteBtn.addEventListener("click", async () => {
      if (!selectedSpriteId || !gameIdCurrent) return;
      const ok = window.confirm(
        "Delete this sprite? This cannot be undone.",
      );
      if (!ok) return;
      deleteBtn.disabled = true;
      const idle = deleteBtn.textContent;
      deleteBtn.textContent = "Deleting…";

      try {
        await api.delete(
          `/api/develop/games/${gameIdCurrent}/sprites/${selectedSpriteId}`,
        );
        showToast("Sprite deleted", "success");
        selectedSpriteId = null;
        history = [];
        historyIndex = 0;
        setHistoryUi();
        setEditorButtonsEnabled(false);

        // Refresh list and pick next sprite.
        await refreshGameEditorView(gameIdCurrent);
      } catch (e) {
        showToast(
          e instanceof Error ? e.message : "Delete failed",
          "error",
        );
        deleteBtn.disabled = false;
        deleteBtn.textContent = idle;
      }
    });
  }
}

function renderSprites(spritesToRender, preserveSelection) {
  const listEl = $("sprite-sidebar-list");
  if (!listEl) return;
  listEl.replaceChildren();
  spriteSidebarEls.clear();

  if (!Array.isArray(spritesToRender) || spritesToRender.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sprite-sidebar__empty";
    empty.textContent = "No sprites yet. Create one to start.";
    listEl.appendChild(empty);
    return;
  }

  for (const sprite of spritesToRender) {
    const id = Number(sprite.id);

    const item = document.createElement("button");
    item.type = "button";
    item.className = "sprite-item";
    item.dataset.spriteId = String(id);

    const thumb = document.createElement("div");
    thumb.className = "sprite-item__thumb";

    const dot = document.createElement("span");
    dot.className = "sprite-item__dot";

    const hasDraft = Boolean(sprite.draft_image_url);
    if (hasDraft) {
      const img = document.createElement("img");
      img.src = sprite.draft_image_url;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "sprite-item__thumb-placeholder";
      placeholder.textContent = "—";
      thumb.appendChild(placeholder);
    }

    // Dot indicator reflects backend `has_unpublished_changes` only.
    spriteServerHasUnpublishedChanges.set(id, Boolean(sprite.has_unpublished_changes));
    dot.hidden = !Boolean(sprite.has_unpublished_changes);

    thumb.appendChild(dot);

    const name = document.createElement("div");
    name.className = "sprite-item__name";
    name.textContent = sprite.name != null ? String(sprite.name) : "Untitled";

    item.appendChild(thumb);
    item.appendChild(name);

    listEl.appendChild(item);

    spriteSidebarEls.set(id, { itemEl: item, dotEl: dot });
    item.classList.toggle("is-selected", preserveSelection && Number(id) === Number(selectedSpriteId));
  }
}

export function syncGameEditorGameId(gameId) {
  gameIdCurrent = gameId != null ? String(gameId) : null;
}

export async function refreshGameEditorView(gameId) {
  gameIdCurrent = gameId != null ? String(gameId) : gameIdCurrent;
  bindOnce();

  if (!gameIdCurrent) return;

  const listEl = $("sprite-sidebar-list");
  if (listEl) {
    listEl.replaceChildren();
    const p = document.createElement("p");
    p.className = "sprite-sidebar__empty";
    p.textContent = "Loading sprites…";
    listEl.appendChild(p);
  }

  try {
    const list = await api.get(`/api/develop/games/${gameIdCurrent}/sprites`);
    sprites = Array.isArray(list) ? list : [];
    if (!sprites.length) {
      selectedSpriteId = null;
      history = [];
      historyIndex = 0;
      historyBasePixels = null;
      setHistoryUi();
      renderSprites([], false);
      setEditorButtonsEnabled(false);
      setEditorVisible(false);
      return;
    }

    // Preserve selection when possible.
    const ids = new Set(sprites.map((s) => Number(s.id)));
    const keep = selectedSpriteId != null && ids.has(Number(selectedSpriteId));
    renderSprites(sprites, keep);

    if (!keep) {
      selectedSpriteId = null;
      history = [];
      historyIndex = 0;
      historyBasePixels = null;
      setHistoryUi();
      setEditorButtonsEnabled(false);
      setEditorVisible(false);
      return;
    }

    const selected = sprites.find(
      (s) => Number(s.id) === Number(selectedSpriteId),
    );
    if (selected) await loadSpriteIntoEditor(selected);
  } catch (e) {
    if (listEl) {
      listEl.replaceChildren();
      const p = document.createElement("p");
      p.className = "sprite-sidebar__empty";
      p.textContent = e instanceof Error ? e.message : "Could not load sprites";
      listEl.appendChild(p);
    }
    showToast(
      e instanceof Error ? e.message : "Could not load sprites",
      "error",
    );
    setEditorButtonsEnabled(false);
    setEditorVisible(false);
  }
}

