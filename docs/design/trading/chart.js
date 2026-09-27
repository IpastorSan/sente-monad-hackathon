/*
 * SenteChart — the study's one chart library (SEN-61). Plain SVG, no
 * dependencies, deterministic data from a seed so every page and every reload
 * draws the same market.
 *
 * Declarative: put a `data-chart` element on the page with a JSON config and
 * this file draws it on load.
 *
 *   <div data-chart='{"type":"line","seed":"MON","height":220,"scrub":"#mon-price"}'></div>
 *
 * Config (all optional except type):
 *   type        "line" | "candles" | "spark" | "area"   (area = sign-tinted P&L/equity chart)
 *   seed        string; same seed → same series
 *   points      number of samples (line/area default 96, candles 48, spark 30)
 *   start       first price (default 1)            drift  trend per step, e.g. 0.004
 *   vol         volatility per step (default 0.012)
 *   height      px (default 200; spark 28)
 *   decimals    price decimals for labels (default 4 if price < 10, else 2)
 *   prev        true → dashed previous-close line at the first price
 *   last        true (default for line/candles) → pinned last-price tag on the right edge
 *   lines       [{ at: price | "+3%" | "-2%", kind: "entry"|"tp"|"sl"|"liq"|"limit", label }]
 *   fit         false → scale to the price only; out-of-range lines become edge chips (↑/↓)
 *   markers     [{ i: sampleIndex (negative counts from the end), kind: "agent"|"you"|"buy"|"sell", label? }]
 *   scrub       CSS selector of an element that shows the price: set to the last price on
 *               draw and to the scrubbed price while dragging. `scrubChange` selector gets
 *               the change vs the first price (add `data-suffix=" today"` to keep a suffix).
 *   tone        "auto" (default: mint if up, berry if down) | "purple" | "mint" | "berry"
 *   axis        true → faint price labels on the right
 *
 * The same series is available to page scripts via `SenteChart.series(seed, opts)`
 * so a headline price can agree with its chart.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const C = {
    text: '#F3F0FF',
    dim: '#AAA3CB',
    faint: '#6F688F',
    line: '#2A2447',
    lineStrong: '#40386A',
    purple: '#836EF9',
    purpleHi: '#A898FF',
    purpleSoft: '#DDD7FE',
    mint: '#5FE3B3',
    berry: '#F0508C',
    ink: '#0D0A19',
  };
  let uid = 0;

  function rng(seed) {
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      return (h >>> 0) / 4294967296;
    };
  }

  /** A deterministic random walk: [{o,h,l,c}] per step. */
  function series(seed, opts = {}) {
    const n = opts.points ?? 96;
    const vol = opts.vol ?? 0.012;
    const drift = opts.drift ?? 0.0006;
    const rand = rng(seed);
    let price = opts.start ?? 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = price;
      const shock = (rand() + rand() + rand() - 1.5) * vol * 1.4;
      const c = Math.max(o * (1 + drift + shock), 1e-9);
      const wick = Math.abs(c - o) + o * vol * rand() * 0.8;
      out.push({ o, c, h: Math.max(o, c) + wick * rand(), l: Math.min(o, c) - wick * rand() });
      price = c;
    }
    return out;
  }

  function el(name, attrs, parent) {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function fmt(value, decimals) {
    return value.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function resolveLevel(at, first, last) {
    if (typeof at === 'number') return at;
    const m = /^([+-]?\d+(?:\.\d+)?)%$/.exec(String(at));
    return m ? last * (1 + Number(m[1]) / 100) : first;
  }

  const LINE_STYLE = {
    entry: { color: C.text, dash: '5 4' },
    tp: { color: C.mint, dash: '5 4' },
    sl: { color: C.berry, dash: '5 4' },
    liq: { color: C.berry, dash: '1.5 3.5' },
    limit: { color: C.purpleSoft, dash: '5 4' },
  };

  function draw(host, cfg) {
    const type = cfg.type ?? 'line';
    const spark = type === 'spark';
    const candles = type === 'candles';
    const data = series(cfg.seed ?? 'x', {
      ...cfg,
      points: cfg.points ?? (candles ? 48 : spark ? 30 : 96),
    });
    const closes = data.map((d) => d.c);
    const first = data[0].o;
    const last = closes[closes.length - 1];
    const up = last >= first;
    const tone =
      cfg.tone && cfg.tone !== 'auto'
        ? C[cfg.tone === 'purple' ? 'purple' : cfg.tone]
        : up
          ? C.mint
          : C.berry;
    const decimals = cfg.decimals ?? (last < 10 ? 4 : 2);

    const W = host.clientWidth || 350;
    const H = cfg.height ?? (spark ? 28 : 200);
    const tagChars = fmt(
      Math.max(...data.map((d) => d.h)),
      cfg.decimals ?? (data[data.length - 1].c < 10 ? 4 : 2),
    ).length;
    const padR = spark
      ? 4
      : cfg.last === false && !cfg.axis
        ? 8
        : Math.max(58, tagChars * 6.4 + 22);
    const padT = spark ? 3 : 14;
    const padB = spark ? 3 : 14;

    const levels = (cfg.lines ?? []).map((l) => ({ ...l, price: resolveLevel(l.at, first, last) }));
    // `fit: false` scales to the price only; a level outside it is pinned to
    // the edge as a labelled chip with an arrow, so a far liquidation price
    // can't flatten the chart.
    const fitted = cfg.fit === false ? [] : levels.map((l) => l.price);
    let lo = Math.min(...(candles ? data.map((d) => d.l) : closes), ...fitted);
    let hi = Math.max(...(candles ? data.map((d) => d.h) : closes), ...fitted);
    if (cfg.prev) {
      lo = Math.min(lo, first);
      hi = Math.max(hi, first);
    }
    const span = hi - lo || hi * 0.01 || 1;
    lo -= span * 0.06;
    hi += span * 0.06;

    const x = (i) => (i / (data.length - 1)) * (W - padR);
    const y = (p) => padT + (1 - (p - lo) / (hi - lo)) * (H - padT - padB);

    const svg = el('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      height: H,
      class: 'sc',
      role: 'img',
      'aria-label': cfg.label ?? `${cfg.seed ?? ''} chart`,
    });
    host.innerHTML = '';
    host.appendChild(svg);
    const id = `sc${++uid}`;

    if (cfg.axis) {
      for (let k = 0; k <= 3; k++) {
        const p = lo + ((hi - lo) * k) / 3;
        el(
          'line',
          { x1: 0, x2: W - padR, y1: y(p), y2: y(p), stroke: C.line, 'stroke-width': 1 },
          svg,
        );
        const t = el(
          'text',
          { x: W - 4, y: y(p) + 3, 'text-anchor': 'end', class: 'sc-axis' },
          svg,
        );
        t.textContent = fmt(p, decimals);
      }
    }

    if (cfg.prev) {
      el(
        'line',
        {
          x1: 0,
          x2: W - padR,
          y1: y(first),
          y2: y(first),
          stroke: C.lineStrong,
          'stroke-dasharray': '2 4',
          'stroke-width': 1,
        },
        svg,
      );
    }

    if (candles) {
      const bw = Math.max(2, ((W - padR) / data.length) * 0.62);
      data.forEach((d, i) => {
        const color = d.c >= d.o ? C.mint : C.berry;
        el(
          'line',
          { x1: x(i), x2: x(i), y1: y(d.h), y2: y(d.l), stroke: color, 'stroke-width': 1 },
          svg,
        );
        el(
          'rect',
          {
            x: x(i) - bw / 2,
            y: y(Math.max(d.o, d.c)),
            width: bw,
            height: Math.max(1, Math.abs(y(d.o) - y(d.c))),
            fill: color,
            rx: 1,
          },
          svg,
        );
      });
    } else {
      const path = closes
        .map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p).toFixed(1)}`)
        .join('');
      if (!spark || type === 'area') {
        const defs = el('defs', {}, svg);
        const g = el('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
        el('stop', { offset: '0%', 'stop-color': tone, 'stop-opacity': 0.28 }, g);
        el('stop', { offset: '100%', 'stop-color': tone, 'stop-opacity': 0 }, g);
        el('path', { d: `${path}L${x(data.length - 1)},${H}L0,${H}Z`, fill: `url(#${id})` }, svg);
      }
      el(
        'path',
        {
          d: path,
          fill: 'none',
          stroke: tone,
          'stroke-width': spark ? 1.5 : 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        },
        svg,
      );
      if (spark) {
        el('circle', { cx: x(data.length - 1), cy: y(last), r: 2.5, fill: tone }, svg);
      }
    }

    for (const l of levels) {
      const s = LINE_STYLE[l.kind] ?? LINE_STYLE.entry;
      if (l.price < lo || l.price > hi) {
        const below = l.price < lo;
        const ey = below ? H - 4 : 12;
        const text = `${below ? '↓' : '↑'} ${l.label ?? l.kind.toUpperCase()} ${fmt(l.price, decimals)}`;
        const t = el('text', { x: 6, y: ey, class: 'sc-level', fill: s.color }, svg);
        t.textContent = text;
        continue;
      }
      el(
        'line',
        {
          x1: 0,
          x2: W - padR,
          y1: y(l.price),
          y2: y(l.price),
          stroke: s.color,
          'stroke-dasharray': s.dash,
          'stroke-width': 1.2,
        },
        svg,
      );
      const label = `${l.label ?? l.kind.toUpperCase()} ${fmt(l.price, decimals)}`;
      const t = el('text', { x: 6, y: y(l.price) - 5, class: 'sc-level', fill: s.color }, svg);
      t.textContent = label;
    }

    for (const m of cfg.markers ?? []) {
      const i = m.i < 0 ? data.length + m.i : m.i;
      const d = data[Math.max(0, Math.min(data.length - 1, i))];
      const cx = x(i);
      const cy = y(d.c);
      if (m.kind === 'agent') {
        el(
          'circle',
          { cx, cy, r: 6, fill: C.purple, stroke: C.purpleHi, 'stroke-width': 1.5 },
          svg,
        );
      } else if (m.kind === 'you') {
        el('circle', { cx, cy, r: 6, fill: '#ECE8FB', stroke: '#fff', 'stroke-width': 1 }, svg);
      } else {
        el(
          'circle',
          {
            cx,
            cy,
            r: 4.5,
            fill: m.kind === 'sell' ? C.berry : C.mint,
            stroke: C.ink,
            'stroke-width': 1.5,
          },
          svg,
        );
      }
      if (m.label) {
        const t = el(
          'text',
          { x: cx, y: cy - 10, 'text-anchor': 'middle', class: 'sc-marker' },
          svg,
        );
        t.textContent = m.label;
      }
    }

    if (!spark && cfg.last !== false) {
      const ly = y(last);
      el('circle', { cx: x(data.length - 1), cy: ly, r: 3.5, fill: tone }, svg);
      const tagW = padR - 8;
      el('rect', { x: W - padR + 6, y: ly - 10, width: tagW, height: 20, rx: 10, fill: tone }, svg);
      const t = el(
        'text',
        { x: W - padR + 6 + tagW / 2, y: ly + 4, 'text-anchor': 'middle', class: 'sc-tag' },
        svg,
      );
      t.textContent = fmt(last, decimals);
    }

    if (cfg.scrub && !spark) {
      const target = document.querySelector(cfg.scrub);
      const change = cfg.scrubChange ? document.querySelector(cfg.scrubChange) : null;
      // The headline is the chart's own last price and change, so the two can
      // never disagree. `data-suffix` on the change element survives (" today").
      const suffix = change?.dataset.suffix ?? '';
      const pctText = (p) => {
        const pct = ((p - first) / first) * 100;
        return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%${suffix}`;
      };
      if (target) target.textContent = fmt(last, decimals);
      if (change) {
        change.textContent = pctText(last);
        change.classList.remove('up', 'down');
        change.classList.add(up ? 'up' : 'down');
      }
      const rest = {
        price: target?.textContent,
        change: change?.textContent,
        cls: change?.className,
      };
      const cross = el('line', { y1: 0, y2: H, stroke: C.dim, 'stroke-width': 1, opacity: 0 }, svg);
      const dot = el(
        'circle',
        { r: 5, fill: tone, stroke: C.ink, 'stroke-width': 2, opacity: 0 },
        svg,
      );
      const move = (evt) => {
        const box = svg.getBoundingClientRect();
        const px = ((evt.clientX - box.left) / box.width) * W;
        const i = Math.max(
          0,
          Math.min(data.length - 1, Math.round((px / (W - padR)) * (data.length - 1))),
        );
        const p = closes[i];
        cross.setAttribute('x1', x(i));
        cross.setAttribute('x2', x(i));
        cross.setAttribute('opacity', 0.5);
        dot.setAttribute('cx', x(i));
        dot.setAttribute('cy', y(p));
        dot.setAttribute('opacity', 1);
        if (target) target.textContent = fmt(p, decimals);
        if (change) {
          change.textContent = pctText(p);
          change.classList.remove('up', 'down');
          change.classList.add(p >= first ? 'up' : 'down');
        }
      };
      const leave = () => {
        cross.setAttribute('opacity', 0);
        dot.setAttribute('opacity', 0);
        if (target) target.textContent = rest.price;
        if (change) {
          change.textContent = rest.change;
          change.className = rest.cls;
        }
      };
      svg.style.touchAction = 'pan-y';
      svg.addEventListener('pointermove', move);
      svg.addEventListener('pointerdown', move);
      svg.addEventListener('pointerleave', leave);
      svg.addEventListener('pointerup', leave);
    }
    return { first, last, up, data };
  }

  function drawAll(root = document) {
    for (const host of root.querySelectorAll('[data-chart]')) {
      try {
        draw(host, JSON.parse(host.dataset.chart));
      } catch (error) {
        host.textContent = `chart config error: ${error.message}`;
      }
    }
  }

  window.SenteChart = { draw, drawAll, series, fmt };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => drawAll());
  } else {
    drawAll();
  }
})();
