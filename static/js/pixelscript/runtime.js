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

function resolveValue(node, state) {
  if (!node) return 0;
  if (node.type === "NumberLiteral") return Number(node.value) || 0;
  if (node.type === "StringLiteral") return String(node.value);
  if (node.type === "Identifier") return state.variables.get(node.name) ?? 0;
  return 0;
}

function resolveSprite(name, state) {
  return state.sprites.get(String(name)) || null;
}

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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
  }

  clearCanvas() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.fillStyle = "#0E0E14";
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  drawSprites() {
    const size = SPRITE_DRAW_SIZE;
    this.ctx.imageSmoothingEnabled = false;
    for (const sprite of this.state.sprites.values()) {
      if (!sprite.visible) continue;
      const img = sprite.image;
      if (img && img.naturalWidth) {
        this.ctx.drawImage(img, sprite.x, sprite.y, size, size);
      } else {
        this.ctx.fillStyle = "#2A2A38";
        this.ctx.fillRect(sprite.x, sprite.y, size, size);
      }
    }
  }

  tick = () => {
    if (!this.running) return;
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

  async execStatement(stmt) {
    if (!this.running || !stmt) return;
    if (stmt.type === "SetStatement") {
      const value = resolveValue(stmt.value, this.state);
      this.state.variables.set(stmt.variable, value);
      return;
    }

    if (stmt.type === "SpawnSprite") {
      const x = Number(resolveValue(stmt.x, this.state)) || 0;
      const y = Number(resolveValue(stmt.y, this.state)) || 0;
      const sheetKey = normalizeSpriteKey(stmt.spriteName);
      const image = sheetKey ? this.spriteImages.get(sheetKey) ?? null : null;
      this.state.sprites.set(stmt.variable, {
        id: stmt.variable,
        name: stmt.spriteName,
        x,
        y,
        visible: true,
        image,
      });
      return;
    }

    if (stmt.type === "MoveSprite") {
      const sprite = resolveSprite(stmt.sprite, this.state);
      if (!sprite) return;
      const x = Number(resolveValue(stmt.x, this.state)) || 0;
      const y = Number(resolveValue(stmt.y, this.state)) || 0;
      if (stmt.mode === "to") {
        sprite.x = x;
        sprite.y = y;
      } else {
        sprite.x += x;
        sprite.y += y;
      }
      return;
    }

    if (stmt.type === "HideSprite" || stmt.type === "ShowSprite") {
      const sprite = resolveSprite(stmt.sprite, this.state);
      if (!sprite) return;
      sprite.visible = stmt.type === "ShowSprite";
      return;
    }

    if (stmt.type === "WaitStatement") {
      const seconds = Number(resolveValue(stmt.duration, this.state)) || 0;
      await waitMs(seconds * 1000);
      return;
    }

    if (stmt.type === "RepeatStatement") {
      const count = Math.max(0, Number(resolveValue(stmt.count, this.state)) || 0);
      for (let i = 0; i < count; i += 1) {
        if (!this.running) return;
        for (const child of stmt.body || []) {
          await this.execStatement(child);
          if (!this.running) return;
        }
      }
      return;
    }

    if (stmt.type === "AwardXpStatement") {
      // In editor mode this is intentionally suppressed.
      if (this.editorMode) return;
      return;
    }
  }

  async runProgram(program) {
    for (const stmt of program.body || []) {
      if (stmt.type === "OnGameStart") {
        this.on("game_start", async () => {
          for (const inner of stmt.body || []) {
            await this.execStatement(inner);
          }
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
    this.eventBus.clear();
    this.state.sprites.clear();
    this.state.variables.clear();
    this.clearCanvas();
  }

  async runScripts(scripts) {
    this.setupCanvas();
    await this.preloadSpriteImages();
    this.running = true;
    this.tick();
    const program = toProgram(scripts);
    await this.runProgram(program);
  }
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
