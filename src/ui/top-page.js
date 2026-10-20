// Site-wide "Top films by weighted rating" page, mounted at /films/#weighted.
//
// Efficient by design:
//   pass 1  one histogram per film → instant Bayesian ranking
//   pass 2  a small stratified rater panel per film, worked top-down, with
//           rater profiles shared across films (top films share raters), and
//           results persisted so the run is resumable.
(function (root) {
  const LBW = root.LBW;
  const { stats, lb, ui } = LBW;
  const { esc, fmt, signed, pct, hash, rng, pick } = ui;

  const SOURCES = { 'by/rating': 'Highest rated', popular: 'Most popular' };
  const SORTS = {
    normalised: { label: 'Normalised', get: (f) => f.res?.normalised, help: "Rater-normalised score on a fixed site-wide scale: each rating as a z-score against the rater's own history." },
    pct: { label: 'Personal rank', get: (f) => f.res?.meanPct, help: "Average percentile of the film within each rater's own ratings." },
    loved: { label: 'Top-10% share', get: (f) => f.res?.favouriteShare, help: "Share of raters for whom it's a personal top-decile film." },
    activity: { label: 'Activity-weighted', get: (f) => f.res?.activityWeighted, help: 'Mean rating with new / barely-active accounts down-weighted.' },
    bayes: { label: 'Bayesian', get: (f) => f.bayes, help: 'Vote-count weighted: (v·R + m·C) / (v + m), pulling films with fewer ratings toward the site mean.' },
    lb: { label: 'Letterboxd', get: (f) => f.avg, help: "Letterboxd's own weighted average." },
  };
  const BAYES_M = 20000; // ratings needed to count half as much as the prior
  const BAYES_C = 3.3; // prior: a typical film's average
  const FRESH_DAYS = 7;

  const state = {
    source: 'by/rating', depth: 250, k: 40, sort: 'normalised',
    films: [], running: false, stopRequested: false, refined: 0, startedAt: 0, startReq: 0, filmsThisRun: 0, error: null,
  };
  let root$ = null;
  let paintQueued = false;

  function settingsKey() { return `top:settings`; }

  // ---------- pipeline ----------

  async function loadCandidates() {
    state.error = null;
    const pages = Math.ceil(state.depth / 72);
    const list = (await lb.getSiteList(state.source, pages)).slice(0, state.depth);
    state.films = list.map((f, i) => ({ ...f, lbRank: i + 1, counts: null, n: 0, bayes: NaN, res: null }));
    paint();

    // Pass 1: histograms (cheap, cached) → Bayesian score; stored results attached.
    await Promise.all(state.films.map(async (f) => {
      const [h, res] = await Promise.all([lb.getFilmHistogram(f.slug).catch(() => null), lb.getFilmResult(f.slug)]);
      if (h?.counts) {
        f.counts = h.counts;
        f.n = h.counts.reduce((a, b) => a + b, 0);
        if (Number.isFinite(h.weightedAverage)) f.avg = h.weightedAverage;
        f.bayes = (f.n * f.avg + BAYES_M * BAYES_C) / (f.n + BAYES_M);
      }
      if (res && Date.now() - res.at < FRESH_DAYS * lb.DAY) f.res = res;
      schedulePaint();
    }));
    paint();
  }

  // Small stratified sample of one film's raters → weighted metrics on the fixed scale.
  async function refineFilm(f) {
    const seed = hash(f.slug + ':top');
    const rand = rng(seed);
    const alloc = stats.allocateSample(f.counts, state.k, 2);
    const entries = [];
    const lists = await Promise.all(stats.RATINGS.map((r, i) => (alloc[i] ? lb.getUsersInBucket(f.slug, r).catch(() => []) : [])));
    lists.forEach((users, i) => {
      const chosen = pick(users, alloc[i], rand);
      const weight = chosen.length ? f.counts[i] / chosen.length : 0;
      chosen.forEach((user) => entries.push({ user, rating: stats.RATINGS[i], weight, source: 'sample' }));
    });
    const profiles = await Promise.all(entries.map((e) => lb.getProfile(e.user, 14)));
    const raters = entries.map((e, i) => (profiles[i] ? { ...e, counts: profiles[i].counts } : null)).filter(Boolean);
    if (raters.length < 5) return null;
    const a = stats.analyse(f.counts, raters, { ref: stats.GLOBAL_REF });
    const res = {
      normalised: a.normalised, normalisedSe: a.normalisedSe, meanZ: a.meanZ, meanPct: a.meanPct,
      favouriteShare: a.favouriteShare, activityWeighted: a.activityWeighted, sampleSize: a.sampleSize, scale: 'global',
    };
    await lb.saveFilmResult(f.slug, res);
    return { ...res, at: Date.now() };
  }

  async function run() {
    if (state.running) return;
    state.running = true;
    state.stopRequested = false;
    state.startedAt = Date.now();
    state.startReq = lb.netStats.requests;
    state.filmsThisRun = 0;
    paint();
    try {
      if (!state.films.length) await loadCandidates();
      // Work top-down by the best current estimate so the head of the table firms up first.
      const todo = () => state.films
        .filter((f) => f.counts && !f.busy && !(f.res && f.res.sampleSize >= state.k * 0.8 && f.res.scale === 'global'))
        .sort((a, b) => (b.bayes || 0) - (a.bayes || 0));
      const worker = async () => {
        while (!state.stopRequested) {
          const f = todo()[0];
          if (!f) return;
          f.busy = true;
          schedulePaint();
          try {
            const res = await refineFilm(f);
            if (res) f.res = res;
          } catch (e) {
            console.warn('[lbxd-weighted] top', f.slug, e);
          }
          f.busy = false;
          state.filmsThisRun++;
          schedulePaint();
        }
      };
      await Promise.all([worker(), worker()]); // two films in flight keeps the request queue full
    } catch (e) {
      state.error = e.message;
    }
    state.running = false;
    paint();
  }

  // ---------- view ----------

  function schedulePaint() {
    if (paintQueued) return;
    paintQueued = true;
    setTimeout(() => { paintQueued = false; paint(); }, 400);
  }

  function eta() {
    const left = state.films.filter((f) => f.counts && !(f.res && f.res.scale === 'global')).length;
    if (!state.running || state.filmsThisRun < 2) return { left, text: '' };
    const perFilm = (Date.now() - state.startedAt) / state.filmsThisRun;
    const mins = Math.round((perFilm * left) / 60000);
    const reqs = lb.netStats.requests - state.startReq;
    return { left, text: `~${mins < 1 ? '<1' : mins} min left · ${reqs.toLocaleString()} requests this run · ${(reqs / ((Date.now() - state.startedAt) / 1000)).toFixed(1)}/s` };
  }

  function row(f, i, lbRankOf) {
    const r = f.res;
    const move = f.lbRank - (i + 1);
    const moveHtml = !r ? '' : move > 0 ? `<span class="lbw-move -up" title="Letterboxd rank ${f.lbRank}">▲${move}</span>` : move < 0 ? `<span class="lbw-move -down" title="Letterboxd rank ${f.lbRank}">▼${-move}</span>` : '<span class="lbw-move">–</span>';
    const cell = (v, d = 2, isPct = false) => (Number.isFinite(v) ? (isPct ? pct(v) : fmt(v, d)) : '<span class="lbw-muted">…</span>');
    return `<tr class="${f.busy ? '-busy' : ''}${r ? '' : ' -pending'}">
      <td class="lbw-num lbw-muted">${i + 1}</td>
      <td class="lbw-num">${moveHtml}</td>
      <td><a class="lbw-user" href="/film/${esc(f.slug)}/">${esc(f.name)}</a>${f.busy ? ' <span class="lbw-chip">sampling…</span>' : ''}</td>
      <td class="lbw-num"><strong>${cell(r?.normalised)}</strong>${r && Number.isFinite(r.normalisedSe) ? `<span class="lbw-muted lbw-se">±${fmt(1.96 * r.normalisedSe, 2)}</span>` : ''}</td>
      <td class="lbw-num">${cell(r?.meanPct, 0, true)}</td>
      <td class="lbw-num">${cell(r?.favouriteShare, 0, true)}</td>
      <td class="lbw-num">${cell(r?.activityWeighted)}</td>
      <td class="lbw-num">${cell(f.bayes)}</td>
      <td class="lbw-num">${cell(f.avg)}</td>
      <td class="lbw-num lbw-muted">${f.n ? (f.n >= 1e6 ? `${(f.n / 1e6).toFixed(1)}M` : `${Math.round(f.n / 1000)}K`) : '…'}</td>
      <td class="lbw-num lbw-muted">${r ? r.sampleSize : ''}</td>
    </tr>`;
  }

  function paint() {
    if (!root$) return;
    const sortGet = SORTS[state.sort].get;
    const refined = state.films.filter((f) => f.res);
    // Refined films ranked by the chosen metric; unrefined ones follow in Bayesian order.
    const ordered = [
      ...refined.slice().sort((a, b) => (sortGet(b) ?? -Infinity) - (sortGet(a) ?? -Infinity)),
      ...state.films.filter((f) => !f.res).sort((a, b) => (b.bayes || 0) - (a.bayes || 0)),
    ];
    const { left, text } = eta();
    const total = state.films.length;
    root$.querySelector('.lbw-top-status').innerHTML = state.error
      ? `<span class="lbw-error">${esc(state.error)}</span>`
      : `${refined.length} of ${total || state.depth} films refined${left && !state.running ? ` · ${left} to go` : ''}${text ? ` · ${text}` : ''}`;
    root$.querySelector('.lbw-top-bar').style.width = total ? `${(100 * refined.length) / total}%` : '0';
    const btn = root$.querySelector('[data-act="top-run"]');
    btn.textContent = state.running ? (state.stopRequested ? 'Stopping…' : 'Pause') : refined.length ? 'Continue' : 'Start';
    root$.querySelectorAll('[data-sort]').forEach((th) => th.classList.toggle('-active', th.dataset.sort === state.sort));
    root$.querySelector('tbody').innerHTML = ordered.map((f, i) => row(f, i)).join('');
  }

  function mount(container) {
    container.innerHTML = `
      <section id="lbw-panel" class="lbw lbw-top">
        <header class="lbw-head">
          <div>
            <h1 class="lbw-title">Top films · weighted</h1>
            <p class="lbw-sub">Ranked by how each film's raters rate it against their own habits, not by raw stars</p>
          </div>
        </header>
        <div class="lbw-notice">
          <strong>This takes a long time.</strong> Each film is scored by sampling ${'<span data-k-label></span>'} real raters and reading every one of their rating histograms, so a full run over 250 films is several thousand page loads (roughly 20–60 minutes the first time). It's built to be efficient and resumable: an instant Bayesian ranking appears first, films are refined top-down, raters shared between films are only fetched once, and results are saved for ${FRESH_DAYS} days, so you can pause, close the tab and continue later. Films you've analysed on their own page are reused automatically. Requests are throttled to stay polite to Letterboxd.
        </div>
        <div class="lbw-controls">
          <label class="lbw-muted">List <select class="lbw-select" data-opt="source">${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
          <label class="lbw-muted">Films <select class="lbw-select" data-opt="depth">${[100, 250, 500].map((n) => `<option value="${n}">Top ${n}</option>`).join('')}</select></label>
          <label class="lbw-muted">Raters per film <select class="lbw-select" data-opt="k">${[20, 40, 80, 150].map((n) => `<option value="${n}">${n}${n === 40 ? ' (balanced)' : n === 20 ? ' (fast)' : n === 150 ? ' (precise)' : ''}</option>`).join('')}</select></label>
          <button type="button" class="lbw-btn" data-act="top-run">Start</button>
        </div>
        <div class="lbw-progress"><div class="lbw-bar lbw-top-bar"></div><span class="lbw-progress-label lbw-top-status"></span></div>
        <div class="lbw-top-table">
          <table class="lbw-table">
            <thead><tr>
              <th>#</th><th title="Places moved vs the Letterboxd ordering of this list">±</th><th>Film</th>
              ${Object.entries(SORTS).map(([k, s]) => `<th class="lbw-num lbw-sortable" data-sort="${k}" title="${esc(s.help)} Click to sort.">${s.label}</th>`).join('')}
              <th class="lbw-num">Ratings</th><th class="lbw-num" title="Raters sampled">n</th>
            </tr></thead>
            <tbody></tbody>
          </table>
        </div>
        <details class="lbw-method">
          <summary>How this is calculated</summary>
          <p><strong>Normalised</strong>: each sampled rating becomes a z-score against that rater's own rating history (this film's rating removed), the stratified sample is weighted back to the film's real histogram, and the mean z is mapped onto one fixed scale (μ ${stats.GLOBAL_REF.mean}, σ ${stats.GLOBAL_REF.sd}) so films are comparable. ± is a 95% interval from the sample.</p>
          <p><strong>Bayesian</strong>: (v·R + m·C) / (v + m) with m = ${BAYES_M.toLocaleString()} ratings and C = ${BAYES_C}, available instantly from each film's histogram.</p>
          <p>Unrefined films are listed after refined ones in Bayesian order.</p>
        </details>
      </section>`;
    root$ = container.querySelector('.lbw-top');
    const sync = () => {
      root$.querySelector('[data-opt="source"]').value = state.source;
      root$.querySelector('[data-opt="depth"]').value = String(state.depth);
      root$.querySelector('[data-opt="k"]').value = String(state.k);
      root$.querySelector('[data-k-label]').textContent = state.k;
    };
    sync();
    root$.addEventListener('change', async (e) => {
      const opt = e.target.dataset.opt;
      if (!opt) return;
      state[opt] = opt === 'source' ? e.target.value : Number(e.target.value);
      sync();
      try { await chrome.storage.local.set({ [settingsKey()]: { source: state.source, depth: state.depth, k: state.k, sort: state.sort } }); } catch (_) {}
      if (opt !== 'k' && !state.running) { state.films = []; await loadCandidates(); }
      paint();
    });
    root$.addEventListener('click', (e) => {
      const th = e.target.closest('[data-sort]');
      if (th) { state.sort = th.dataset.sort; paint(); return; }
      if (e.target.closest('[data-act="top-run"]')) {
        if (state.running) { state.stopRequested = true; paint(); } else run();
      }
    });
    paint();
  }

  async function open(container) {
    try {
      const saved = (await chrome.storage.local.get(settingsKey()))[settingsKey()];
      if (saved) Object.assign(state, saved);
    } catch (_) {}
    mount(container);
    await loadCandidates().catch((e) => { state.error = e.message; paint(); });
  }

  LBW.topPage = { open };
})(globalThis);
