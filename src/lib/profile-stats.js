// Advanced stats for one member: their ratings read against the crowd and
// against what their own habits predict.
(function (root) {
  const LBW = root.LBW;
  const { stats, lb } = LBW;

  const MAX_FILMS = 200;

  // Recent rated films, in watch order (most recent first), plus their extremes.
  async function ratedSample(user, n, onStep) {
    const pages = Math.min(4, Math.max(1, Math.ceil(n / 72)));
    const lists = await Promise.all([
      ...Array.from({ length: pages }, (_, i) => lb.cached(`films:${user}:${i + 1}`, lb.DAY, async () =>
        lb.parseGridRatings(await lb.fetchDoc(`/${user}/films/${i ? `page/${i + 1}/` : ''}`))).catch(() => []).finally(onStep)),
      lb.getUserTopRated(user).catch(() => []).finally(onStep),
      lb.getUserBottomRated(user).catch(() => []).finally(onStep),
    ]);
    const recent = lists.slice(0, pages).flat();
    const out = new Map();
    recent.forEach((f, i) => out.set(f.slug, { ...f, order: i }));
    [...lists[pages], ...lists[pages + 1]].forEach((f) => { if (!out.has(f.slug)) out.set(f.slug, { ...f, order: null }); });
    return [...out.values()].slice(0, MAX_FILMS);
  }

  async function memberMeans() {
    try {
      const all = await chrome.storage.local.get(null);
      return Object.entries(all)
        .filter(([k, v]) => k.startsWith('user:') && v?.v?.counts)
        .map(([, v]) => stats.histSummary(v.v.counts))
        .filter((s) => s.n >= 50)
        .map((s) => s.mean);
    } catch (_) {
      return [];
    }
  }

  async function analyseMember(user, { me, onProgress = () => {} } = {}) {
    let done = 0, total = 3;
    const tick = () => { done++; onProgress(done, total); };
    const grow = (k) => { total += k; onProgress(done, total); };

    const profile = await lb.getProfile(user, 14);
    tick();
    if (!profile) throw new Error('No public ratings to analyse.');
    const counts = profile.counts;
    const summ = stats.histSummary(counts);
    const ref = stats.GLOBAL_REF;

    grow(Math.min(4, Math.ceil(summ.n / 72)) + 2 + 30);
    const [films, broad] = await Promise.all([
      ratedSample(user, summ.n, tick),
      lb.getUserBroadProfile(user, tick),
    ]);

    grow(films.length);
    const hists = await Promise.all(films.map((f) => lb.getFilmHistogram(f.slug).catch(() => null).finally(tick)));

    // Expected rating: their own norm, shifted by how far the crowd rates the film above its raters' norms.
    const rows = films.map((f, i) => {
      const h = hists[i];
      if (!h?.counts || !Number.isFinite(h.weightedAverage)) return null;
      const base = stats.personBaseline(stats.leaveOneOut(counts, f.rating), ref);
      const crowdZ = stats.crowdZFromAverage(h.weightedAverage);
      const expected = Math.min(5, Math.max(0.5, base.mean + base.sd * crowdZ));
      const votes = h.counts.reduce((a, b) => a + b, 0);
      return { ...f, avg: h.weightedAverage, votes, expected, resid: f.rating - expected, vsCrowd: f.rating - h.weightedAverage };
    }).filter(Boolean);

    const fitCrowd = stats.linearFit(rows.map((r) => r.avg), rows.map((r) => r.rating));
    const fitExp = stats.linearFit(rows.map((r) => r.expected), rows.map((r) => r.rating));
    const mae = rows.reduce((a, r) => a + Math.abs(r.resid), 0) / (rows.length || 1);
    const offByOne = rows.filter((r) => Math.abs(r.resid) >= 1).length / (rows.length || 1);
    const generosity = rows.reduce((a, r) => a + r.vsCrowd, 0) / (rows.length || 1);
    const votesSorted = rows.map((r) => r.votes).sort((a, b) => a - b);
    const medianVotes = votesSorted[Math.floor(votesSorted.length / 2)] || 0;
    const obscureShare = rows.filter((r) => r.votes < 10000).length / (rows.length || 1);
    const acclaimedShare = rows.filter((r) => r.avg >= 4).length / (rows.length || 1);
    const meanAvg = rows.reduce((a, r) => a + r.avg, 0) / (rows.length || 1);

    // Drift: residual by chronological quartile of the recent sample (oldest → newest).
    const chrono = rows.filter((r) => r.order != null).sort((a, b) => b.order - a.order);
    const q = 4;
    const drift = Array.from({ length: q }, (_, i) => {
      const part = chrono.slice(Math.floor((i * chrono.length) / q), Math.floor(((i + 1) * chrono.length) / q));
      return {
        label: ['Oldest', 'Older', 'Newer', 'Newest'][i],
        n: part.length,
        resid: part.length ? part.reduce((a, r) => a + r.resid, 0) / part.length : NaN,
        rating: part.length ? part.reduce((a, r) => a + r.rating, 0) / part.length : NaN,
      };
    });

    // Rating-scale habits.
    const half = counts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (summ.n || 1);
    const fives = counts[9] / (summ.n || 1);
    const lows = (counts[0] + counts[1]) / (summ.n || 1);

    // Harshness vs members cached so far.
    const means = await memberMeans();
    const harsherThan = means.length >= 30 ? means.filter((m) => m > summ.mean).length / means.length : NaN;

    // Fingerprints.
    const base = stats.personBaseline(counts, ref);
    const genreLists = {}, decadeLists = {};
    Object.entries(broad).forEach(([path, list]) => {
      const [kind, key] = path.split('/');
      (kind === 'genre' ? genreLists : decadeLists)[key] = list.filter((f) => f.rating != null).map((f) => f.rating);
    });

    // Taste match with the viewer.
    let match = null;
    if (me && me !== user) {
      grow(32);
      const [myProfile, myBroad, myTop] = await Promise.all([
        lb.getProfile(me, 14).finally(tick),
        lb.getUserBroadProfile(me, tick),
        lb.getUserTopRated(me).catch(() => []).finally(tick),
      ]);
      if (myProfile) {
        const myBase = stats.personBaseline(myProfile.counts, ref);
        const mine = new Map(), theirs = new Map(), names = new Map();
        [...Object.values(myBroad).flat(), ...myTop].forEach((f) => { if (f.rating != null) { mine.set(f.slug, f.rating); names.set(f.slug, f.name); } });
        [...Object.values(broad).flat(), ...rows].forEach((f) => { if (f.rating != null) { theirs.set(f.slug, f.rating); names.set(f.slug, f.name); } });
        const tm = stats.tasteMatch(mine, myBase, theirs, base);
        const shared = [...mine.keys()].filter((k) => theirs.has(k)).map((slug) => ({
          slug, name: names.get(slug), mine: mine.get(slug), theirs: theirs.get(slug),
          gap: (theirs.get(slug) - base.mean) / base.sd - (mine.get(slug) - myBase.mean) / myBase.sd,
        }));
        match = {
          ...tm,
          agree: shared.filter((s) => s.mine >= 4 && s.theirs >= 4).sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap)).slice(0, 5),
          clash: shared.slice().sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 5),
        };
      }
    }

    return {
      user,
      name: profile.name,
      summary: { ...summ, median: stats.median(counts), levels: stats.levelsUsed(counts), half, fives, lows, harsherThan, memberPool: means.length },
      counts,
      rows,
      crowd: { fit: fitCrowd, generosity, meanAvg, medianVotes, obscureShare, acclaimedShare },
      model: { fit: fitExp, mae, offByOne },
      drift,
      hotTakes: {
        loved: rows.filter((r) => r.resid > 0).sort((a, b) => b.resid - a.resid).slice(0, 6),
        hated: rows.filter((r) => r.resid < 0).sort((a, b) => a.resid - b.resid).slice(0, 6),
      },
      genres: stats.tasteFingerprint(genreLists, base),
      decades: stats.tasteFingerprint(decadeLists, base, 10),
      match,
      at: Date.now(),
    };
  }

  LBW.profileStats = { analyseMember };
})(globalThis);
