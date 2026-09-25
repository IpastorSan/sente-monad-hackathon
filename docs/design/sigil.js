/*
 * Agent sigils: every agent gets a 4×4 corner of a goban with its own stones on
 * it, derived from its id, so two agents never look alike and the same agent
 * always looks the same. In the app this is a tiny Skia/SVG component seeded
 * with the agent id; here it fills every `[data-sigil="<id>"]` on the page.
 */
(function () {
  const N = 4;
  const EDGE = 12;

  function hash(seed) {
    let h = 2166136261;
    for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return () => {
      h ^= h << 13;
      h ^= h >>> 17;
      h ^= h << 5;
      return (h >>> 0) / 4294967296;
    };
  }

  function sigil(seed) {
    const rand = hash(seed);
    const step = (100 - 2 * EDGE) / (N - 1);
    const at = (i) => EDGE + i * step;
    let lines = '';
    for (let i = 0; i < N; i++) {
      const p = at(i).toFixed(2);
      lines += `<line x1="${EDGE}" y1="${p}" x2="${100 - EDGE}" y2="${p}"/>`;
      lines += `<line x1="${p}" y1="${EDGE}" x2="${p}" y2="${100 - EDGE}"/>`;
    }
    const taken = new Set();
    const count = 3 + Math.floor(rand() * 2);
    let stones = '';
    for (let k = 0; k < count; k++) {
      let x, y;
      do {
        x = Math.floor(rand() * N);
        y = Math.floor(rand() * N);
      } while (taken.has(`${x},${y}`));
      taken.add(`${x},${y}`);
      const fill = k % 2 === 0 ? 'var(--purple)' : 'var(--text)';
      stones += `<circle cx="${at(x)}" cy="${at(y)}" r="${step * 0.44}" fill="${fill}"/>`;
    }
    return (
      `<svg viewBox="0 0 100 100" aria-hidden="true">` +
      `<g stroke="var(--line-strong)" stroke-width="3">${lines}</g>${stones}</svg>`
    );
  }

  for (const el of document.querySelectorAll('[data-sigil]')) {
    el.innerHTML = sigil(el.dataset.sigil);
  }
})();
