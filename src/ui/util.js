// Shared formatting + DOM helpers for the dashboard tabs.
(function (root) {
  const LBW = (root.LBW = root.LBW || {});

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const signed = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d) : '—');
  const pct = (v, d = 0) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—');
  const stars = (r) => (Number.isFinite(r) ? '★'.repeat(Math.floor(r)) + (r % 1 ? '½' : '') : '—');
  const share = (v) => (v < 0.01 ? '<1%' : pct(v));
  // "top 12%" / "bottom 3%" of someone's own ratings
  const rankFor = (p) => (!Number.isFinite(p) ? '—' : p >= 0.5 ? `top ${share(1 - p)}` : `bottom ${share(p)}`);
  // Taste correlation in [-1, 1] shown as a 0–100% match.
  const matchPct = (r) => `${Math.round(((r + 1) / 2) * 100)}%`;

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function pick(arr, k, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a.slice(0, k);
  }

  function waitFor(selectors, timeout = 6000) {
    return new Promise((resolve) => {
      const find = () => selectors.map((s) => document.querySelector(s)).find(Boolean);
      const hit = find();
      if (hit) return resolve(hit);
      const obs = new MutationObserver(() => {
        const el = find();
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(find() || null); }, timeout);
    });
  }

  // Human phrase for a taste facet: "Celine Song films", "Korean-language films"…
  function facetName(p) {
    switch (p.type) {
      case 'director': return `${p.label} films`;
      case 'actor': return `films with ${p.label}`;
      case 'theme': return `“${p.label}”`;
      case 'genre': return p.label.toLowerCase();
      case 'language': return `${p.label}-language films`;
      case 'country': return `films from ${p.label}`;
      case 'decade': return `${p.label} films`;
      case 'similar': return 'similar films';
      default: return p.label;
    }
  }

  // Chip for a facet's pull on a prediction, e.g. "Celine Song films +1.1σ · 2".
  function facetChip(p) {
    const cls = p.raw > 0.15 ? '-pos' : p.raw < -0.15 ? '-neg' : '';
    const examples = (p.films || []).slice().sort((a, b) => b.rating - a.rating).slice(0, 3)
      .map((f) => `${f.name} ${stars(f.rating)}`).join(', ');
    const tip = `${p.n} rated ${facetName(p)}: averaging ${signed(p.raw, 2)} standard deviations vs their usual${examples ? ` — e.g. ${examples}` : ''}`;
    return `<span class="lbw-chip -facet ${cls}" title="${esc(tip)}">${esc(facetName(p))} ${signed(p.raw, 1)}σ · ${p.n}</span>`;
  }

  // Top-n facet chips that actually moved the prediction.
  const topFacets = (pred, n = 3) =>
    (pred?.parts || []).filter((p) => Math.abs(p.contribution) >= 0.04).slice(0, n).map(facetChip).join('');

  const confDot = (c) => `<span class="lbw-conf -${c}" title="${c} confidence"></span>`;

  LBW.ui = { esc, fmt, signed, pct, stars, share, rankFor, matchPct, hash, rng, pick, waitFor, facetName, facetChip, topFacets, confDot };
})(globalThis);
