// Recommendations for one person: gather candidates from several "people who
// like X like Y" sources, then score each against that person's taste facets.
(function (root) {
  const LBW = root.LBW;
  const { stats, lb } = LBW;

  const SOURCE_PRIOR = { loved: 1, you: 0.6, fans: 0.9, similarThis: 0.7, thisFilm: 1.2, disliked: 1 };
  const DEFAULT_REF = { mean: 3.35, sd: 0.95 };

  const ratedMap = (lists) => {
    const m = new Map();
    lists.flat().forEach((f) => { if (f.rating != null) m.set(f.slug, f.rating); });
    return m;
  };

  // ctx: { slug, filmName, similar, alsoLoved, meanZ, ref }
  async function recommendFor(target, { me, ctx, onProgress = () => {} }) {
    const ref = ctx.ref || DEFAULT_REF;
    let done = 0, total = 1;
    const tick = (n = 1) => { done += n; onProgress(done, total); };
    const grow = (n) => { total += n; onProgress(done, total); };

    // 1. Who they are: histogram, broad genre/decade profile, favourites, least favourites.
    grow(33);
    const [profile, broad, top, bottom] = await Promise.all([
      lb.getProfile(target, 14).finally(() => tick()),
      lb.getUserBroadProfile(target, () => tick()),
      lb.getUserTopRated(target).catch(() => []).finally(() => tick()),
      lb.getUserBottomRated(target).catch(() => []).finally(() => tick()),
    ]);
    if (!profile) throw new Error(`Couldn't read ${target}'s ratings (private or no ratings?)`);
    const base = stats.personBaseline(profile.counts, ref);
    const seen = new Set([...Object.values(broad).flat().map((f) => f.slug), ...top.map((f) => f.slug), ...bottom.map((f) => f.slug)]);

    // Taste fingerprint from the broad profile.
    const genreLists = {}, decadeLists = {};
    Object.entries(broad).forEach(([path, films]) => {
      const ratings = films.filter((f) => f.rating != null).map((f) => f.rating);
      const [kind, key] = path.split('/');
      (kind === 'genre' ? genreLists : decadeLists)[key] = ratings;
    });
    const genresFp = stats.tasteFingerprint(genreLists, base);
    const decadesFp = stats.tasteFingerprint(decadeLists, base, 10);

    // 2. Taste match with you (on everything both profiles contain).
    let match = null, mine = null;
    if (me && me !== target) {
      grow(32);
      const [myProfile, myBroad, myTop] = await Promise.all([
        lb.getProfile(me, 14).finally(() => tick()),
        lb.getUserBroadProfile(me, () => tick()),
        lb.getUserTopRated(me).catch(() => []).finally(() => tick()),
      ]);
      if (myProfile) {
        const myBase = stats.personBaseline(myProfile.counts, ref);
        match = stats.tasteMatch(ratedMap([...Object.values(myBroad), myTop]), myBase, ratedMap([...Object.values(broad), top]), base);
        mine = myTop;
      }
    }

    // 3. Candidates.
    const cands = new Map();
    const add = (slug, name, source) => {
      if (!slug || seen.has(slug)) return;
      const c = cands.get(slug) || { slug, name, sources: [] };
      if (!c.sources.some((s) => s.type === source.type && s.label === source.label)) c.sources.push(source);
      cands.set(slug, c);
    };
    const favourites = top.filter((f) => f.rating >= 4.5).slice(0, 6);
    grow(favourites.length);
    const sims = await Promise.all(favourites.map((f) => lb.getSimilar(f.slug, 15).catch(() => []).finally(() => tick())));
    favourites.forEach((f, i) => sims[i].forEach((s) => add(s.slug, s.name, { type: 'loved', label: f.name })));
    (mine || []).filter((f) => f.rating >= 4.5).slice(0, 30).forEach((f) => add(f.slug, f.name, { type: 'you', label: f.name, rating: f.rating }));
    add(ctx.slug, ctx.filmName, { type: 'thisFilm', label: ctx.filmName });
    (ctx.similar || []).slice(0, 12).forEach((s) => add(s.slug, s.name, { type: 'similarThis', label: ctx.filmName }));
    (ctx.alsoLoved || []).slice(0, 10).forEach((s) => add(s.slug, s.name, { type: 'fans', label: ctx.filmName }));

    // Negative candidates: films like the ones they rated lowest.
    const pct = (r) => stats.percentileOf(profile.counts, r);
    const dislikes = bottom.filter((f) => f.rating <= 2.5 && pct(f.rating) <= 0.15).slice(0, 5);
    grow(dislikes.length);
    const badSims = await Promise.all(dislikes.map((f) => lb.getSimilar(f.slug, 12).catch(() => []).finally(() => tick())));
    dislikes.forEach((f, i) => badSims[i].forEach((s) => add(s.slug, s.name, { type: 'disliked', label: f.name, rating: f.rating })));

    const prelim = (c) => c.sources.reduce((s, src) => s + (SOURCE_PRIOR[src.type] || 0.5) + (src.type === 'you' && match ? Math.max(0, match.r) : 0), 0);
    const ranked = [...cands.values()].sort((a, b) => prelim(b) - prelim(a));
    const positive = ranked.filter((c) => c.sources.some((s) => s.type !== 'disliked')).slice(0, 30);
    const negative = ranked.filter((c) => c.sources.some((s) => s.type === 'disliked') && !positive.includes(c)).slice(0, 15);
    const pool = [...positive, ...negative];

    // 4. Film details, then a cheap score from the broad profile.
    grow(pool.length);
    await Promise.all(pool.map(async (c) => {
      c.info = await lb.getFilmInfo(c.slug).catch(() => null);
      tick();
    }));
    const boostOf = (c) => {
      const loved = c.sources.filter((s) => s.type === 'loved').length;
      const disliked = c.sources.filter((s) => s.type === 'disliked').length;
      let b = Math.min(0.3, 0.12 * loved) - Math.min(0.3, 0.12 * disliked);
      // Your love counts for them in proportion to taste match — against them if your tastes clash.
      if (c.sources.some((s) => s.type === 'you') && match) b += 0.35 * match.r;
      if (c.sources.some((s) => s.type === 'fans')) b += 0.1;
      return b;
    };
    const broadFacets = (info) => info.facets
      .filter((f) => f.type === 'genre' || f.type === 'decade')
      .map((f) => {
        const films = (broad[f.path] || []).filter((x) => x.rating != null && x.slug !== info.slug);
        return { ...f, ratings: films.map((x) => x.rating), films };
      });
    const score = (c, extra = []) => {
      const crowdZ = c.slug === ctx.slug && Number.isFinite(ctx.meanZ) ? ctx.meanZ : stats.crowdZFromAverage(c.info.avg);
      c.pred = stats.predictRating(profile.counts, { facets: [...broadFacets(c.info), ...extra], crowdZ, ref, boost: boostOf(c) });
    };
    const scored = pool.filter((c) => c.info && Number.isFinite(c.info.avg));
    scored.forEach((c) => score(c));
    scored.sort((a, b) => b.pred.pct - a.pred.pct || b.pred.rating - a.pred.rating);

    // 5. Refine the contenders for each list with specific facets + a definite seen check:
    //    best overall, furthest above the Letterboxd average, and likeliest to disappoint.
    const aboveAvg = (c) => c.pred.rating - c.info.avg;
    const finalists = [...new Set([
      ...scored.slice(0, 18),
      ...scored.slice().sort((a, b) => aboveAvg(b) - aboveAvg(a)).slice(0, 10),
      ...scored.slice(-12),
    ])];
    grow(finalists.length * 2);
    await Promise.all(finalists.map(async (c) => {
      const specific = c.info.facets.filter((f) => ['director', 'theme', 'language'].includes(f.type) || (f.type === 'actor' && f === c.info.facets.find((x) => x.type === 'actor')));
      const [extra, rated] = await Promise.all([
        lb.getUserFacetRatings(target, specific, { excludeSlug: c.slug, lean: true }).catch(() => []).finally(() => tick()),
        lb.getUserFilmRating(target, c.slug).catch(() => ({ seen: false })).finally(() => tick()),
      ]);
      c.seen = rated.seen;
      if (!c.seen) score(c, extra);
    }));

    const unseen = finalists.filter((c) => !c.seen && c.pred);
    unseen.forEach((c) => { c.aboveAvg = aboveAvg(c); });
    const items = unseen.slice().sort((a, b) => b.pred.pct - a.pred.pct || b.pred.rating - a.pred.rating).filter((c) => c.pred.pct >= 0.5);
    const gems = unseen.filter((c) => c.aboveAvg >= 0.25).sort((a, b) => b.aboveAvg - a.aboveAvg);
    // Warnings: low for them AND below the consensus, most-tempting (furthest below the crowd) first.
    const avoid = unseen.filter((c) => c.pred.pct <= 0.4 && c.aboveAvg < 0).sort((a, b) => a.aboveAvg - b.aboveAvg || a.pred.pct - b.pred.pct);

    return {
      target,
      profile: { n: base.n, mean: base.rawMean },
      genres: genresFp,
      decades: decadesFp,
      match,
      items,
      gems,
      avoid,
    };
  }

  LBW.recommend = { recommendFor };
})(globalThis);
