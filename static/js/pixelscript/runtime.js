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

class PixelRuntime {
  constructor(canvas, { editorMode = false, spriteLibrary = {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.editorMode = editorMode;
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
    };
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
    el.addEventListener("keydown", this._onKeyDown);
    el.addEventListener("keyup", this._onKeyUp);
  }

  removeKeyListeners() {
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

  async safeExecBlock(body) {
    try {
      await this.execBlock(body || []);
    } catch {
      /* ignore */
    }
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
    this.canvas.width = DEFAULT_WIDTH;
    this.canvas.height = DEFAULT_HEIGHT;
    this.canvas.tabIndex = Math.max(this.canvas.tabIndex ?? 0, 0);
  }

  clearCanvas() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = "#0E0E14";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
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
    this.clearCanvas();
    this.drawSprites();
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
      await handler();
    }
  }

  async execBlock(stmts) {
    for (const st of stmts || []) {
      const r = await this.execStatement(st);
      if (r && r.flow !== "normal") return r;
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
      if (this.editorMode) return { flow: "normal" };
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
      await this.execStatement(stmt);
    }
    await this.emit("game_start");
  }

  stop() {
    this.running = false;
    if (this.rafId != null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.removeKeyListeners();
    this.eventBus.clear();
    this.state.sprites.clear();
    this.state.variables.clear();
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
    this.running = true;
    this.installKeyListeners(this.canvas.parentElement);
    this.tick();
    const program = toProgram(scripts);
    await this.runProgram(program);
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
