import { api } from "./api.js";
import { modalManager } from "./modal-manager.js";
import { showToast } from "./toast.js";
import { run as runPixelScript, stop as stopPixelScript } from "./pixelscript/runtime.js";

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

function normalizeNameKey(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

function sceneSpriteNameExists(kind, name, excludeId) {
  const key = normalizeNameKey(name);
  if (!key) return false;

  const inScenes = scenes.some((scene) => {
    const id = Number(scene.id);
    if (kind === "scene" && Number(excludeId) === id) return false;
    return normalizeNameKey(scene.name) === key;
  });
  if (inScenes) return true;

  return sprites.some((sprite) => {
    const id = Number(sprite.id);
    if (kind === "sprite" && Number(excludeId) === id) return false;
    return normalizeNameKey(sprite.name) === key;
  });
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

// --- Scenes / Scripts state (sidebar + script editor) ---
let sidebarMode = "root"; // root | scenes | scripts | sprites

let scenes = [];
let selectedSceneId = null;

let scripts = [];
let selectedScriptId = null;
let selectedScriptSceneId = null;

let scriptServerHasUnpublishedChanges = new Map(); // scriptId -> bool
let scriptSidebarEls = new Map(); // scriptId -> { itemEl, dotEl, nameEl }

let scriptLastSavedDraftById = new Map(); // scriptId -> string
let scriptAutosaveTimer = null;
let scriptAutosaveToken = 0;
let runtimeRunning = false;

function setScriptEditorVisible(visible) {
  const panel = $("script-editor-panel");
  if (panel) panel.hidden = !visible;
}

function setSidebarMode(nextMode) {
  sidebarMode = nextMode;

  const backBtn = $("develop-editor-sidebar-back");
  const root = $("develop-sidebar-root");
  const scenesSec = $("develop-sidebar-scenes");
  const scriptsSec = $("develop-sidebar-scripts");
  const spritesSec = $("develop-sidebar-sprites");
  const kicker = $("develop-editor-sidebar-kicker");

  const showBack = nextMode !== "root";
  if (backBtn) backBtn.hidden = !showBack;

  // Hide the root chooser (Scenes/Sprites buttons) whenever user drills in.
  if (root) root.hidden = nextMode !== "root";
  if (scenesSec) scenesSec.hidden = nextMode !== "scenes";
  if (scriptsSec) scriptsSec.hidden = nextMode !== "scripts";
  if (spritesSec) spritesSec.hidden = nextMode !== "sprites";

  if (kicker) {
    kicker.textContent =
      nextMode === "scenes"
        ? "Scenes"
        : nextMode === "scripts"
          ? "Scripts"
          : nextMode === "sprites"
            ? "Sprites"
            : "Editor";
  }
}

function setMainPanel(panel) {
  // panel: "script" | "sprite" | "none"
  setScriptEditorVisible(panel === "script");
  setSpriteEditorVisible(panel === "sprite");
}

function setScriptUnsavedDotVisible(visible) {
  const dot = $("script-editor-unsaved-dot");
  if (dot) dot.hidden = !visible;
}

function setScriptSaveStatus(text) {
  const el = $("script-editor-save-status");
  if (!el) return;
  el.textContent = text || "";
}

function getScriptTextareaValue() {
  return String($("script-editor-textarea")?.value ?? "");
}

function setScriptTextareaValue(value) {
  const ta = $("script-editor-textarea");
  if (ta) ta.value = value != null ? String(value) : "";
}

function updateRunButtonsUi() {
  const stopBtn = $("editor-stop-button");
  const runBtn = $("editor-run-button");
  if (stopBtn) stopBtn.disabled = !runtimeRunning;
  if (runBtn) runBtn.disabled = runtimeRunning;
}

function updateScriptInMemoryDraft(scriptId, draftValue) {
  const id = Number(scriptId);
  scripts = scripts.map((s) =>
    Number(s.id) === id
      ? {
          ...s,
          draft_content: String(draftValue ?? ""),
        }
      : s,
  );
}

async function ensureScenesLoaded() {
  if (Array.isArray(scenes) && scenes.length) return;
  await loadScenes();
}

async function ensureScriptsLoadedForScene(sceneId) {
  const sid = Number(sceneId);
  if (Number(selectedSceneId) !== sid || !Array.isArray(scripts) || !scripts.length) {
    await loadScriptsForScene(sid);
  }
}

async function getDraftScriptsForRun() {
  await ensureScenesLoaded();
  if (!scenes.length) throw new Error("No scenes available to run.");

  const sceneId = selectedSceneId != null ? Number(selectedSceneId) : Number(scenes[0].id);
  if (!Number.isFinite(sceneId)) throw new Error("Invalid scene selected for run.");

  await ensureScriptsLoadedForScene(sceneId);
  const scriptSources = (Array.isArray(scripts) ? scripts : []).map((script) => {
    const sid = Number(script.id);
    if (
      selectedScriptId != null &&
      sid === Number(selectedScriptId) &&
      Number(selectedScriptSceneId) === sceneId
    ) {
      return getScriptTextareaValue();
    }
    return script?.draft_content != null ? String(script.draft_content) : "";
  });

  return scriptSources;
}

function findSceneIdByName(sceneName) {
  const key = normalizeNameKey(sceneName);
  if (!key) return null;
  const scene = scenes.find((s) => normalizeNameKey(s.name) === key);
  return scene ? Number(scene.id) : null;
}

async function collectDraftSourcesForScene(sceneId) {
  const sid = Number(sceneId);
  if (!gameIdCurrent || !Number.isFinite(sid)) {
    throw new Error("No scene to load.");
  }
  await loadScriptsForScene(sid);
  return (Array.isArray(scripts) ? scripts : []).map((script) => {
    const scriptId = Number(script.id);
    if (
      selectedScriptId != null &&
      scriptId === Number(selectedScriptId) &&
      Number(selectedScriptSceneId) === sid
    ) {
      return getScriptTextareaValue();
    }
    return script?.draft_content != null ? String(script.draft_content) : "";
  });
}

function buildPixelScriptOptions(canvasEl) {
  return {
    editorMode: true,
    gameId: gameIdCurrent,
    spriteLibrary: buildSpriteLibraryForRun(),
    onGoToScene: async (sceneName) => {
      const sid = findSceneIdByName(sceneName);
      if (sid == null) {
        showToast(`Unknown scene "${sceneName}"`, "error");
        stopEditorScripts();
        return;
      }
      selectedSceneId = sid;
      renderScenes(scenes);
      await loadScriptsForScene(sid);
      if (scripts?.length) {
        await openScriptInEditor(sid, scripts[0]);
      }
      const sources = await collectDraftSourcesForScene(sid);
      await runPixelScript(sources, canvasEl, buildPixelScriptOptions(canvasEl));
      runtimeRunning = true;
      updateRunButtonsUi();
    },
    onRestartScene: async () => {
      const sid = Number(selectedSceneId ?? scenes[0]?.id);
      if (!Number.isFinite(sid)) {
        showToast("No scene to restart.", "error");
        stopEditorScripts();
        return;
      }
      const sources = await collectDraftSourcesForScene(sid);
      await runPixelScript(sources, canvasEl, buildPixelScriptOptions(canvasEl));
      runtimeRunning = true;
      updateRunButtonsUi();
    },
  };
}

function buildSpriteLibraryForRun() {
  const lib = Object.create(null);
  for (const s of sprites) {
    const key = normalizeNameKey(s.name);
    if (!key) continue;
    const url = s.draft_image_url != null ? String(s.draft_image_url).trim() : "";
    if (url) lib[key] = url;
  }
  const spriteCanvas = $("sprite-editor-canvas");
  if (
    computeLocalDirty() &&
    selectedSpriteId != null &&
    spriteCanvas instanceof HTMLCanvasElement
  ) {
    const selected = sprites.find((sp) => Number(sp.id) === Number(selectedSpriteId));
    if (selected) {
      const key = normalizeNameKey(selected.name);
      if (key) {
        try {
          lib[key] = spriteCanvas.toDataURL("image/png");
        } catch {
          /* keep server URL in lib if present */
        }
      }
    }
  }
  return lib;
}

async function runEditorScriptsOnCanvas(canvasEl) {
  if (!(canvasEl instanceof HTMLCanvasElement)) {
    throw new Error("Preview canvas is missing.");
  }
  const draftScripts = await getDraftScriptsForRun();
  await runPixelScript(draftScripts, canvasEl, buildPixelScriptOptions(canvasEl));
  runtimeRunning = true;
  updateRunButtonsUi();
}

function stopEditorScripts() {
  stopPixelScript();
  runtimeRunning = false;
  updateRunButtonsUi();
}

function openPlayModal() {
  const root = $("editor-play-modal-root");
  if (!root) return;
  root.classList.add("is-open");
  root.setAttribute("aria-hidden", "false");
  document.body.classList.add("editor-play-modal-is-open");
}

function closePlayModal() {
  const root = $("editor-play-modal-root");
  if (!root) return;
  root.classList.remove("is-open");
  root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("editor-play-modal-is-open");
}

function setHistoryUi() {
  const undoBtn = $("sprite-editor-undo");
  const redoBtn = $("sprite-editor-redo");
  if (undoBtn) undoBtn.disabled = !(historyIndex > 0);
  if (redoBtn) redoBtn.disabled = !(historyIndex < history.length - 1);
}

function setSpriteEditorVisible(visible) {
  const panel = $("sprite-editor-panel");
  if (panel) panel.hidden = !visible;
}

// Backwards compatibility within this file (older calls).
function setEditorVisible(visible) {
  setSpriteEditorVisible(visible);
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
  setMainPanel("sprite");

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

  // Sidebar navigation (root/scenes/scripts/sprites)
  const navScenes = $("develop-nav-scenes");
  if (navScenes && navScenes.dataset.bound !== "1") {
    navScenes.dataset.bound = "1";
    navScenes.addEventListener("click", async () => {
      setSidebarMode("scenes");
      await loadScenes();
      setMainPanel("none");
    });
  }

  const navSprites = $("develop-nav-sprites");
  if (navSprites && navSprites.dataset.bound !== "1") {
    navSprites.dataset.bound = "1";
    navSprites.addEventListener("click", async () => {
      setSidebarMode("sprites");
      // Sprites list is loaded via refreshGameEditorView; just show the section.
      setMainPanel(selectedSpriteId != null ? "sprite" : "none");
    });
  }

  const backBtn = $("develop-editor-sidebar-back");
  if (backBtn && backBtn.dataset.bound !== "1") {
    backBtn.dataset.bound = "1";
    backBtn.addEventListener("click", async () => {
      if (sidebarMode === "scripts") {
        if (scriptAutosaveTimer) {
          clearTimeout(scriptAutosaveTimer);
          scriptAutosaveTimer = null;
        }
        scriptAutosaveToken++;
        selectedScriptId = null;
        selectedScriptSceneId = null;
        setMainPanel("none");
        setSidebarMode("scenes");
        renderScenes(scenes);
      } else {
        setSidebarMode("root");
        setMainPanel("none");
      }
    });
  }

  const scenesList = $("develop-scenes-list");
  if (scenesList && scenesList.dataset.bound !== "1") {
    scenesList.dataset.bound = "1";
    scenesList.addEventListener("click", async (e) => {
      const actionBtn = e.target.closest("[data-scene-action]");
      const item = e.target.closest("[data-scene-id]");
      if (!item) return;
      const sceneId = Number(item.dataset.sceneId);
      const scene = scenes.find((s) => Number(s.id) === sceneId);
      if (!scene) return;

      if (actionBtn) {
        e.preventDefault();
        e.stopPropagation();
        const action = actionBtn.dataset.sceneAction;
        if (action === "rename") {
          const nextName = await modalManager.prompt({
            title: "Rename scene",
            description: "Choose a new scene name.",
            label: "Scene name",
            initialValue: String(scene.name ?? ""),
            confirmLabel: "Save name",
            validate: (value) => {
              if (!String(value).trim()) return "Name must not be empty.";
              if (sceneSpriteNameExists("scene", value, sceneId)) {
                return "That name is already used by another scene or sprite.";
              }
              return null;
            },
          });
          if (nextName == null || nextName === String(scene.name ?? "").trim()) return;
          try {
            const updated = await api.patch(
              `/api/develop/games/${gameIdCurrent}/scenes/${sceneId}`,
              { name: nextName },
            );
            scenes = scenes.map((s) => (Number(s.id) === sceneId ? updated : s));
            renderScenes(scenes);
            if (Number(selectedSceneId) === sceneId) {
              const active = $("develop-active-scene-name");
              if (active) active.textContent = updated.name ?? "Untitled";
            }
            showToast("Scene renamed", "success");
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Rename failed", "error");
          }
          return;
        }

        if (action === "delete") {
          const ok = await modalManager.confirm({
            title: "Delete scene?",
            description:
              "Delete this scene and all scripts inside it? This action cannot be undone.",
            confirmLabel: "Delete scene",
            cancelLabel: "Cancel",
            danger: true,
          });
          if (!ok) return;
          try {
            await api.delete(`/api/develop/games/${gameIdCurrent}/scenes/${sceneId}`);
            scenes = scenes.filter((s) => Number(s.id) !== sceneId);
            if (Number(selectedSceneId) === sceneId) {
              selectedSceneId = null;
              selectedScriptId = null;
              selectedScriptSceneId = null;
              scripts = [];
              renderScripts([]);
              const active = $("develop-active-scene-name");
              if (active) active.textContent = "No scene selected";
              setSidebarMode("scenes");
              setMainPanel("none");
            }
            renderScenes(scenes);
            showToast("Scene deleted", "success");
          } catch (err) {
            showToast(err instanceof Error ? err.message : "Delete failed", "error");
          }
          return;
        }
      }

      const openBtn = e.target.closest("[data-scene-open]");
      if (!openBtn) return;
      const btn = e.target.closest("[data-scene-id]");
      if (!btn) return;
      selectedSceneId = sceneId;
      const nameEl = $("develop-active-scene-name");
      if (nameEl) nameEl.textContent = scene.name != null ? String(scene.name) : "Untitled";
      setSidebarMode("scripts");
      await loadScriptsForScene(sceneId);
      setMainPanel("none");
    });
  }

  const scriptsList = $("develop-scripts-list");
  if (scriptsList && scriptsList.dataset.bound !== "1") {
    scriptsList.dataset.bound = "1";
    scriptsList.addEventListener("click", (e) => {
      const actionBtn = e.target.closest("[data-script-action]");
      const item = e.target.closest("[data-script-id]");
      if (!item) return;
      const scriptId = Number(item.dataset.scriptId);
      const script = scripts.find((s) => Number(s.id) === scriptId);
      if (!script) return;

      if (actionBtn) {
        const action = actionBtn.dataset.scriptAction;
        if (action === "rename") {
          void (async () => {
            const nextName = await modalManager.prompt({
              title: "Rename script",
              description: "Choose a new script name.",
              label: "Script name",
              initialValue: String(script.name ?? ""),
              confirmLabel: "Save name",
            });
            if (nextName == null || nextName === String(script.name ?? "").trim()) return;
            try {
              const sceneId = Number(selectedSceneId);
              const updated = await api.patch(
                `/api/develop/games/${gameIdCurrent}/scenes/${sceneId}/scripts/${scriptId}`,
                { name: nextName },
              );
              scripts = scripts.map((s) => (Number(s.id) === scriptId ? updated : s));
              renderScripts(scripts);
              if (Number(selectedScriptId) === scriptId) {
                const heading = $("script-editor-script-name");
                if (heading) heading.textContent = updated.name ?? "Untitled";
              }
              showToast("Script renamed", "success");
            } catch (err) {
              showToast(err instanceof Error ? err.message : "Rename failed", "error");
            }
          })();
          return;
        }

        if (action === "delete") {
          void (async () => {
            const ok = await modalManager.confirm({
              title: "Delete script?",
              description: "Delete this script permanently? This cannot be undone.",
              confirmLabel: "Delete script",
              cancelLabel: "Cancel",
              danger: true,
            });
            if (!ok) return;
            try {
              const sceneId = Number(selectedSceneId);
              await api.delete(
                `/api/develop/games/${gameIdCurrent}/scenes/${sceneId}/scripts/${scriptId}`,
              );
              scripts = scripts.filter((s) => Number(s.id) !== scriptId);
              scriptServerHasUnpublishedChanges.delete(scriptId);
              scriptLastSavedDraftById.delete(scriptId);
              if (Number(selectedScriptId) === scriptId) {
                selectedScriptId = null;
                selectedScriptSceneId = null;
                setScriptTextareaValue("");
                setScriptSaveStatus("");
                setScriptUnsavedDotVisible(false);
                setMainPanel("none");
              }
              renderScripts(scripts);
              showToast("Script deleted", "success");
            } catch (err) {
              showToast(err instanceof Error ? err.message : "Delete failed", "error");
            }
          })();
          return;
        }
      }

      const openBtn = e.target.closest("[data-script-open]");
      if (!openBtn) return;
      const btn = e.target.closest("[data-script-id]");
      if (!btn) return;
      void openScriptInEditor(selectedSceneId, script);
    });
  }

  const newSceneBtn = $("develop-new-scene");
  if (newSceneBtn && newSceneBtn.dataset.bound !== "1") {
    newSceneBtn.dataset.bound = "1";
    newSceneBtn.addEventListener("click", async () => {
      if (!gameIdCurrent) return;
      const name = window.prompt("Name for new scene", "scene");
      if (name == null) return;
      const trimmed = String(name).trim();
      if (!trimmed) {
        showToast("Name must not be empty", "error");
        return;
      }
      newSceneBtn.disabled = true;
      const idle = newSceneBtn.textContent;
      newSceneBtn.textContent = "Creating…";
      try {
        const created = await api.post(
          `/api/develop/games/${gameIdCurrent}/scenes`,
          { name: trimmed },
        );
        scenes = [...scenes, created];
        renderScenes(scenes);
        showToast("Scene created", "success");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not create scene", "error");
      } finally {
        newSceneBtn.disabled = false;
        newSceneBtn.textContent = idle;
      }
    });
  }

  const newScriptBtn = $("develop-new-script");
  if (newScriptBtn && newScriptBtn.dataset.bound !== "1") {
    newScriptBtn.dataset.bound = "1";
    newScriptBtn.addEventListener("click", async () => {
      if (!gameIdCurrent || selectedSceneId == null) return;
      const name = window.prompt("Name for new script", "main");
      if (name == null) return;
      const trimmed = String(name).trim();
      if (!trimmed) {
        showToast("Name must not be empty", "error");
        return;
      }
      newScriptBtn.disabled = true;
      const idle = newScriptBtn.textContent;
      newScriptBtn.textContent = "Creating…";
      try {
        const created = await api.post(
          `/api/develop/games/${gameIdCurrent}/scenes/${selectedSceneId}/scripts`,
          { name: trimmed },
        );
        await loadScriptsForScene(selectedSceneId);
        const scriptId = created && created.id != null ? Number(created.id) : null;
        const createdScript = scripts.find((s) => Number(s.id) === Number(scriptId));
        if (createdScript) {
          await openScriptInEditor(selectedSceneId, createdScript);
        }
        showToast("Script created", "success");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not create script", "error");
      } finally {
        newScriptBtn.disabled = false;
        newScriptBtn.textContent = idle;
      }
    });
  }

  const ta = $("script-editor-textarea");
  if (ta && ta.dataset.bound !== "1") {
    ta.dataset.bound = "1";
    ta.addEventListener("input", () => {
      if (selectedScriptId != null) {
        updateScriptInMemoryDraft(selectedScriptId, getScriptTextareaValue());
      }
      scheduleScriptAutosave();
    });
  }

  const runBtn = $("editor-run-button");
  if (runBtn && runBtn.dataset.bound !== "1") {
    runBtn.dataset.bound = "1";
    runBtn.addEventListener("click", async () => {
      try {
        const canvas = $("editor-preview-canvas");
        await runEditorScriptsOnCanvas(canvas);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Run failed", "error");
      }
    });
  }

  const stopBtn = $("editor-stop-button");
  if (stopBtn && stopBtn.dataset.bound !== "1") {
    stopBtn.dataset.bound = "1";
    stopBtn.addEventListener("click", () => {
      stopEditorScripts();
    });
  }

  const playBtn = $("editor-play-button");
  if (playBtn && playBtn.dataset.bound !== "1") {
    playBtn.dataset.bound = "1";
    playBtn.addEventListener("click", async () => {
      openPlayModal();
      try {
        const canvas = $("editor-play-modal-canvas");
        await runEditorScriptsOnCanvas(canvas);
      } catch (err) {
        showToast(err instanceof Error ? err.message : "Playtest failed", "error");
      }
    });
  }

  document.querySelectorAll("[data-editor-play-dismiss]").forEach((el) => {
    if (el.dataset.bound === "1") return;
    el.dataset.bound = "1";
    el.addEventListener("click", () => {
      stopEditorScripts();
      closePlayModal();
    });
  });

  updateRunButtonsUi();

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
      const trimmed = await modalManager.prompt({
        title: "Rename sprite",
        description: "Choose a new sprite name.",
        label: "Sprite name",
        initialValue: currentName || "sprite",
        confirmLabel: "Save name",
        validate: (value) => {
          if (!String(value).trim()) return "Name must not be empty.";
          if (sceneSpriteNameExists("sprite", value, selectedSpriteId)) {
            return "That name is already used by another scene or sprite.";
          }
          return null;
        },
      });
      if (trimmed == null) return;
      if (trimmed === String(currentName).trim()) {
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
      const ok = await modalManager.confirm({
        title: "Delete sprite?",
        description: "Delete this sprite permanently? This cannot be undone.",
        confirmLabel: "Delete sprite",
        cancelLabel: "Cancel",
        danger: true,
      });
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

function renderEmptyList(listEl, message) {
  if (!listEl) return;
  listEl.replaceChildren();
  const p = document.createElement("p");
  p.className = "sprite-sidebar__empty";
  p.textContent = message;
  listEl.appendChild(p);
}

function renderScenes(scenesToRender) {
  const listEl = $("develop-scenes-list");
  if (!listEl) return;
  listEl.replaceChildren();

  if (!Array.isArray(scenesToRender) || scenesToRender.length === 0) {
    renderEmptyList(listEl, "No scenes yet. Create one to start.");
    return;
  }

  for (const scene of scenesToRender) {
    const id = Number(scene.id);
    const item = document.createElement("div");
    item.className = "develop-editor-item";
    item.dataset.sceneId = String(id);
    item.classList.toggle("is-selected", Number(selectedSceneId) === id);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "develop-editor-item__main";
    openBtn.dataset.sceneOpen = "1";

    const nameWrap = document.createElement("span");
    nameWrap.className = "develop-editor-item__name";

    const nameText = document.createElement("span");
    nameText.className = "develop-editor-item__name-text";
    nameText.textContent = scene.name != null ? String(scene.name) : "Untitled";
    nameText.title = nameText.textContent;

    nameWrap.appendChild(nameText);

    const meta = document.createElement("span");
    meta.className = "develop-editor-item__meta";
    const actions = document.createElement("span");
    actions.className = "develop-editor-item__actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "develop-editor-item__icon-btn";
    renameBtn.dataset.sceneAction = "rename";
    renameBtn.setAttribute("aria-label", "Rename scene");
    renameBtn.textContent = "✎";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "develop-editor-item__icon-btn develop-editor-item__icon-btn--danger";
    deleteBtn.dataset.sceneAction = "delete";
    deleteBtn.setAttribute("aria-label", "Delete scene");
    deleteBtn.textContent = "🗑";

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    meta.appendChild(actions);

    openBtn.appendChild(nameWrap);
    item.appendChild(openBtn);
    item.appendChild(meta);
    listEl.appendChild(item);
  }
}

function renderScripts(scriptsToRender) {
  const listEl = $("develop-scripts-list");
  if (!listEl) return;
  listEl.replaceChildren();
  scriptSidebarEls.clear();

  if (!Array.isArray(scriptsToRender) || scriptsToRender.length === 0) {
    renderEmptyList(listEl, "No scripts yet. Create one to start.");
    return;
  }

  for (const script of scriptsToRender) {
    const id = Number(script.id);

    const item = document.createElement("div");
    item.className = "develop-editor-item";
    item.dataset.scriptId = String(id);
    item.classList.toggle("is-selected", Number(selectedScriptId) === id);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "develop-editor-item__main";
    openBtn.dataset.scriptOpen = "1";

    const nameWrap = document.createElement("span");
    nameWrap.className = "develop-editor-item__name";

    const nameText = document.createElement("span");
    nameText.className = "develop-editor-item__name-text";
    nameText.textContent = script.name != null ? String(script.name) : "Untitled";
    nameText.title = nameText.textContent;

    const dot = document.createElement("span");
    dot.className = "editor-unpublished-dot";
    dot.hidden = !Boolean(script.has_unpublished_changes);

    nameWrap.appendChild(nameText);

    const meta = document.createElement("span");
    meta.className = "develop-editor-item__meta";
    meta.appendChild(dot);
    const actions = document.createElement("span");
    actions.className = "develop-editor-item__actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "develop-editor-item__icon-btn";
    renameBtn.dataset.scriptAction = "rename";
    renameBtn.setAttribute("aria-label", "Rename script");
    renameBtn.textContent = "✎";

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "develop-editor-item__icon-btn develop-editor-item__icon-btn--danger";
    deleteBtn.dataset.scriptAction = "delete";
    deleteBtn.setAttribute("aria-label", "Delete script");
    deleteBtn.textContent = "🗑";

    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    meta.appendChild(actions);

    openBtn.appendChild(nameWrap);
    item.appendChild(openBtn);
    item.appendChild(meta);
    listEl.appendChild(item);

    scriptServerHasUnpublishedChanges.set(id, Boolean(script.has_unpublished_changes));
    scriptSidebarEls.set(id, { itemEl: item, dotEl: dot, nameEl: nameText });

    if (!scriptLastSavedDraftById.has(id)) {
      scriptLastSavedDraftById.set(id, script.draft_content != null ? String(script.draft_content) : "");
    }
  }
}

async function loadScenes() {
  if (!gameIdCurrent) return;
  const listEl = $("develop-scenes-list");
  renderEmptyList(listEl, "Loading scenes…");
  try {
    const list = await api.get(`/api/develop/games/${gameIdCurrent}/scenes`);
    scenes = Array.isArray(list) ? list : [];
    renderScenes(scenes);
  } catch (e) {
    renderEmptyList(listEl, e instanceof Error ? e.message : "Could not load scenes");
    showToast(e instanceof Error ? e.message : "Could not load scenes", "error");
  }
}

async function loadScriptsForScene(sceneId) {
  if (!gameIdCurrent || sceneId == null) return;
  const listEl = $("develop-scripts-list");
  renderEmptyList(listEl, "Loading scripts…");
  try {
    const list = await api.get(
      `/api/develop/games/${gameIdCurrent}/scenes/${sceneId}/scripts`,
    );
    scripts = Array.isArray(list) ? list : [];
    renderScripts(scripts);
  } catch (e) {
    renderEmptyList(listEl, e instanceof Error ? e.message : "Could not load scripts");
    showToast(e instanceof Error ? e.message : "Could not load scripts", "error");
  }
}

function computeScriptLocalDirty(scriptId) {
  if (scriptId == null) return false;
  const base = scriptLastSavedDraftById.get(Number(scriptId)) ?? "";
  return getScriptTextareaValue() !== String(base);
}

function syncScriptDirtyUi() {
  setScriptUnsavedDotVisible(computeScriptLocalDirty(selectedScriptId));
}

async function openScriptInEditor(sceneId, script) {
  if (!script || script.id == null) return;
  // Cancel any pending autosave for previously open script.
  if (scriptAutosaveTimer) {
    clearTimeout(scriptAutosaveTimer);
    scriptAutosaveTimer = null;
  }
  scriptAutosaveToken++;

  selectedScriptId = Number(script.id);
  selectedScriptSceneId = Number(sceneId);

  // Selection styling
  for (const [sid, els] of scriptSidebarEls.entries()) {
    els?.itemEl?.classList.toggle("is-selected", Number(sid) === Number(selectedScriptId));
  }

  const nameEl = $("script-editor-script-name");
  if (nameEl) nameEl.textContent = script.name != null ? String(script.name) : "Untitled";

  const draft = script.draft_content != null ? String(script.draft_content) : "";
  scriptLastSavedDraftById.set(selectedScriptId, draft);
  setScriptTextareaValue(draft);
  setScriptSaveStatus("");
  syncScriptDirtyUi();

  setMainPanel("script");
}

function scheduleScriptAutosave() {
  if (!gameIdCurrent || selectedScriptId == null || selectedScriptSceneId == null) return;
  if (!computeScriptLocalDirty(selectedScriptId)) {
    setScriptSaveStatus("");
    syncScriptDirtyUi();
    return;
  }

  if (scriptAutosaveTimer) {
    clearTimeout(scriptAutosaveTimer);
    scriptAutosaveTimer = null;
  }

  const token = ++scriptAutosaveToken;
  setScriptSaveStatus("Unsaved changes…");
  syncScriptDirtyUi();

  scriptAutosaveTimer = setTimeout(async () => {
    if (token !== scriptAutosaveToken) return;
    const sceneId = selectedScriptSceneId;
    const scriptId = selectedScriptId;
    const nextDraft = getScriptTextareaValue();

    if (!computeScriptLocalDirty(scriptId)) {
      setScriptSaveStatus("");
      syncScriptDirtyUi();
      return;
    }

    setScriptSaveStatus("Saving draft…");
    try {
      const updated = await api.patch(
        `/api/develop/games/${gameIdCurrent}/scenes/${sceneId}/scripts/${scriptId}`,
        { draft_content: nextDraft },
      );
      scriptLastSavedDraftById.set(scriptId, nextDraft);
      setScriptSaveStatus("Draft saved");
      syncScriptDirtyUi();

      // Update the unpublished changes dot from server response.
      scriptServerHasUnpublishedChanges.set(
        scriptId,
        Boolean(updated?.has_unpublished_changes),
      );
      const els = scriptSidebarEls.get(scriptId);
      if (els?.dotEl) els.dotEl.hidden = !Boolean(updated?.has_unpublished_changes);
    } catch (e) {
      setScriptSaveStatus("Save failed");
      showToast(
        e instanceof Error ? e.message : "Failed to save draft",
        "error",
      );
      syncScriptDirtyUi();
    }
  }, 1000);
}

export function syncGameEditorGameId(gameId) {
  gameIdCurrent = gameId != null ? String(gameId) : null;
}

export async function refreshGameEditorView(gameId) {
  gameIdCurrent = gameId != null ? String(gameId) : gameIdCurrent;
  bindOnce();
  stopEditorScripts();
  closePlayModal();

  if (!gameIdCurrent) return;

  // Reset view on entry.
  setSidebarMode("root");
  setMainPanel("none");
  setScriptTextareaValue("");
  setScriptSaveStatus("");
  setScriptUnsavedDotVisible(false);
  selectedSceneId = null;
  selectedScriptId = null;
  selectedScriptSceneId = null;

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
      // Sprites are optional; scenes/scripts can still be edited.
      // Keep going so scenes/scripts can still load on demand.
    } else {
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
      } else {
        const selected = sprites.find(
          (s) => Number(s.id) === Number(selectedSpriteId),
        );
        if (selected) await loadSpriteIntoEditor(selected);
      }
    }
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

