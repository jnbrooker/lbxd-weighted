// Entry point: runs on letterboxd.com/film/<slug>/ and injects the dashboard.
(function () {
  const { stats, lb } = globalThis.LBW;

  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'film' || parts.length !== 2) return; // main film page only
  const slug = parts[1];

  const DEFAULTS = { sampleSize: 120, zThreshold: 2, reviewPages: 2, profileTtlDays: 14, autoRun: true };

  // ---------- small utils ----------

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const signed = (v, d = 2) => (Number.isFinite(v) ? (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d) : '—');
  const pct = (v, d = 0) => (Number.isFinite(v) ? (v * 100).toFixed(d) + '%' : '—');
  const stars = (r) => (Number.isFinite(r) ? '★'.repeat(Math.floor(r)) + (r % 1 ? '½' : '') : '—');

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

  // ---------- panel shell ----------

  const panel = document.createElement('section');
  panel.id = 'lbw-panel';
  panel.className = 'lbw';
  panel.innerHTML = `
    <header class="lbw-head">
      <div>
        <h2 class="lbw-title">Weighted stats</h2>
        <p class="lbw-sub">Ratings read against each rater's own habits</p>
      </div>
      <div class="lbw-actions">
        <button type="button" class="lbw-btn" data-act="run">Analyse</button>
        <button type="button" class="lbw-btn -ghost" data-act="toggle" aria-expanded="true" title="Collapse">–</button>
      </div>
    </header>
    <div class="lbw-progress" hidden><div class="lbw-bar"></div><span class="lbw-progress-label"></span></div>
    <div class="lbw-body"><p class="lbw-empty">Click <strong>Analyse</strong> to sample this film's raters.</p></div>
  `;
  const body = panel.querySelector('.lbw-body');
  const progress = panel.querySelector('.lbw-progress');

  panel.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'run') run(true);
    if (act === 'toggle') {
      const collapsed = panel.classList.toggle('-collapsed');
      e.target.textContent = collapsed ? '+' : '–';
      e.target.setAttribute('aria-expanded', String(!collapsed));
      try { chrome.storage.local.set({ 'ui:collapsed': collapsed }); } catch (_) {}
    }
  });

  function setProgress(done, total, label) {
    progress.hidden = total === 0 || done >= total;
    progress.querySelector('.lbw-bar').style.width = total ? `${(100 * done) / total}%` : '0';
    progress.querySelector('.lbw-progress-label').textContent = label || `${done} / ${total} profiles`;
  }

  // ---------- rendering ----------

  function tile(label, value, note, help, accent) {
    return `<div class="lbw-tile${accent ? ' -accent' : ''}" title="${esc(help)}">
      <div class="lbw-tile-label">${esc(label)}</div>
      <div class="lbw-tile-value">${value}</div>
      <div class="lbw-tile-note">${note}</div>
    </div>`;
  }

  function polarisationLabel(film) {
    if (!Number.isFinite(film.sd)) return '—';
    if (film.bimodality > 0.555 && film.sd > 1.1) return 'Divisive';
    if (film.sd > 1.15) return 'Mixed';
    if (film.sd < 0.75) return 'Consensus';
    return 'Typical spread';
  }

  function deviationChart(raters, flaggedUsers) {
    const W = 640, H = 170, padX = 28, top = 14, bottom = 30;
    const lo = -4, hi = 4;
    const x = (d) => padX + ((Math.max(lo, Math.min(hi, d)) - lo) / (hi - lo)) * (W - 2 * padX);
    const plotH = H - top - bottom;
    const ticks = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

    // Beeswarm: place each dot at the free offset nearest the centre line.
    const R = 4.5, D = 2 * R + 1, mid = top + plotH / 2, maxOff = plotH / 2 - R;
    const placed = [];
    const ys = new Map();
    raters.slice().sort((p, q) => p.delta - q.delta).forEach((r) => {
      const cx = x(r.delta);
      const near = placed.filter((p) => Math.abs(p.cx - cx) < D);
      let y = mid;
      for (let k = 0; k < 200; k++) {
        const off = Math.ceil(k / 2) * (D / 2) * (k % 2 ? -1 : 1);
        const cand = mid + Math.max(-maxOff, Math.min(maxOff, off));
        if (near.every((p) => (p.cx - cx) ** 2 + (p.y - cand) ** 2 >= D * D)) { y = cand; break; }
      }
      placed.push({ cx, y });
      ys.set(r, y);
    });

    const dots = raters.map((r) => {
      const jy = ys.get(r);
      const cls = r.delta > 0.25 ? '-up' : r.delta < -0.25 ? '-down' : '-flat';
      const ring = flaggedUsers.has(r.user) ? ' -flag' : '';
      const tip = `${r.name || r.user}: gave ${stars(r.rating)} · usually ${fmt(r.rawMean)} (${r.n} ratings) · ${signed(r.delta)}★ · z ${signed(r.z, 1)}`;
      return `<g class="lbw-dot ${cls}${ring}" data-tip="${esc(tip)}">
        <circle class="hit" cx="${x(r.delta).toFixed(1)}" cy="${jy.toFixed(1)}" r="9"></circle>
        <circle class="mark" cx="${x(r.delta).toFixed(1)}" cy="${jy.toFixed(1)}" r="4.5"></circle>
      </g>`;
    }).join('');

    return `
      <figure class="lbw-chart">
        <figcaption>
          <span>Each dot is a rater: how far this rating sits from their own average</span>
          <span class="lbw-legend"><i class="-down"></i>below their norm <i class="-flat"></i>about usual <i class="-up"></i>above their norm <i class="-ring"></i>out of character</span>
        </figcaption>
        <div class="lbw-chart-wrap">
          <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Distribution of rating deviations from each rater's personal average">
            ${ticks.map((t) => `<line class="grid${t === 0 ? ' -zero' : ''}" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - bottom}"></line>
              <text class="tick" x="${x(t)}" y="${H - bottom + 16}">${t === 0 ? '0' : signed(t, 0) + '★'}</text>`).join('')}
            ${dots}
          </svg>
          <div class="lbw-tip" hidden></div>
        </div>
      </figure>`;
  }

  function flaggedList(flagged, title, empty) {
    if (!flagged.length) return `<div class="lbw-flags"><h3>${esc(title)}</h3><p class="lbw-muted">${esc(empty)}</p></div>`;
    return `<div class="lbw-flags"><h3>${esc(title)}</h3><ol>${flagged.slice(0, 8).map((r) => {
      const link = r.link || `/${r.user}/film/${slug}/`;
      const share = (v) => (v < 0.01 ? '<1%' : pct(v));
      const where = r.pct >= 0.5 ? `top ${share(1 - r.pct)}` : `bottom ${share(r.pct)}`;
      return `<li>
        <a class="lbw-user" href="${esc(link)}">${esc(r.name || r.user)}</a>
        ${r.source === 'review' ? '<span class="lbw-chip">review</span>' : ''}
        ${r.contrarian ? '<span class="lbw-chip -contra" title="Also far from the crowd average">contrarian</span>' : ''}
        <div class="lbw-flag-line">
          <span class="lbw-stars">${stars(r.rating)}</span>
          <span class="lbw-muted">usually ${fmt(r.rawMean)} · ${where} of their ${r.n} ratings · z ${signed(r.z, 1)}</span>
        </div>
        ${r.excerpt ? `<p class="lbw-excerpt">${esc(r.excerpt)}${r.excerpt.length >= 220 ? '…' : ''}</p>` : ''}
      </li>`;
    }).join('')}</ol></div>`;
  }

  function render(result, meta) {
    const a = result;
    const f = a.film;
    const flaggedUsers = new Set(a.flagged.map((r) => r.user));
    const loved = a.flagged.filter((r) => r.z > 0);
    const hated = a.flagged.filter((r) => r.z < 0);

    body.innerHTML = `
      <div class="lbw-tiles">
        ${tile('Letterboxd', fmt(meta.weightedAverage), `${f.n.toLocaleString()} ratings`, "Letterboxd's own weighted average (their weighting formula is not public).")}
        ${tile('Raw mean', fmt(f.mean), `median ${stars(f.median)}`, 'Plain unweighted mean of every rating in the histogram.')}
        ${tile('Activity-weighted', fmt(a.activityWeighted), 'new accounts count less', 'Population-weighted sample mean where each rater counts by log(ratings), reaching full weight at 300 ratings.')}
        ${tile('Normalised', fmt(a.normalised), `z ${signed(a.meanZ)}`, "Each rating converted to a z-score against the rater's own history, averaged, then mapped back onto the pooled rating scale. Corrects for harsh and generous raters.", true)}
        ${tile('Vs their norm', signed(a.meanDelta) + '★', 'avg rating − rater avg', "On average, how many stars above or below their personal average raters scored this film.", true)}
        ${tile('Personal rank', pct(a.meanPct), 'avg percentile', "Where this film sits within each rater's own ratings (50% = an ordinary film for them).", true)}
      </div>
      <div class="lbw-strip">
        <span><strong>${pct(a.favouriteShare)}</strong> put it in their top 10%</span>
        <span><strong>${pct(a.dislikeShare)}</strong> in their bottom 10%</span>
        <span title="Standard deviation ${fmt(f.sd)}; bimodality coefficient ${fmt(f.bimodality)}"><strong>${polarisationLabel(f)}</strong> · sd ${fmt(f.sd)}</span>
        <span title="Share of sampled raters with fewer than 50 ratings"><strong>${pct(a.lowActivityShare)}</strong> low-activity raters</span>
      </div>
      ${deviationChart(a.raters, flaggedUsers)}
      <div class="lbw-flag-cols">
        ${flaggedList(loved, 'Loved it, against type', 'No unusually generous ratings in the sample.')}
        ${flaggedList(hated, 'Hated it, against type', 'No unusually harsh ratings in the sample.')}
      </div>
      <details class="lbw-method">
        <summary>How this is calculated</summary>
        <p>${a.sampleSize} raters sampled across all ten star buckets in proportion to the histogram (minimum 4 per bucket), each weighted back to its bucket's true size, plus raters from the top ${meta.reviewPages * 12} popular reviews (used for flags only). Each rater's personal histogram is read from their profile, with this film's rating removed. Thin accounts are shrunk toward the pooled average (μ ${fmt(a.ref.mean)}, σ ${fmt(a.ref.sd)}). A rating is flagged when it is ${meta.zThreshold}+ standard deviations from that rater's own average (raters with 25+ ratings only).</p>
        <p class="lbw-muted">${meta.partial ? 'Still loading — numbers will settle.' : `Sampled ${new Date(meta.at).toLocaleString()}. Profiles cached for ${meta.profileTtlDays} days.`}</p>
      </details>
    `;
    wireTooltip();
  }

  function wireTooltip() {
    const wrap = body.querySelector('.lbw-chart-wrap');
    const tip = wrap?.querySelector('.lbw-tip');
    if (!wrap) return;
    const show = (e) => {
      const g = e.target.closest('.lbw-dot');
      if (!g) { tip.hidden = true; return; }
      const rect = wrap.getBoundingClientRect();
      const c = g.querySelector('.mark').getBoundingClientRect();
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      const left = Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, c.left - rect.left - tip.offsetWidth / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${c.top - rect.top - tip.offsetHeight - 8}px`;
    };
    wrap.addEventListener('mouseover', show);
    wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  // ---------- orchestration ----------

  let running = false;

  async function run(reseed) {
    if (running) return;
    running = true;
    const btn = panel.querySelector('[data-act="run"]');
    btn.disabled = true;
    btn.textContent = 'Analysing…';
    try {
      const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
      setProgress(0, 1, 'Reading rating histogram…');
      const film = await lb.getFilmHistogram(slug);
      if (!film.counts || !film.counts.some(Boolean)) {
        body.innerHTML = '<p class="lbw-empty">This film has no ratings yet.</p>';
        setProgress(0, 0);
        return;
      }

      let seed = hash(slug);
      if (reseed) {
        seed = hash(slug + Date.now());
        try { await chrome.storage.local.set({ [`seed:${slug}`]: seed }); } catch (_) {}
      } else {
        try { seed = (await chrome.storage.local.get(`seed:${slug}`))[`seed:${slug}`] ?? seed; } catch (_) {}
      }
      const rand = rng(seed);

      // Stratified sample: per bucket, pick k users at random from the most recent 500.
      setProgress(0, 1, 'Sampling raters…');
      const alloc = stats.allocateSample(film.counts, settings.sampleSize);
      const entries = [];
      const bucketLists = await Promise.all(
        stats.RATINGS.map((r, i) => (alloc[i] ? lb.getUsersInBucket(slug, r).catch(() => []) : Promise.resolve([])))
      );
      bucketLists.forEach((users, i) => {
        const chosen = pick(users, alloc[i], rand);
        const weight = chosen.length ? film.counts[i] / chosen.length : 0;
        chosen.forEach((user) => entries.push({ user, rating: stats.RATINGS[i], weight, source: 'sample' }));
      });

      const reviews = settings.reviewPages > 0 ? await lb.getPopularReviews(slug, settings.reviewPages).catch(() => []) : [];
      reviews.forEach((r) => entries.push({ ...r, weight: 0, source: 'review' }));

      const users = [...new Set(entries.map((e) => e.user))];
      const profiles = new Map();
      let done = 0;
      let lastPaint = 0;
      const meta = { ...settings, weightedAverage: film.weightedAverage, at: Date.now(), partial: true };

      const paint = () => {
        const raters = entries
          .filter((e) => profiles.get(e.user))
          .map((e) => ({ ...e, counts: profiles.get(e.user).counts, name: e.name || profiles.get(e.user).name }));
        if (raters.length) render(stats.analyse(film.counts, raters, settings), meta);
      };

      setProgress(0, users.length);
      await Promise.all(users.map(async (u) => {
        profiles.set(u, await lb.getProfile(u, settings.profileTtlDays));
        done++;
        setProgress(done, users.length);
        if (done - lastPaint >= 20) { lastPaint = done; paint(); }
      }));

      meta.partial = false;
      meta.at = Date.now();
      paint();
      setProgress(0, 0);
    } catch (err) {
      console.error('[lbxd-weighted]', err);
      body.insertAdjacentHTML('afterbegin', `<p class="lbw-error">Couldn't finish: ${esc(err.message)}</p>`);
      setProgress(0, 0);
    } finally {
      running = false;
      btn.disabled = false;
      btn.textContent = 'Resample';
    }
  }

  // ---------- mount ----------

  (async () => {
    const anchor = await waitFor(['.film-recent-reviews', '#film-page-wrapper .col-17', '.ratings-histogram-chart']);
    if (!anchor) return;
    if (anchor.matches('.film-recent-reviews')) anchor.before(panel);
    else if (anchor.matches('.col-17')) anchor.append(panel);
    else anchor.after(panel);

    const [settings, ui] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS).catch(() => DEFAULTS),
      chrome.storage.local.get('ui:collapsed').catch(() => ({})),
    ]);
    if (ui['ui:collapsed']) panel.querySelector('[data-act="toggle"]').click();
    if (settings.autoRun) run(false);
  })();
})();
