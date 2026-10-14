/* Visualizer engine: a handful of classic-style, music-driven screens drawn on a canvas.
   The player gives it the audio analysis through `source`; it never touches the audio. */
(() => {
  'use strict';

  const TAU = Math.PI * 2;
  const MODES = [
    { id: 'burst',  name: 'Ambience: Plasma Storm' },
    { id: 'bars',   name: 'Bars: Stereo Stack' },
    { id: 'scope',  name: 'Scope: Green Phosphor' },
    { id: 'warp',   name: 'Space: Starlight Drive' },
    { id: 'ripples', name: 'Ripple: Still Pond' },
    { id: 'waves',  name: 'Waves: Midnight Tide' },
    { id: 'art',    name: 'Album Art: Pulse' },
  ];
  const BANDS = 64;

  function create(canvas, source) {
    const ctx = canvas.getContext('2d');
    const freq = new Uint8Array(1024);
    const wave = new Uint8Array(2048);
    const bands = new Float32Array(BANDS);
    const peaks = new Float32Array(BANDS);
    const smooth = new Float32Array(BANDS);
    let w = 0, h = 0, dpr = 1;
    let raf = 0, running = false, mode = 0, last = 0, t = 0;
    let level = 0;             // 0 when silent, 1 at full music; eases so pausing fades out
    let bass = 0, mid = 0, treble = 0, avgBass = 0, lastBeat = 0, beat = 0;
    let hueBase = 300, rotation = 0;
    const listeners = [];
    let stars = null, rings = [], coverImg = null, coverKey = null;
    let auto = false, autoAt = 0;

    const bandEdges = (() => {
      const edges = [];
      for (let i = 0; i <= BANDS; i++) edges.push(Math.round(2 * Math.pow(480 / 2, i / BANDS)));
      return edges;
    })();

    function resize() {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const nw = Math.max(2, Math.round(rect.width)), nh = Math.max(2, Math.round(rect.height));
      if (nw === w && nh === h && canvas.width === nw * dpr) return;
      w = nw; h = nh;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    }

    // ---- analysis ----
    function analyse(dt) {
      const live = source.fill(freq, wave);
      const target = live && source.playing() ? 1 : 0;
      level += (target - level) * Math.min(1, dt * (target ? 6 : 2.2));
      if (!live) {                       // nothing to analyse: a quiet idle shimmer
        for (let i = 0; i < freq.length; i++) {
          const f = i / freq.length;
          freq[i] = Math.max(0, 28 * (1 - f * 2) * (0.6 + 0.4 * Math.sin(t * 1.3 + i * 0.07))) | 0;
        }
        for (let i = 0; i < wave.length; i++) wave[i] = 128 + 10 * Math.sin(t * 2 + i * 0.03) | 0;
      }
      for (let b = 0; b < BANDS; b++) {
        let sum = 0; const from = bandEdges[b], to = Math.max(bandEdges[b + 1], from + 1);
        for (let i = from; i < to; i++) sum += freq[i];
        const v = sum / (to - from) / 255;
        const boosted = Math.min(1, v * (1 + b / BANDS * 0.9));
        bands[b] = boosted;
        smooth[b] += (boosted - smooth[b]) * Math.min(1, dt * 14);
        peaks[b] = Math.max(smooth[b], peaks[b] - dt * 0.55);
      }
      let s = 0; for (let i = 1; i < 9; i++) s += freq[i];
      bass = s / 8 / 255;
      s = 0; for (let i = 9; i < 90; i++) s += freq[i]; mid = s / 81 / 255;
      s = 0; for (let i = 90; i < 400; i++) s += freq[i]; treble = s / 310 / 255;
      avgBass = avgBass * 0.94 + bass * 0.06;
      beat = Math.max(0, beat - dt * 3.5);
      if (bass > 0.28 && bass > avgBass * 1.22 && t - lastBeat > 0.17) { beat = 1; lastBeat = t; onBeat(); }
    }

    function onBeat() {
      if (MODES[mode].id === 'ripples') rings.push({ r: 8, hue: (hueBase + rings.length * 23) % 360, power: 0.5 + bass });
    }

    const hsl = (hue, s, l, a = 1) => `hsla(${((hue % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
    const fade = (alpha) => { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = `rgba(0,0,0,${alpha})`; ctx.fillRect(0, 0, w, h); };
    const clear = () => { ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h); };

    // ---- screens ----
    const draw = {
      burst(dt) {
        fade(0.14 + (1 - level) * 0.1);
        const cx = w / 2, cy = h / 2, maxR = Math.min(w, h) * 0.5;
        rotation += dt * (0.12 + bass * 0.9);
        hueBase = (hueBase + dt * (6 + treble * 40)) % 360;
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        const rays = 72;
        for (let i = 0; i < rays; i++) {
          const v = smooth[(i * 7) % BANDS] * level;
          if (v < 0.04) continue;
          const angle = rotation + (i / rays) * TAU;
          const len = maxR * (0.12 + v * 0.95);
          let x = cx + Math.cos(angle) * maxR * 0.06, y = cy + Math.sin(angle) * maxR * 0.06;
          ctx.beginPath(); ctx.moveTo(x, y);
          const segs = 9;
          for (let sIdx = 1; sIdx <= segs; sIdx++) {
            const d = (sIdx / segs) * len;
            const jitter = (Math.random() - 0.5) * 26 * v * (sIdx / segs + 0.3);
            x = cx + Math.cos(angle) * d + Math.cos(angle + Math.PI / 2) * jitter;
            y = cy + Math.sin(angle) * d + Math.sin(angle + Math.PI / 2) * jitter;
            ctx.lineTo(x, y);
          }
          ctx.strokeStyle = hsl(hueBase + i * 1.4, 100, 52 + v * 20, 0.35 + v * 0.55);
          ctx.lineWidth = 1 + v * 2.4;
          ctx.shadowColor = hsl(hueBase + i, 100, 60, 0.9); ctx.shadowBlur = 10 + v * 16;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR * (0.25 + bass * 0.5 * level + beat * 0.15));
        glow.addColorStop(0, hsl(hueBase, 100, 70, 0.55 * level + 0.08));
        glow.addColorStop(0.45, hsl(hueBase + 30, 100, 50, 0.22 * level + 0.03));
        glow.addColorStop(1, hsl(hueBase + 60, 100, 40, 0));
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, maxR, 0, TAU); ctx.fill();
      },

      bars(dt) {
        clear();
        const n = 48, gap = Math.max(2, w / 220), bw = (w - gap * (n + 1)) / n, floor = h * 0.8, top = h * 0.12;
        ctx.strokeStyle = 'rgba(80,140,200,0.10)'; ctx.lineWidth = 1;
        for (let gy = 0; gy < 8; gy++) { const y = top + (floor - top) * gy / 7; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
        for (let i = 0; i < n; i++) {
          const b = Math.min(BANDS - 1, Math.floor(i * BANDS / n));
          const v = Math.min(1, smooth[b] * level * 1.05);
          const x = gap + i * (bw + gap), bh = Math.max(2, v * (floor - top));
          const g = ctx.createLinearGradient(0, floor, 0, floor - (floor - top));
          g.addColorStop(0, '#16c24a'); g.addColorStop(0.6, '#e8e22a'); g.addColorStop(1, '#ff3b30');
          ctx.fillStyle = g; ctx.fillRect(x, floor - bh, bw, bh);
          const pk = Math.min(1, peaks[b] * level) * (floor - top);
          ctx.fillStyle = '#e8f6ff'; ctx.fillRect(x, floor - pk - 4, bw, 3);
          ctx.fillStyle = 'rgba(120,220,255,0.18)'; ctx.fillRect(x, floor + 4, bw, bh * 0.45);
        }
      },

      scope(dt) {
        fade(0.2);
        const mid = h / 2, amp = h * 0.38 * (0.35 + level * 0.9);
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineJoin = 'round';
        for (let pass = 0; pass < 2; pass++) {
          ctx.beginPath();
          const step = Math.max(1, Math.floor(wave.length / w));
          for (let i = 0, x = 0; i < wave.length; i += step, x++) {
            const v = (wave[i] - 128) / 128;
            const y = mid + v * amp * (pass ? -0.5 : 1);
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = pass ? 'rgba(80,255,170,0.5)' : '#5dff7a';
          ctx.lineWidth = pass ? 1.4 : 2.6; ctx.shadowColor = '#3dff6a'; ctx.shadowBlur = pass ? 6 : 16;
          ctx.stroke();
        }
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(60,255,120,0.10)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
      },

      warp(dt) {
        fade(0.28);
        if (!stars) stars = Array.from({ length: 260 }, () => ({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() }));
        const cx = w / 2, cy = h / 2, speed = 0.12 + (bass * 1.6 + beat * 0.8) * level;
        ctx.globalCompositeOperation = 'lighter';
        for (const s of stars) {
          const pz = s.z;
          s.z -= dt * speed * 0.55;
          if (s.z <= 0.02) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; continue; }
          const k = Math.min(w, h) * 0.55;
          const x = cx + (s.x / s.z) * k * 0.5, y = cy + (s.y / s.z) * k * 0.5;
          const px = cx + (s.x / pz) * k * 0.5, py = cy + (s.y / pz) * k * 0.5;
          if (x < -50 || x > w + 50 || y < -50 || y > h + 50) { s.z = 1; continue; }
          ctx.strokeStyle = hsl(210 + treble * 120 + s.x * 30, 90, 70, Math.min(1, (1 - s.z) * 1.4));
          ctx.lineWidth = 0.6 + (1 - s.z) * 2.2;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(x, y); ctx.stroke();
        }
      },

      ripples(dt) {
        const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
        g.addColorStop(0, '#07182e'); g.addColorStop(1, '#010409');
        ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
        if (level < 0.05 && t - lastBeat > 1.4) { lastBeat = t; rings.push({ r: 8, hue: (hueBase += 40) % 360, power: 0.3 }); }
        ctx.globalCompositeOperation = 'lighter';
        const maxR = Math.hypot(w, h) * 0.5;
        rings = rings.filter((r) => r.r < maxR);
        for (const r of rings) {
          r.r += dt * (120 + r.power * 260);
          const a = Math.max(0, 1 - r.r / maxR);
          ctx.strokeStyle = hsl(r.hue + r.r * 0.15, 90, 60, a * 0.9);
          ctx.lineWidth = 2 + a * 7 * r.power; ctx.shadowColor = hsl(r.hue, 100, 60, 0.8); ctx.shadowBlur = 18;
          ctx.beginPath(); ctx.arc(w / 2, h / 2, r.r, 0, TAU); ctx.stroke();
        }
        ctx.shadowBlur = 0;
        const core = 12 + bass * 60 * level + beat * 22;
        const cg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, core * 2.4);
        cg.addColorStop(0, hsl(hueBase + 20, 100, 78, 0.95)); cg.addColorStop(1, hsl(hueBase, 100, 50, 0));
        ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(w / 2, h / 2, core * 2.4, 0, TAU); ctx.fill();
      },

      waves(dt) {
        fade(0.3);
        hueBase = (hueBase + dt * 10) % 360;
        ctx.globalCompositeOperation = 'lighter';
        for (let layer = 0; layer < 3; layer++) {
          const base = h * (0.62 + layer * 0.06), amp = h * (0.34 - layer * 0.07) * (0.25 + level);
          ctx.beginPath(); ctx.moveTo(0, h);
          const pts = 40;
          for (let i = 0; i <= pts; i++) {
            const b = Math.min(BANDS - 1, Math.floor((i / pts) * (BANDS - 1) * (0.5 + layer * 0.25)));
            const v = smooth[b] * level;
            const x = (i / pts) * w;
            const y = base - v * amp - Math.sin(t * (0.9 + layer * 0.4) + i * 0.35 + layer) * h * 0.018;
            if (i === 0) ctx.lineTo(0, y); else ctx.lineTo(x, y);
          }
          ctx.lineTo(w, h); ctx.closePath();
          const grad = ctx.createLinearGradient(0, base - amp, 0, h);
          grad.addColorStop(0, hsl(hueBase + layer * 55, 95, 62, 0.55)); grad.addColorStop(1, hsl(hueBase + layer * 55 + 40, 90, 30, 0.1));
          ctx.fillStyle = grad; ctx.fill();
        }
      },

      art(dt) {
        clear();
        const key = source.coverKey();
        if (key !== coverKey) {
          coverKey = key; coverImg = null;
          if (key) { const img = new Image(); img.onload = () => { if (coverKey === key) coverImg = img; }; img.src = `/api/library/cover/${key}`; }
        }
        const size = Math.min(w, h) * (0.62 + bass * 0.12 * level + beat * 0.03);
        const x = (w - size) / 2, y = (h - size) / 2 - h * 0.03;
        if (coverImg) {
          ctx.globalAlpha = 0.28; ctx.drawImage(coverImg, -w * 0.1, -h * 0.1, w * 1.2, h * 1.2); ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, w, h);
          ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 30; ctx.drawImage(coverImg, x, y, size, size); ctx.shadowBlur = 0;
        } else {
          const g = ctx.createLinearGradient(x, y, x + size, y + size);
          g.addColorStop(0, hsl(hueBase, 70, 45)); g.addColorStop(1, hsl(hueBase + 60, 70, 25));
          ctx.fillStyle = g; ctx.fillRect(x, y, size, size);
          ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = `${size * 0.4}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('♪', x + size / 2, y + size / 2);
        }
        const n = 56, bw = w / n;
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < n; i++) {
          const v = smooth[Math.floor(i * BANDS / n)] * level, bh = v * h * 0.22;
          ctx.fillStyle = hsl(200 + i * 2.2, 90, 60, 0.75);
          ctx.fillRect(i * bw + 1, h - bh, bw - 2, bh);
        }
      },
    };

    function frame(now) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000 || 0.016); last = now; t += dt;
      resize();
      analyse(dt);
      if (auto && t > autoAt) { setMode((mode + 1) % MODES.length); }
      draw[MODES[mode].id](dt);
      ctx.globalCompositeOperation = 'source-over';
    }

    function setMode(i, announce = true) {
      mode = ((i % MODES.length) + MODES.length) % MODES.length;
      stars = null; rings = []; clear();
      autoAt = t + 28;
      if (announce) listeners.forEach((fn) => fn(MODES[mode], mode));
    }

    return {
      modes: MODES,
      start() { if (running) return; running = true; last = performance.now(); resize(); raf = requestAnimationFrame(frame); },
      stop() { running = false; cancelAnimationFrame(raf); },
      isRunning: () => running,
      next: () => setMode(mode + 1),
      prev: () => setMode(mode - 1),
      set: (i) => setMode(i),
      mode: () => mode,
      onChange: (fn) => listeners.push(fn),
      setAuto(on) { auto = Boolean(on); autoAt = t + 28; },
      auto: () => auto,
      onTrackChange() { if (auto) setMode(mode + 1); },
      resize,
    };
  }

  window.IP.Viz = { create, MODES };
})();
