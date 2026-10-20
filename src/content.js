// Entry point: runs on letterboxd.com/film/<slug>/ and injects the dashboard.
(function () {
  const { stats, lb, ui, filmTab, friendsTab, forYouTab, recommend } = globalThis.LBW;
  const { esc, hash, rng, pick, waitFor } = ui;

  const parts = location.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'film' || parts.length !== 2) return; // main film page only
  const slug = parts[1];

  const DEFAULTS = {
    sampleSize: 300, zThreshold: 1.75, reviewPages: 2, profileTtlDays: 14, autoRun: true,
    username: '', friends: true, maxFriends: 500, friendBatch: 40, tasteChecks: 15,
  };

  const filmName = (document.querySelector('meta[property="og:title"]')?.content || slug).replace(/\s*\(\d{4}\)\s*$/, '');
  const ctx = { slug, filmName, facets: lb.parseFacets(document), similar: [], alsoLoved: null, meanZ: NaN, ref: null };
  let settings = { ...DEFAULTS };
  let me = null;

  // ---------- shell ----------

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
    <nav class="lbw-tabs" role="tablist">
      <button type="button" role="tab" data-tab="film" aria-selected="true">Film stats</button>
      <button type="button" role="tab" data-tab="friends" aria-selected="false">Friends</button>
      <button type="button" role="tab" data-tab="foryou" aria-selected="false">For a friend</button>
    </nav>
    <div class="lbw-progress" hidden><div class="lbw-bar"></div><span class="lbw-progress-label"></span></div>
    <div class="lbw-tabpanel" data-panel="film"><p class="lbw-empty">Click <strong>Analyse</strong> to sample this film's raters.</p></div>
    <div class="lbw-tabpanel" data-panel="friends" hidden></div>
    <div class="lbw-tabpanel" data-panel="foryou" hidden></div>
  `;
  const panes = {
    film: panel.querySelector('[data-panel="film"]'),
    friends: panel.querySelector('[data-panel="friends"]'),
    foryou: panel.querySelector('[data-panel="foryou"]'),
  };
  const progress = panel.querySelector('.lbw-progress');

  function setProgress(done, total, label) {
    progress.hidden = total === 0 || done >= total;
    progress.querySelector('.lbw-bar').style.width = total ? `${(100 * done) / total}%` : '0';
    progress.querySelector('.lbw-progress-label').textContent = label || `${done} / ${total} profiles`;
  }

  function showTab(name) {
    panel.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    Object.entries(panes).forEach(([k, el]) => { el.hidden = k !== name; });
    try { chrome.storage.local.set({ 'ui:tab': name }); } catch (_) {}
    if (name === 'foryou') ensureForYou();
  }

  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]')?.dataset.tab;
    if (tab) return showTab(tab);
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'run') run(true);
    if (act === 'more-friends') predictFriends();
    if (act === 'run-foryou') runForYou();
    if (act === 'toggle') {
      const collapsed = panel.classList.toggle('-collapsed');
      e.target.textContent = collapsed ? '+' : '–';
      e.target.setAttribute('aria-expanded', String(!collapsed));
      try { chrome.storage.local.set({ 'ui:collapsed': collapsed }); } catch (_) {}
    }
  });
  panel.addEventListener('change', (e) => {
    if (e.target.matches('[data-act="pick-friend"]')) forYou.selected = e.target.value;
  });

  // ---------- film stats ----------

  let running = false;
  let flagState = null;

  async function run(reseed) {
    if (running) return;
    running = true;
    const btn = panel.querySelector('[data-act="run"]');
    btn.disabled = true;
    btn.textContent = 'Analysing…';
    try {
      setProgress(0, 1, 'Reading rating histogram…');
      const film = await lb.getFilmHistogram(slug);
      if (!film.counts || !film.counts.some(Boolean)) {
        panes.film.innerHTML = '<p class="lbw-empty">This film has no ratings yet.</p>';
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
      const [bucketLists, similar] = await Promise.all([
        Promise.all(stats.RATINGS.map((r, i) => (alloc[i] ? lb.getUsersInBucket(slug, r).catch(() => []) : Promise.resolve([])))),
        lb.getSimilar(slug).catch(() => []),
      ]);
      ctx.similar = similar;
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
        if (!raters.length) return null;
        const result = stats.analyse(film.counts, raters, settings);
        filmTab.render(panes.film, result, meta);
        return result;
      };

      setProgress(0, users.length);
      await Promise.all(users.map(async (u) => {
        profiles.set(u, await lb.getProfile(u, settings.profileTtlDays));
        done++;
        setProgress(done, users.length);
        if (done - lastPaint >= 40) { lastPaint = done; paint(); }
      }));

      meta.partial = false;
      meta.at = Date.now();
      const result = paint();
      setProgress(0, 0);
      if (!result) return;
      ctx.meanZ = result.meanZ;
      ctx.ref = result.ref;

      flagState = { quick: result.flagged, refined: null, pending: 0, checked: 0 };
      filmTab.renderFlags(panes.film, flagState, slug);
      await Promise.all([
        refineFlags(result, meta),
        fansAlsoLove(result, rand),
        settings.friends ? startFriends() : null,
      ]);
    } catch (err) {
      console.error('[lbxd-weighted]', err);
      panes.film.insertAdjacentHTML('afterbegin', `<p class="lbw-error">Couldn't finish: ${esc(err.message)}</p>`);
      setProgress(0, 0);
    } finally {
      running = false;
      btn.disabled = false;
      btn.textContent = 'Resample';
    }
  }

  // Against type, properly: build each unusual rater's expected rating from
  // their own history with this film's facets, then flag big misses.
  async function refineFlags(result, meta) {
    const seen = new Set();
    const cands = result.raters
      .filter((r) => r.n >= 25 && (Math.abs(r.z) >= 1 || r.source === 'review'))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
      .filter((r) => (seen.has(r.user) ? false : seen.add(r.user)))
      .slice(0, settings.tasteChecks);
    flagState.pending = cands.length;
    filmTab.renderFlags(panes.film, flagState, slug);

    const checked = await Promise.all(cands.map(async (r) => {
      const facets = await lb.getUserFacetRatings(r.user, ctx.facets, { excludeSlug: slug, similar: ctx.similar, lean: true }).catch(() => []);
      const expected = stats.predictRating(stats.leaveOneOut(r.counts, r.rating), { facets, crowdZ: result.meanZ, ref: result.ref });
      if (!expected) return null;
      return {
        ...r,
        expected,
        resid: (r.rating - expected.rating) / expected.sd,
        contrarian: Math.abs(r.rating - result.film.mean) >= 1.75,
      };
    }));
    const ok = checked.filter(Boolean);
    flagState.refined = ok.filter((r) => Math.abs(r.resid) >= meta.zThreshold).sort((a, b) => Math.abs(b.resid) - Math.abs(a.resid));
    flagState.checked = ok.length;
    filmTab.renderFlags(panes.film, flagState, slug);
  }

  // People who love this film (relative to their own taste) also love…
  async function fansAlsoLove(result, rand) {
    const sample = result.raters.filter((r) => r.source === 'sample' && r.n >= 50);
    const fans = sample.filter((r) => r.pct >= 0.9 && r.rating >= 4).sort((a, b) => b.pct - a.pct).slice(0, 25);
    const ctrl = pick(sample.filter((r) => r.pct >= 0.2 && r.pct <= 0.6), 25, rand);
    const state = { status: 'loading', total: fans.length + ctrl.length, fans: fans.length };
    if (fans.length < 5) { state.status = 'done'; filmTab.renderAlsoLoved(panes.film, state, filmName); return; }
    filmTab.renderAlsoLoved(panes.film, state, filmName);
    const tops = await Promise.all([...fans, ...ctrl].map((r) => lb.getUserTopRated(r.user).catch(() => [])));
    state.items = stats.alsoLoved(tops.slice(0, fans.length), tops.slice(fans.length), {
      minFans: Math.max(2, Math.ceil(fans.length * 0.2)),
      exclude: [slug],
    });
    state.status = 'done';
    ctx.alsoLoved = state.items;
    filmTab.renderAlsoLoved(panes.film, state, filmName);
  }

  // ---------- friends ----------

  const friends = { status: 'waiting', friends: [], rows: [], queued: 0, done: 0, mutuals: 0, batch: DEFAULTS.friendBatch, check: null };
  let friendList = null;

  async function loadFriendList() {
    if (friendList) return friendList;
    friendList = (async () => {
      const list = await lb.getFriends(me, settings.maxFriends).catch((e) => { console.warn('[lbxd-weighted] friends', e); return []; });
      return [{ user: me, name: 'You', isMe: true, mutual: false }, ...list.filter((f) => f.user !== me)];
    })();
    return friendList;
  }

  async function startFriends() {
    if (!me) { friends.status = 'need-user'; friendsTab.render(panes.friends, friends, slug); return; }
    const people = await loadFriendList();
    friends.friends = people;
    friends.mutuals = people.filter((p) => p.mutual).length;
    friends.batch = settings.friendBatch;
    await predictFriends();
  }

  async function predictFriends() {
    if (friends.status === 'loading') return;
    const next = friends.friends.slice(friends.queued, friends.queued + friends.batch);
    if (!next.length) return;
    friends.status = 'loading';
    friends.queued += next.length;
    friendsTab.render(panes.friends, friends, slug);

    let lastPaint = friends.done;
    const myRated = new Map();
    let myBase = null;
    await Promise.all(next.map(async (p) => {
      const row = { ...p };
      try {
        const [seen, profile, facets] = await Promise.all([
          lb.getUserFilmRating(p.user, slug),
          lb.getProfile(p.user, settings.profileTtlDays),
          lb.getUserFacetRatings(p.user, ctx.facets, { excludeSlug: slug, similar: ctx.similar, lean: true }).catch(() => []),
        ]);
        row.seen = seen.seen;
        row.actual = seen.seen ? seen.rating : null;
        row.rated = new Map(facets.flatMap((f) => f.films.map((x) => [x.slug, x.rating])));
        if (profile) {
          // Predict as if unseen: their rating of this film is removed from every input.
          const counts = row.actual != null ? stats.leaveOneOut(profile.counts, row.actual) : profile.counts;
          row.base = stats.personBaseline(counts, ctx.ref);
          row.pred = stats.predictRating(counts, { facets, crowdZ: ctx.meanZ, ref: ctx.ref });
        }
      } catch (e) {
        console.warn('[lbxd-weighted] friend', p.user, e);
      }
      friends.rows.push(row);
      friends.done++;
      if (friends.done - lastPaint >= 8) { lastPaint = friends.done; friendsTab.render(panes.friends, friends, slug); }
    }));

    // Taste match with you, on films you've both rated within these facets.
    const mine = friends.rows.find((r) => r.isMe);
    if (mine?.rated && mine.base) {
      mine.rated.forEach((v, k) => myRated.set(k, v));
      myBase = mine.base;
      friends.rows.forEach((r) => { if (!r.isMe && r.rated && r.base) r.match = stats.tasteMatch(myRated, myBase, r.rated, r.base); });
    }

    const checked = friends.rows.filter((r) => r.seen && r.actual != null && r.pred);
    friends.check = checked.length ? {
      n: checked.length,
      mae: checked.reduce((a, r) => a + Math.abs(r.pred.rating - r.actual), 0) / checked.length,
      baseline: checked.reduce((a, r) => a + Math.abs(r.pred.mean - r.actual), 0) / checked.length,
    } : null;
    friends.status = 'done';
    friendsTab.render(panes.friends, friends, slug);
  }

  // ---------- for a friend ----------

  const forYou = { status: 'idle', people: null, selected: null, result: null, done: 0, total: 0 };

  async function ensureForYou() {
    if (!me) { forYou.status = 'need-user'; forYouTab.render(panes.foryou, forYou); return; }
    if (forYou.people) return forYouTab.render(panes.foryou, forYou);
    forYouTab.render(panes.foryou, forYou);
    forYou.people = await loadFriendList();
    forYou.selected = forYou.people.find((p) => p.mutual)?.user || forYou.people[1]?.user || me;
    forYouTab.render(panes.foryou, forYou);
  }

  async function runForYou() {
    if (forYou.status === 'loading' || !forYou.selected) return;
    forYou.status = 'loading';
    forYou.done = 0;
    forYou.total = 1;
    forYouTab.render(panes.foryou, forYou);
    let last = 0;
    try {
      forYou.result = await recommend.recommendFor(forYou.selected, {
        me,
        ctx,
        onProgress: (d, t) => {
          forYou.done = d; forYou.total = t;
          if (d - last >= 5 || d === t) { last = d; forYouTab.render(panes.foryou, forYou); }
        },
      });
      forYou.status = 'done';
    } catch (e) {
      console.error('[lbxd-weighted] recommend', e);
      forYou.status = 'error';
      forYou.error = e.message;
    }
    forYouTab.render(panes.foryou, forYou);
  }

  // ---------- mount ----------

  (async () => {
    const anchor = await waitFor(['.film-recent-reviews', '#film-page-wrapper .col-17', '.ratings-histogram-chart']);
    if (!anchor) return;
    if (anchor.matches('.film-recent-reviews')) anchor.before(panel);
    else if (anchor.matches('.col-17')) anchor.append(panel);
    else anchor.after(panel);

    const [stored, local] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS).catch(() => DEFAULTS),
      chrome.storage.local.get(['ui:collapsed', 'ui:tab']).catch(() => ({})),
    ]);
    settings = { ...DEFAULTS, ...stored };
    me = (settings.username || '').trim().toLowerCase() || lb.detectUsername(document);
    friendsTab.render(panes.friends, me ? friends : { status: 'need-user' }, slug);
    if (local['ui:collapsed']) panel.querySelector('[data-act="toggle"]').click();
    if (local['ui:tab'] && panes[local['ui:tab']]) showTab(local['ui:tab']);
    if (settings.autoRun) run(false);
  })();
})();
