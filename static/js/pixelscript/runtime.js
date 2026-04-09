import { createEffectEmitter } from "./effects.js";
import { parse } from "./parser.js";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 270;
/** Draw size on the game canvas; matches 32×32 sprite editor export. */
const SPRITE_DRAW_SIZE = 32;

let activeRuntime = null;

function normalizeSpriteKey(value) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase();
}

function keyMatches(scriptKey, eventKey) {
  const want = String(scriptKey ?? "").trim();
  const ev = String(eventKey ?? "");
  if (!want) return false;
  if (/^arrow/i.test(want)) return want === ev;
  return want.toLocaleLowerCase() === ev.toLocaleLowerCase();
}

function normalizeKeyForMap(eventKey) {
  const ev = String(eventKey ?? "");
  if (/^arrow/i.test(ev)) return ev;
  if (ev.length === 1) return ev.toLocaleLowerCase();
  return ev.toLocaleLowerCase();
}

function shouldTrapScrollKey(e) {
  const k = String(e?.key ?? "");
  if (k === " " || k === "Spacebar") return true;
  if (/^arrow/i.test(k)) return true;
  if (k === "PageUp" || k === "PageDown" || k === "Home" || k === "End")
    return true;
  return false;
}

function toProgram(scripts) {
  const list = Array.isArray(scripts) ? scripts : [scripts];
  const body = [];
  for (const entry of list) {
    const source =
      typeof entry === "string" ? entry : String(entry?.draft_content ?? entry?.content ?? "");
    if (!source.trim()) continue;
    const ast = parse(source);
    if (Array.isArray(ast?.body)) body.push(...ast.body);
  }
  return { type: "Program", body };
}

