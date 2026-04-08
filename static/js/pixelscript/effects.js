/**
 * Canvas particle emitters for PixelScript `play effect`.
 */

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hexToRgb(str) {
  let h = String(str ?? "").trim();
  if (!h.startsWith("#")) h = `#${h}`;
  if (!/^#[0-9A-Fa-f]{6}$/.test(h)) return { r: 255, g: 100, b: 180 };
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function rnd(a, b) {
  return a + Math.random() * (b - a);
}

export function createEffectEmitter(kind, x, y, canvasW, canvasH, opts = {}) {
  const k = String(kind || "")
    .trim()
    .toLowerCase();
  const size = Math.max(0.2, Number(opts.size) || 1);
  const colour = opts.colour != null ? opts.colour : "#FF4FAD";
  const rgb = hexToRgb(colour);
  const amountMul = Math.max(0.3, Number(opts.amount) || 1);

  if (k === "fireworks") return fireworksEmitter(x, y, canvasW, canvasH, rgb, size);
  if (k === "confetti") return confettiEmitter(x, y, canvasW, canvasH, rgb, size, amountMul);
  if (k === "explosion") return explosionEmitter(x, y, rgb, size);
  if (k === "sparkle") return sparkleEmitter(x, y, rgb, size, amountMul);
  if (k === "smoke") return smokeEmitter(x, y, size, amountMul);
  return fireworksEmitter(x, y, canvasW, canvasH, rgb, size);
}

function fireworksEmitter(x, y, _cw, _ch, rgb, size) {
  const bursts = 2 + Math.floor(Math.random() * 2);
  const particles = [];
  for (let b = 0; b < bursts; b += 1) {
    const cx = x + rnd(-18, 18) * size;
    const cy = y + rnd(-12, 12) * size;
    const n = Math.floor(40 * size);
    for (let i = 0; i < n; i += 1) {
      const ang = rnd(0, Math.PI * 2);
      const sp = rnd(40, 140) * size;
      particles.push({
        x: cx,
        y: cy,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp,
        life: rnd(0.6, 1.2),
        age: 0,
        r: clamp(rgb.r + rnd(-40, 40), 0, 255),
        g: clamp(rgb.g + rnd(-40, 40), 0, 255),
        b: clamp(rgb.b + rnd(-40, 40), 0, 255),
        sz: rnd(1.5, 3) * size,
      });
    }
  }
  return stepParticles(particles, { gravity: 120 * size, drag: 0.96 });
}

function confettiEmitter(x, y, _cw, _ch, rgb, size, amountMul) {
  const n = Math.floor(80 * size * amountMul);
  const particles = [];
  for (let i = 0; i < n; i += 1) {
    particles.push({
      x: x + rnd(-20, 20) * size,
      y: y + rnd(-10, 10) * size,
      vx: rnd(-100, 100) * size,
      vy: rnd(-180, -40) * size,
      rot: rnd(0, Math.PI * 2),
      vr: rnd(-8, 8),
      life: rnd(1.2, 2.2),
      age: 0,
      w: rnd(3, 6) * size,
      h: rnd(4, 9) * size,
      r: i % 3 === 0 ? rgb.r : rnd(80, 255),
      g: i % 3 === 1 ? rgb.g : rnd(80, 255),
      b: i % 3 === 2 ? rgb.b : rnd(80, 255),
    });
  }
  return stepConfetti(particles, { gravity: 220 * size });
}

function stepConfetti(particles, env) {
  const gravity = env.gravity ?? 200;
  return {
    alive: true,
    update(dt) {
      let live = false;
      for (const p of particles) {
        if (p.age >= p.life) continue;
        live = true;
        p.age += dt;
        p.vy += gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;
      }
      if (!live) this.alive = false;
    },
    draw(ctx) {
      for (const p of particles) {
        if (p.age >= p.life) continue;
        const t = 1 - p.age / p.life;
        ctx.save();
        ctx.globalAlpha = t;
        ctx.fillStyle = `rgb(${p.r | 0},${p.g | 0},${p.b | 0})`;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    },
  };
}

function stepParticles(particles, env) {
  const gravity = env.gravity ?? 100;
  const drag = env.drag ?? 0.98;
  return {
    alive: true,
    update(dt) {
      let live = false;
      for (const p of particles) {
        if (p.age >= p.life) continue;
        live = true;
        p.age += dt;
        p.vy += gravity * dt;
        p.vx *= drag;
        p.vy *= drag;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      if (!live) this.alive = false;
    },
    draw(ctx) {
      ctx.save();
      for (const p of particles) {
        if (p.age >= p.life) continue;
        const t = 1 - p.age / p.life;
        ctx.globalAlpha = t;
        ctx.fillStyle = `rgb(${p.r | 0},${p.g | 0},${p.b | 0})`;
        const s = p.sz * (0.7 + 0.3 * t);
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
      ctx.restore();
    },
  };
}

function explosionEmitter(x, y, rgb, size) {
  const n = Math.floor(55 * size);
  const particles = [];
  for (let i = 0; i < n; i += 1) {
    const ang = rnd(0, Math.PI * 2);
    const sp = rnd(90, 220) * size;
    particles.push({
      x,
      y,
      vx: Math.cos(ang) * sp,
      vy: Math.sin(ang) * sp,
      life: rnd(0.25, 0.55),
      age: 0,
      r: rgb.r,
      g: rgb.g,
      b: rgb.b,
      sz: rnd(2, 5) * size,
    });
  }
  return stepParticles(particles, { gravity: 40 * size, drag: 0.92 });
}

function sparkleEmitter(x, y, rgb, size, amountMul) {
  const n = Math.floor(28 * size * amountMul);
  const particles = [];
  for (let i = 0; i < n; i += 1) {
    particles.push({
      x: x + rnd(-24, 24) * size,
      y: y + rnd(-24, 24) * size,
      life: rnd(0.2, 0.55),
      age: 0,
      r: clamp(rgb.r + rnd(-20, 80), 0, 255),
      g: clamp(rgb.g + rnd(-20, 80), 0, 255),
      b: clamp(rgb.b + rnd(-20, 80), 0, 255),
      sz: rnd(1, 3) * size,
    });
  }
  return {
    alive: true,
    update(dt) {
      let live = false;
      for (const p of particles) {
        if (p.age >= p.life) continue;
        live = true;
        p.age += dt;
      }
      if (!live) this.alive = false;
    },
    draw(ctx) {
      for (const p of particles) {
        if (p.age >= p.life) continue;
        const t = 1 - p.age / p.life;
        ctx.save();
        ctx.globalAlpha = t;
        ctx.fillStyle = `rgb(${p.r | 0},${p.g | 0},${p.b | 0})`;
        const s = p.sz * (0.4 + 0.6 * Math.sin(t * Math.PI));
        ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
        ctx.restore();
      }
    },
  };
}

function smokeEmitter(x, y, size, amountMul) {
  const n = Math.floor(22 * size * amountMul);
  const particles = [];
  for (let i = 0; i < n; i += 1) {
    particles.push({
      x: x + rnd(-12, 12) * size,
      y: y + rnd(-8, 8) * size,
      vx: rnd(-12, 12) * size,
      vy: rnd(-35, -10) * size,
      life: rnd(1, 2.2),
      age: 0,
      r0: rnd(50, 90),
      rad: rnd(8, 18) * size,
      grow: rnd(18, 35) * size,
    });
  }
  return {
    alive: true,
    update(dt) {
      let live = false;
      for (const p of particles) {
        if (p.age >= p.life) continue;
        live = true;
        p.age += dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
      }
      if (!live) this.alive = false;
    },
    draw(ctx) {
      ctx.save();
      for (const p of particles) {
        if (p.age >= p.life) continue;
        const t = p.age / p.life;
        const rad = p.rad + p.grow * t;
        ctx.globalAlpha = (1 - t) * 0.45;
        ctx.fillStyle = `rgb(${p.r0 | 0},${p.r0 | 0},${(p.r0 + 20) | 0})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
}