function isTruthy(v) {
  if (v === false || v == null) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  return true;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function yieldFrame() {
  return new Promise((requestAnimationFrame));
}

function readMetaCsrf() {
  return (
    typeof document !== "undefined"
      ? document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? ""
      : ""
  );
}

class PixelRuntime {
  constructor(
    canvas,
    {
      editorMode = false,
      spriteLibrary = {},
      gameId = null,
      onGoToScene = null,
      onRestartScene = null,
      onScriptError = null,
      onToast = null,
      onConsoleLog = null,
      resolutionScale = 1,
      keyListenerRoot = "parent",
      trapScrollKeys = false,
    } = {},
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    const rs = Number(resolutionScale);
    this.resolutionScale =
      Number.isFinite(rs) && rs >= 1 ? Math.min(4, Math.round(rs)) : 1;
    this.keyListenerRoot = keyListenerRoot === "canvas" ? "canvas" : "parent";
    this.trapScrollKeys = Boolean(trapScrollKeys);
    this.editorMode = editorMode;
    this.gameId = gameId != null ? String(gameId) : null;
    this.onGoToScene = typeof onGoToScene === "function" ? onGoToScene : null;
    this.onRestartScene = typeof onRestartScene === "function" ? onRestartScene : null;
    this.onScriptError = typeof onScriptError === "function" ? onScriptError : null;
    this.onToast = typeof onToast === "function" ? onToast : null;
    this.onConsoleLog = typeof onConsoleLog === "function" ? onConsoleLog : null;
    this.spriteLibrary =
      spriteLibrary && typeof spriteLibrary === "object" ? spriteLibrary : {};
    /** @type {Map<string, HTMLImageElement>} */
    this.spriteImages = new Map();
    this.running = false;
    this.rafId = null;
    this.eventBus = new Map();
    this.state = {
      variables: new Map(),
      sprites: new Map(),
      texts: new Map(),
    };
    this.background = { kind: "color", color: "#0E0E14", image: null };
    /** @type {ReturnType<createEffectEmitter>[]} */
    this.effectEmitters = [];
    this._lastTickMs =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    this._audioCtx = null;
    /** @type {Map<string, AudioBuffer>} */
    this._soundBuffers = new Map();
    /** @type {Map<string, AudioBufferSourceNode[]>} */
    this._soundSources = new Map();
    /** @type {{ mode: string, keyName: string, body: object[] }[]} */
    this.keyPressHandlers = [];
    this.keyReleaseHandlers = [];
    /** @type {{ mode: string, keyName: string, body: object[] }[]} */
    this.keyHoldHandlers = [];
    /** @type {{ id: string, kind: string, sprite: string, other?: string, body: object[] }[]} */
    this.touchHandlers = [];
    this.touchPrev = new Map();
    this.touchHandlerId = 0;
    this.keysDown = new Set();
    /** @type {HTMLElement | null} */
    this.keyListenerTarget = null;
    this._onKeyDown = null;
    this._onKeyUp = null;
    /** @type {((e: KeyboardEvent) => void) | null} */
    this._onWindowKeyScrollTrap = null;
    this.holdRunPromise = Promise.resolve();
  }

  makeSpriteRecord(variable, spriteName, x, y, image) {
    return {
      id: variable,
      name: spriteName,
      x,
      y,
      visible: true,
      opacity: 1,
      scale: 1,
      rotation: 0,
      image,
    };
  }

  evalExpr(node, depth = 0) {
    if (depth > 200) return 0;
    if (!node) return 0;
    if (node.type === "NumberLiteral") return Number(node.value) || 0;
    if (node.type === "StringLiteral") return String(node.value);
    if (node.type === "BooleanLiteral") return Boolean(node.value);
    if (node.type === "Identifier") {
      const name = String(node.name);
      return this.state.variables.get(name) ?? 0;
    }
    if (node.type === "TouchExpr") {
      const a = resolveSprite(node.left, this.state);
      if (!a) return false;
      if (node.wall) return this.spriteTouchesWall(a);
      const b = resolveSprite(node.right, this.state);
      if (!b) return false;
      return this.spritesOverlap(a, b);
    }
    if (node.type === "MemberExpression") {
      const prop = String(node.property || "").toLocaleLowerCase();
      const obj = node.object;
      if (obj?.type === "Identifier") {
        const sp = resolveSprite(obj.name, this.state);
        if (sp) {
          if (prop === "x") return sp.x;
          if (prop === "y") return sp.y;
          if (prop === "opacity") return sp.opacity;
          if (prop === "rotation") return sp.rotation;
          if (prop === "scale") return sp.scale;
          if (prop === "visible") return sp.visible;
        }
      }
      return 0;
    }
    if (node.type === "UnaryExpression") {
      const arg = this.evalExpr(node.argument, depth + 1);
      if (node.operator === "not") return !isTruthy(arg);
      if (node.operator === "-") return -Number(arg) || 0;
      return 0;
    }
    if (node.type === "BinaryExpression") {
      const op = String(node.operator);
      if (op === "and") {
        const l = this.evalExpr(node.left, depth + 1);
        if (!isTruthy(l)) return false;
        return isTruthy(this.evalExpr(node.right, depth + 1));
      }
      if (op === "or") {
        const l = this.evalExpr(node.left, depth + 1);
        if (isTruthy(l)) return true;
        return isTruthy(this.evalExpr(node.right, depth + 1));
      }
      const left = this.evalExpr(node.left, depth + 1);
      const right = this.evalExpr(node.right, depth + 1);
      if (op === "+") {
        if (typeof left === "string" || typeof right === "string") return String(left) + String(right);
        return (Number(left) || 0) + (Number(right) || 0);
      }
      if (op === "-") return (Number(left) || 0) - (Number(right) || 0);
      if (op === "*") return (Number(left) || 0) * (Number(right) || 0);
      if (op === "/") {
        const dr = Number(right) || 0;
        if (dr === 0) return 0;
        return (Number(left) || 0) / dr;
      }
      if (op === "==") return left === right || Number(left) === Number(right);
      if (op === "!=") return !(left === right || Number(left) === Number(right));
      if (op === "<") return (Number(left) || 0) < (Number(right) || 0);
      if (op === ">") return (Number(left) || 0) > (Number(right) || 0);
      if (op === "<=") return (Number(left) || 0) <= (Number(right) || 0);
      if (op === ">=") return (Number(left) || 0) >= (Number(right) || 0);
    }
    return 0;
  }

  spriteExtents(sp) {
    const s = SPRITE_DRAW_SIZE * Math.abs(Number(sp.scale) || 1);
    return { w: s, h: s };
  }

  spriteTouchesWall(sp) {
    const { w, h } = this.spriteExtents(sp);
    return (
      sp.x <= 0 ||
      sp.y <= 0 ||
      sp.x + w >= this.canvas.width ||
      sp.y + h >= this.canvas.height
    );
  }

  spritesOverlap(a, b) {
    const aw = this.spriteExtents(a).w;
    const ah = this.spriteExtents(a).h;
    const bw = this.spriteExtents(b).w;
    const bh = this.spriteExtents(b).h;
    return a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y;
  }

  installKeyListeners(target) {
    this.removeKeyListeners();
    const el = target instanceof HTMLElement ? target : null;
    if (!el) return;
    this.keyListenerTarget = el;
    el.tabIndex = Math.max(el.tabIndex, 0);
    this._onKeyDown = (e) => {
      if (!this.running) return;
      const k = normalizeKeyForMap(e.key);
      if (!e.repeat) {
        this.keysDown.add(k);
        for (const h of this.keyPressHandlers) {
          if (keyMatches(h.keyName, e.key)) void this.safeExecBlock(h.body);
        }
      }
    };
    this._onKeyUp = (e) => {
      if (!this.running) return;
      const k = normalizeKeyForMap(e.key);
      this.keysDown.delete(k);
      for (const h of this.keyReleaseHandlers) {
        if (keyMatches(h.keyName, e.key)) void this.safeExecBlock(h.body);
      }
    };
    if (this.trapScrollKeys) {
      this._onWindowKeyScrollTrap = (e) => {
        if (!this.running) return;
        if (shouldTrapScrollKey(e)) e.preventDefault();
      };
      window.addEventListener("keydown", this._onWindowKeyScrollTrap, true);
    }
    el.addEventListener("keydown", this._onKeyDown);
    el.addEventListener("keyup", this._onKeyUp);
  }

  removeKeyListeners() {
    if (this._onWindowKeyScrollTrap) {
      window.removeEventListener("keydown", this._onWindowKeyScrollTrap, true);
      this._onWindowKeyScrollTrap = null;
    }
    const el = this.keyListenerTarget;
    if (el && this._onKeyDown && this._onKeyUp) {
      el.removeEventListener("keydown", this._onKeyDown);
      el.removeEventListener("keyup", this._onKeyUp);
    }
    this.keyListenerTarget = null;
    this._onKeyDown = null;
    this._onKeyUp = null;
    this.keysDown.clear();
  }

  _stopAllSounds() {
    for (const list of this._soundSources.values()) {
      for (const src of list) {
        try {
          src.stop();
        } catch {
          /* ignore */
        }
      }
    }
    this._soundSources.clear();
  }

  async _ensureAudioCtx() {
    if (typeof window === "undefined") return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!this._audioCtx) {
      this._audioCtx = new AC();
    }
    if (this._audioCtx.state === "suspended") {
      try {
        await this._audioCtx.resume();
      } catch {
        /* ignore */
      }
    }
    return this._audioCtx;
  }

  async _loadSoundBuffer(rawName) {
    const ctx = await this._ensureAudioCtx();
    if (!ctx) return null;
    const key = normalizeSpriteKey(rawName);
    if (!key) return null;
    if (this._soundBuffers.has(key)) return this._soundBuffers.get(key);
    const safe = String(rawName ?? "").replace(/[^a-zA-Z0-9._-]+/g, "_");
    const bases = [`/static/sounds/${encodeURIComponent(safe)}`];
    const exts = [".mp3", ".ogg", ".wav"];
    for (const base of bases) {
      for (const ext of exts) {
        try {
          const res = await fetch(base + ext, { credentials: "same-origin" });
          if (!res.ok) continue;
          const ab = await res.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab.slice(0));
          this._soundBuffers.set(key, buf);
          return buf;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  async _playSound(rawName, volumeExpr) {
    const ctx = await this._ensureAudioCtx();
    if (!ctx) return;
    const buf = await this._loadSoundBuffer(rawName);
    if (!buf) return;
    let gain = volumeExpr != null ? Number(this.evalExpr(volumeExpr)) : 1;
    if (!Number.isFinite(gain)) gain = 1;
    gain = Math.max(0, Math.min(2, gain));
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const key = normalizeSpriteKey(rawName);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(ctx.destination);
    if (!this._soundSources.has(key)) this._soundSources.set(key, []);
    this._soundSources.get(key).push(src);
    src.onended = () => {
      const list = this._soundSources.get(key);
      if (!list) return;
      const i = list.indexOf(src);
      if (i >= 0) list.splice(i, 1);
    };
    try {
      src.start(0);
    } catch {
      /* ignore */
    }
  }

  _stopSoundNamed(rawName) {
    const key = normalizeSpriteKey(rawName);
    const list = this._soundSources.get(key);
    if (!list) return;
    for (const src of list) {
      try {
        src.stop();
      } catch {
        /* ignore */
      }
    }
    this._soundSources.delete(key);
  }

  async _postAwardXp(tier) {
    if (this.editorMode || !this.gameId) return;
    const t = String(tier || "").toLowerCase();
    if (t !== "small" && t !== "medium" && t !== "large") return;
    const token = readMetaCsrf();
    try {
      await fetch(`/api/games/${encodeURIComponent(this.gameId)}/xp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-CSRFToken": token, "X-CSRF-Token": token } : {}),
        },
        credentials: "same-origin",
        body: JSON.stringify({ amount: t }),
      });
    } catch {
      /* no-op */
    }
  }

  _colourFromExpr(node) {
    const v = this.evalExpr(node);
    if (typeof v === "string" && v.trim()) return v.trim();
    return "#FFFFFF";
  }

  async _setBackgroundImageByName(imageName) {
    const sheetKey = normalizeSpriteKey(imageName);
    let img = sheetKey ? this.spriteImages.get(sheetKey) ?? null : null;
    if ((!img || !img.naturalWidth) && sheetKey) {
      const url = String(this.spriteLibrary[sheetKey] ?? "").trim();
      if (url) {
        img = new Image();
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
          img.src = url;
        });
        if (img.naturalWidth) this.spriteImages.set(sheetKey, img);
      }
    }
    if (img && img.naturalWidth) {
      this.background = { kind: "image", color: this.background.color, image: img };
    }
  }

  reportParseError(err) {
    if (!this.onScriptError) return;
    const raw = err instanceof Error ? err.message : String(err);
    const m = raw.match(/\bat line (\d+)/);
    const line = m ? Number(m[1]) : null;
    const message = m
      ? (raw.slice(0, m.index).replace(/\s+$/, "").trim() || raw.trim())
      : raw.trim();
    const n = line != null ? String(line) : "?";
    const formatted = `Line ${n} — ${message}`;
    this.onScriptError({ phase: "parse", line, message, formatted });
  }

  reportRuntimeError(line, err) {
    if (!this.onScriptError) return;
    const msg = err instanceof Error ? err.message : String(err);
    const n = line != null ? String(line) : "?";
    const formatted = `Line ${n} — ${msg}`;
    this.onScriptError({ phase: "runtime", line, message: msg, formatted });
  }

  async safeExecBlock(body) {
    await this.execBlock(body || []);
  }

  async preloadSpriteImages() {
    this.spriteImages = new Map();
    const byUrl = new Map();
    const entries = Object.entries(this.spriteLibrary).filter(
      ([k, v]) => normalizeSpriteKey(k) && String(v ?? "").trim(),
    );
    for (const [key, url] of entries) {
      const urlStr = String(url).trim();
      const normKey = normalizeSpriteKey(key);
      let img = byUrl.get(urlStr);
      if (!img) {
        img = new Image();
        await new Promise((resolve) => {
          img.onload = resolve;
          img.onerror = resolve;
          img.src = urlStr;
        });
        if (img.naturalWidth) byUrl.set(urlStr, img);
      }
      if (img && img.naturalWidth) this.spriteImages.set(normKey, img);
    }
  }

  setupCanvas() {
    const s = this.resolutionScale;
    this.canvas.width = Math.round(DEFAULT_WIDTH * s);
    this.canvas.height = Math.round(DEFAULT_HEIGHT * s);
    this.ctx.setTransform(s, 0, 0, s, 0, 0);
    this.canvas.tabIndex = Math.max(this.canvas.tabIndex ?? 0, 0);
  }

  drawBackground() {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    this.ctx.clearRect(0, 0, cw, ch);
    if (this.background.kind === "image" && this.background.image?.naturalWidth) {
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.background.image, 0, 0, cw, ch);
      return;
    }
    this.ctx.fillStyle = this.background.color || "#0E0E14";
    this.ctx.fillRect(0, 0, cw, ch);
  }

  clearCanvas() {
    this.drawBackground();
  }

  drawEffectParticles() {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    for (const em of this.effectEmitters) {
      if (em?.draw) em.draw(ctx);
    }
  }

  drawTexts() {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    for (const entry of this.state.texts.values()) {
      if (!entry || entry.visible === false) continue;
      const alpha = Math.max(0, Math.min(1, Number(entry.opacity ?? 1)));
      if (alpha <= 0) continue;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = entry.colour || "#FFFFFF";
      const px = Math.round(
        Math.max(6, Math.min(72, Number(entry.size) || 14)),
      );
      ctx.font = `${px}px "Press Start 2P", monospace`;
      ctx.textBaseline = "top";
      const tx = Math.round(Number(entry.x) || 0);
      const ty = Math.round(Number(entry.y) || 0);
      ctx.fillText(String(entry.text ?? ""), tx, ty);
      ctx.restore();
    }
  }

  drawSprites() {
    const base = SPRITE_DRAW_SIZE;
    this.ctx.imageSmoothingEnabled = false;
    for (const sprite of this.state.sprites.values()) {
      if (!sprite.visible) continue;
      const alpha = Math.max(0, Math.min(1, Number(sprite.opacity)));
      if (alpha <= 0) continue;
      const sc = Number(sprite.scale) || 1;
      const rot = ((Number(sprite.rotation) || 0) * Math.PI) / 180;
      const w = base * Math.abs(sc);
      const h = base * Math.abs(sc);
      const cx = sprite.x + base / 2;
      const cy = sprite.y + base / 2;
      const img = sprite.image;
      this.ctx.save();
      this.ctx.globalAlpha = alpha;
      this.ctx.translate(cx, cy);
      this.ctx.rotate(rot);
      this.ctx.scale(sc < 0 ? -1 : 1, 1);
      if (img && img.naturalWidth) {
        this.ctx.drawImage(img, -w / 2, -h / 2, w, h);
      } else {
        this.ctx.fillStyle = "#2A2A38";
        this.ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      this.ctx.restore();
    }
  }

  runTouchChecks() {
    for (const h of this.touchHandlers) {
      const a = resolveSprite(h.sprite, this.state);
      if (!a) continue;
      let touching;
      if (h.kind === "wall") touching = this.spriteTouchesWall(a);
      else {
        const b = resolveSprite(h.other, this.state);
        touching = b ? this.spritesOverlap(a, b) : false;
      }
      const prev = this.touchPrev.get(h.id) ?? false;
      this.touchPrev.set(h.id, touching);
      if (touching && !prev) void this.safeExecBlock(h.body);
    }
  }

  runKeyHoldFrame() {
    for (const h of this.keyHoldHandlers) {
      const want = String(h.keyName).trim();
      let down = false;
      for (const k of this.keysDown) {
        if (keyMatches(want, k)) {
          down = true;
          break;
        }
      }
      if (down) void this.safeExecBlock(h.body);
    }
  }

  tick = () => {
    if (!this.running) return;
    this.runTouchChecks();
    this.runKeyHoldFrame();
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const dt = Math.min(0.05, Math.max(0, (now - this._lastTickMs) / 1000));
    this._lastTickMs = now;
    for (const em of this.effectEmitters) {
      if (em?.update) em.update(dt);
    }
    this.effectEmitters = this.effectEmitters.filter((e) => e && e.alive !== false);
    this.drawBackground();
    this.drawEffectParticles();
    this.drawSprites();
    this.drawTexts();
    this.rafId = requestAnimationFrame(this.tick);
  };

  on(eventName, handler) {
    if (!this.eventBus.has(eventName)) this.eventBus.set(eventName, []);
    this.eventBus.get(eventName).push(handler);
  }

  async emit(eventName) {
    const handlers = this.eventBus.get(eventName) || [];
    for (const handler of handlers) {
      if (!this.running) return;
      try {
        await handler();
      } catch (e) {
        this.reportRuntimeError(null, e);
      }
    }
  }

  async execBlock(stmts) {
    for (const st of stmts || []) {
      try {
        const r = await this.execStatement(st);
        if (r && r.flow !== "normal") return r;
      } catch (e) {
        this.reportRuntimeError(st?.line ?? null, e);
        return { flow: "normal" };
      }
    }
    return { flow: "normal" };
  }

  async execIf(stmt) {
    if (isTruthy(this.evalExpr(stmt.test))) return await this.execBlock(stmt.thenBody);
    for (const ei of stmt.elseIfs || []) {
      if (isTruthy(this.evalExpr(ei.test))) return await this.execBlock(ei.body);
    }
    if (stmt.elseBody) return await this.execBlock(stmt.elseBody);
    return { flow: "normal" };
  }

  async execRepeat(stmt) {
    const count = Math.max(0, Math.floor(Number(this.evalExpr(stmt.count)) || 0));
    for (let i = 0; i < count; i += 1) {
      if (!this.running) return { flow: "stop_game" };
      const r = await this.execBlock(stmt.body || []);
      if (r.flow === "break") return { flow: "normal" };
      if (r.flow === "continue") continue;
      if (r.flow === "stop_loop") return r;
      if (r.flow === "stop_game") return r;
    }
    return { flow: "normal" };
  }

  async execWhile(stmt) {
    while (this.running && isTruthy(this.evalExpr(stmt.cond))) {
      const r = await this.execBlock(stmt.body || []);
      if (r.flow === "break") return { flow: "normal" };
      if (r.flow === "continue") {
        await yieldFrame();
        continue;
      }
      if (r.flow === "stop_loop") return r;
      if (r.flow === "stop_game") return r;
      await yieldFrame();
    }
    return { flow: "normal" };
  }

  async execForever(stmt) {
    while (this.running) {
      const r = await this.execBlock(stmt.body || []);
      if (r.flow === "stop_loop") return { flow: "normal" };
      if (r.flow === "break") return r;
      if (r.flow === "continue") {
        await yieldFrame();
        continue;
      }
      if (r.flow === "stop_game") return r;
      await yieldFrame();
    }
    return { flow: "normal" };
  }

  async execStatement(stmt) {
    if (!this.running || !stmt) return { flow: "normal" };

    if (stmt.type === "IfStatement") return await this.execIf(stmt);
    if (stmt.type === "WhileStatement") return await this.execWhile(stmt);
    if (stmt.type === "LoopStatement") return await this.execForever(stmt);
    if (stmt.type === "RepeatStatement") return await this.execRepeat(stmt);

    if (stmt.type === "BreakStatement") return { flow: "break" };
    if (stmt.type === "ContinueStatement") return { flow: "continue" };
    if (stmt.type === "StopLoopStatement") return { flow: "stop_loop" };
    if (stmt.type === "StopGameStatement") {
      this.running = false;
      if (this.rafId != null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.removeKeyListeners();
      return { flow: "stop_game" };
    }

    if (stmt.type === "SetStatement") {
      const value = this.evalExpr(stmt.value);
      this.state.variables.set(stmt.variable, value);
      return { flow: "normal" };
    }

    if (stmt.type === "SetSpriteProperty") {
      const sprite = resolveSprite(stmt.sprite, this.state);
      if (!sprite) return { flow: "normal" };
      const v = this.evalExpr(stmt.value);
      const p = String(stmt.property || "").toLocaleLowerCase();
      if (p === "x") sprite.x = Number(v) || 0;
      else if (p === "y") sprite.y = Number(v) || 0;
      else if (p === "opacity") sprite.opacity = Math.max(0, Math.min(1, Number(v)));
      else if (p === "scale") sprite.scale = Number(v) || 1;
      else if (p === "rotation") sprite.rotation = Number(v) || 0;
      else if (p === "visible") sprite.visible = isTruthy(v);
      return { flow: "normal" };
    }

    if (stmt.type === "SpawnSprite") {
      const x = Number(this.evalExpr(stmt.x)) || 0;
      const y = Number(this.evalExpr(stmt.y)) || 0;
      const sheetKey = normalizeSpriteKey(stmt.spriteName);
      const image = sheetKey ? this.spriteImages.get(sheetKey) ?? null : null;
      this.state.sprites.set(
        stmt.variable,
        this.makeSpriteRecord(stmt.variable, stmt.spriteName, x, y, image),
      );
      return { flow: "normal" };
    }

    if (stmt.type === "MoveSprite") {
      const sprite = resolveSprite(stmt.sprite, this.state);
      if (!sprite) return { flow: "normal" };
      const x = Number(this.evalExpr(stmt.x)) || 0;
      const y = Number(this.evalExpr(stmt.y)) || 0;
      if (stmt.mode === "to") {
        sprite.x = x;
        sprite.y = y;
      } else {
        sprite.x += x;
        sprite.y += y;
      }
      return { flow: "normal" };
    }

    if (stmt.type === "SpinSprite") {
      const sprite = resolveSprite(stmt.sprite, this.state);
      if (!sprite) return { flow: "normal" };
      const v = Number(this.evalExpr(stmt.value)) || 0;
      if (stmt.mode === "by") sprite.rotation = (Number(sprite.rotation) || 0) + v;
      else sprite.rotation = v;
      return { flow: "normal" };
    }

    if (stmt.type === "HideSprite" || stmt.type === "ShowSprite") {
      const sprite = resolveSprite(stmt.sprite, this.state);
      if (!sprite) return { flow: "normal" };
      sprite.visible = stmt.type === "ShowSprite";
      return { flow: "normal" };
    }

    if (stmt.type === "WaitStatement") {
      const seconds = Number(this.evalExpr(stmt.duration)) || 0;
      await waitMs(seconds * 1000);
      return { flow: "normal" };
    }

    if (stmt.type === "AwardXpStatement") {
      await this._postAwardXp(stmt.amount);
      return { flow: "normal" };
    }

    if (stmt.type === "AddText") {
      const x = Number(this.evalExpr(stmt.x)) || 0;
      const y = Number(this.evalExpr(stmt.y)) || 0;
      this.state.texts.set(stmt.variable, {
        text: String(stmt.text ?? ""),
        x,
        y,
        colour: "#FFFFFF",
        size: 14,
        visible: true,
        opacity: 1,
      });
      return { flow: "normal" };
    }

    if (stmt.type === "SetTextProperty") {
      const row = this.state.texts.get(stmt.label);
      if (!row) return { flow: "normal" };
      const v = this.evalExpr(stmt.value);
      const p = String(stmt.property || "").toLowerCase();
      if (p === "text") row.text = String(v);
      else if (p === "colour") row.colour = typeof v === "string" && v.trim() ? v.trim() : String(v);
      else if (p === "size") row.size = Math.max(6, Math.min(96, Number(v) || 14));
      return { flow: "normal" };
    }

    if (stmt.type === "SetBackgroundColor") {
      const v = this.evalExpr(stmt.color);
      const s = typeof v === "string" ? v.trim() : "";
      if (s) this.background = { kind: "color", color: s, image: null };
      return { flow: "normal" };
    }

    if (stmt.type === "SetBackgroundImage") {
      await this._setBackgroundImageByName(stmt.imageName);
      return { flow: "normal" };
    }

    if (stmt.type === "PlayEffectStatement") {
      const x = Number(this.evalExpr(stmt.x)) || 0;
      const y = Number(this.evalExpr(stmt.y)) || 0;
      const opts = {};
      if (stmt.size != null) opts.size = this.evalExpr(stmt.size);
      if (stmt.colour != null) opts.colour = this._colourFromExpr(stmt.colour);
      if (stmt.amount != null) opts.amount = this.evalExpr(stmt.amount);
      const em = createEffectEmitter(
        stmt.effectName,
        x,
        y,
        this.canvas.width,
        this.canvas.height,
        opts,
      );
      this.effectEmitters.push(em);
      return { flow: "normal" };
    }

    if (stmt.type === "PlaySoundStatement") {
      await this._playSound(stmt.soundName, stmt.volume ?? null);
      return { flow: "normal" };
    }

    if (stmt.type === "StopSoundStatement") {
      this._stopSoundNamed(stmt.soundName);
      return { flow: "normal" };
    }

    if (stmt.type === "GoToSceneStatement") {
      this.running = false;
      if (this.rafId != null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.removeKeyListeners();
      if (this.onGoToScene) await this.onGoToScene(String(stmt.sceneName));
      return { flow: "stop_game" };
    }

    if (stmt.type === "RestartSceneStatement") {
      this.running = false;
      if (this.rafId != null) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.removeKeyListeners();
      if (this.onRestartScene) await this.onRestartScene();
      return { flow: "stop_game" };
    }

    if (stmt.type === "ToastStatement") {
      const raw = this.evalExpr(stmt.message);
      const msg = String(raw);
      let t = stmt.toastType || "success";
      if (t !== "error" && t !== "warning" && t !== "success") t = "success";
      if (this.onToast) this.onToast(msg, t);
      return { flow: "normal" };
    }

    if (stmt.type === "LogStatement") {
      const raw = this.evalExpr(stmt.value);
      if (this.onConsoleLog) this.onConsoleLog(String(raw));
      return { flow: "normal" };
    }

    return { flow: "normal" };
  }

  async runProgram(program) {
    for (const stmt of program.body || []) {
      if (stmt.type === "OnGameStart") {
        this.on("game_start", async () => {
          const r = await this.execBlock(stmt.body || []);
          if (r.flow === "stop_game" || r.flow === "break") {
            /* top-level break ignored */
          }
        });
        continue;
      }
      if (stmt.type === "OnKeyStatement") {
        if (stmt.mode === "press") this.keyPressHandlers.push(stmt);
        else if (stmt.mode === "release") this.keyReleaseHandlers.push(stmt);
        else if (stmt.mode === "hold") this.keyHoldHandlers.push(stmt);
        continue;
      }
      if (stmt.type === "OnTouchWallStatement") {
        const id = `t${this.touchHandlerId++}`;
        this.touchHandlers.push({
          id,
          kind: "wall",
          sprite: stmt.sprite,
          body: stmt.body,
        });
        continue;
      }
      if (stmt.type === "OnTouchSpriteStatement") {
        const id = `t${this.touchHandlerId++}`;
        this.touchHandlers.push({
          id,
          kind: "sprite",
          sprite: stmt.sprite,
          other: stmt.other,
          body: stmt.body,
        });
        continue;
      }
      try {
        await this.execStatement(stmt);
      } catch (e) {
        this.reportRuntimeError(stmt?.line ?? null, e);
      }
    }
    await this.emit("game_start");
  }

  stop() {
    this.running = false;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.removeKeyListeners();
    this._stopAllSounds();
    this.eventBus.clear();
    this.state.sprites.clear();
    this.state.variables.clear();
    this.state.texts.clear();
    this.effectEmitters = [];
    this.background = { kind: "color", color: "#0E0E14", image: null };
    this.keyPressHandlers = [];
    this.keyReleaseHandlers = [];
    this.keyHoldHandlers = [];
    this.touchHandlers = [];
    this.touchPrev.clear();
    this.clearCanvas();
  }

  async runScripts(scripts) {
    this.setupCanvas();
    await this.preloadSpriteImages();
    let program;
    try {
      program = toProgram(scripts);
    } catch (e) {
      this.reportParseError(e);
      this.running = false;
      this.clearCanvas();
      return;
    }
    this.running = true;
    const keyTarget =
      this.keyListenerRoot === "canvas"
        ? this.canvas
        : this.canvas.parentElement;
    this.installKeyListeners(keyTarget);
    this.tick();
    try {
      await this.runProgram(program);
    } catch (e) {
      this.reportRuntimeError(null, e);
    }
  }
}

function resolveSprite(name, state) {
  return state.sprites.get(String(name)) || null;
}

export async function run(scripts, canvas, options = {}) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("A valid canvas element is required");
  }
  stop();
  const runtime = new PixelRuntime(canvas, options);
  activeRuntime = runtime;
  await runtime.runScripts(scripts);
  return runtime;
}

export function stop() {
  if (activeRuntime) {
    activeRuntime.stop();
    activeRuntime = null;
  }
}
