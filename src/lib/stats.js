// Pure statistics helpers. No DOM, no chrome.* — loadable in the content script
// (attaches to globalThis.LBW) and in Node for tests (module.exports).
(function (root) {
  const RATINGS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];
  const idxOf = (r) => Math.round(r * 2) - 1;

  // counts: length-10 array, index 0 = half-star ... index 9 = five stars.
  function histSummary(counts) {
    let n = 0, sum = 0, sq = 0;
    counts.forEach((c, i) => { n += c; sum += c * RATINGS[i]; sq += c * RATINGS[i] ** 2; });
    if (!n) return { n: 0, mean: NaN, sd: NaN };
    const mean = sum / n;
    const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
    return { n, mean, sd };
  }

  function median(counts) {
    const n = counts.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let i = 0; i < counts.length; i++) {
      acc += counts[i];
      if (acc >= n / 2) return RATINGS[i];
    }
    return NaN;
  }

  // Mid-rank percentile of rating r within a histogram (0..1).
  function percentileOf(counts, r) {
    const i = idxOf(r);
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) return NaN;
    let below = 0;
    for (let j = 0; j < i; j++) below += counts[j];
    return (below + counts[i] / 2) / n;
  }

  // Percentile of a continuous rating, interpolating between half-star mid-ranks.
  function percentileAt(counts, r) {
    const x = Math.min(5, Math.max(0.5, r));
    const lo = Math.floor(x * 2) / 2, hi = Math.min(5, lo + 0.5);
    const a = percentileOf(counts, lo), b = percentileOf(counts, hi);
    return hi === lo ? a : a + (b - a) * ((x - lo) / 0.5);
  }

  // Remove this film's own rating from the rater's histogram so their baseline
  // isn't contaminated by the rating we're judging (leave-one-out).
  function leaveOneOut(counts, r) {
    const c = counts.slice();
    const i = idxOf(r);
    if (c[i] > 0) c[i] -= 1;
    return c;
  }

  // Build a rater profile, shrinking mean/sd toward a reference for thin accounts
  // so a user with 12 ratings can't produce a z-score of 9.
  function raterBaseline(counts, rating, ref, k = 20) {
    const loo = leaveOneOut(counts, rating);
    const s = histSummary(loo);
    if (!s.n) return null;
    const mean = (s.n * s.mean + k * ref.mean) / (s.n + k);
    const variance = (s.n * s.sd ** 2 + k * ref.sd ** 2) / (s.n + k);
    const sd = Math.max(0.35, Math.sqrt(variance));
    return {
      n: s.n,
      rawMean: s.mean,
      rawSd: s.sd,
      mean,
      sd,
      z: (rating - mean) / sd,
      delta: rating - s.mean,
      pct: percentileOf(loo, rating),
    };
  }

  // Pool every sampled rater's histogram into one — a site-wide-ish reference.
  function pooledReference(histograms) {
    const pooled = new Array(10).fill(0);
    histograms.forEach((h) => h.forEach((c, i) => { pooled[i] += c; }));
    const s = histSummary(pooled);
    return s.n ? { mean: s.mean, sd: s.sd } : { mean: 3.3, sd: 1.0 };
  }

  // Down-weight new / barely-active accounts. Reaches full weight at `full` ratings.
  function activityWeight(n, full = 300) {
    if (!n || n < 1) return 0;
    return Math.min(1, Math.log1p(n) / Math.log1p(full));
  }

  function weightedMean(items, valueFn, weightFn) {
    let sw = 0, s = 0;
    for (const it of items) {
      const w = weightFn(it);
      const v = valueFn(it);
      if (!(w > 0) || !Number.isFinite(v)) continue;
      sw += w; s += w * v;
    }
    return sw ? s / sw : NaN;
  }

  // Proportional allocation of a sample budget across rating buckets, with a
  // floor so rare buckets (e.g. half-stars on a beloved film) still get looked at.
  function allocateSample(counts, budget, floor = 4) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (!total) return counts.map(() => 0);
    return counts.map((c) => (c ? Math.min(c, Math.max(floor, Math.round((budget * c) / total))) : 0));
  }

  // Sarle's bimodality coefficient from a histogram. > ~0.555 suggests a split crowd.
  function bimodality(counts) {
    const s = histSummary(counts);
    if (s.n < 4 || !s.sd) return NaN;
    let m3 = 0, m4 = 0;
    counts.forEach((c, i) => {
      const d = RATINGS[i] - s.mean;
      m3 += c * d ** 3; m4 += c * d ** 4;
    });
    m3 /= s.n; m4 /= s.n;
    const skew = m3 / s.sd ** 3;
    const kurt = m4 / s.sd ** 4 - 3;
    const n = s.n;
    return (skew ** 2 + 1) / (kurt + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)));
  }

  // Everything the dashboard shows, from the film histogram + sampled raters.
  // raters: [{ user, rating, counts, weight, source: 'sample'|'review', ... }]
  function analyse(filmCounts, raters, opts = {}) {
    const zThreshold = opts.zThreshold ?? 2;
    const film = histSummary(filmCounts);
    // opts.ref fixes the scale so scores are comparable across films.
    const ref = opts.ref || pooledReference(raters.map((r) => r.counts));

    const enriched = raters
      .map((r) => {
        const b = raterBaseline(r.counts, r.rating, ref);
        return b ? { ...r, ...b, activity: activityWeight(b.n) } : null;
      })
      .filter(Boolean);

    const sample = enriched.filter((r) => r.source === 'sample' && r.n >= 10);
    const w = (r) => r.weight;

    const activityWeighted = weightedMean(sample, (r) => r.rating, (r) => r.weight * r.activity);
    const meanDelta = weightedMean(sample, (r) => r.delta, w);
    const meanZ = weightedMean(sample, (r) => r.z, w);
    const meanPct = weightedMean(sample, (r) => r.pct, w);
    const favouriteShare = weightedMean(sample, (r) => (r.pct >= 0.9 ? 1 : 0), w);
    const dislikeShare = weightedMean(sample, (r) => (r.pct <= 0.1 ? 1 : 0), w);
    const normalised = ref.mean + meanZ * ref.sd;
    // Standard error of the weighted mean z (Kish effective sample size).
    const sw = sample.reduce((a, r) => a + r.weight, 0), sw2 = sample.reduce((a, r) => a + r.weight ** 2, 0);
    const nEff = sw2 ? (sw * sw) / sw2 : 0;
    const zVar = weightedMean(sample, (r) => (r.z - meanZ) ** 2, w);
    const zSe = nEff > 1 ? Math.sqrt(zVar / nEff) : NaN;
    const normalisedSe = zSe * ref.sd;
    const lowActivityShare = weightedMean(
      enriched.filter((r) => r.source === 'sample'),
      (r) => (r.n < 50 ? 1 : 0),
      w
    );

    const seen = new Set();
    const flagged = enriched
      .filter((r) => r.n >= 25 && Math.abs(r.z) >= zThreshold)
      .map((r) => ({ ...r, contrarian: Number.isFinite(film.mean) && Math.abs(r.rating - film.mean) >= 1.75 }))
      .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
      .filter((r) => (seen.has(r.user) ? false : seen.add(r.user)));

    return {
      film: { ...film, median: median(filmCounts), bimodality: bimodality(filmCounts) },
      ref,
      activityWeighted,
      meanDelta,
      meanZ,
      meanPct,
      normalised,
      normalisedSe,
      nEff,
      favouriteShare,
      dislikeShare,
      lowActivityShare,
      sampleSize: sample.length,
      raters: enriched,
      flagged,
    };
  }

  // Person-level baseline (shrunk toward ref for thin accounts), no rating to judge.
  function personBaseline(counts, ref, k = 20) {
    const s = histSummary(counts);
    if (!s.n) return null;
    return {
      n: s.n,
      rawMean: s.mean,
      mean: (s.n * s.mean + k * ref.mean) / (s.n + k),
      sd: Math.max(0.35, Math.sqrt((s.n * s.sd ** 2 + k * ref.sd ** 2) / (s.n + k))),
    };
  }

  // Mean z of a set of ratings against a baseline, shrunk toward 0 for small sets.
  function affinity(ratings, base, shrink) {
    const rs = (ratings || []).filter(Number.isFinite);
    if (!rs.length) return { raw: 0, shrunk: 0, n: 0 };
    const clampZ = (z) => Math.max(-3, Math.min(3, z)); // one outlier rating can't dominate
    const raw = rs.reduce((a, r) => a + clampZ((r - base.mean) / base.sd), 0) / rs.length;
    return { raw, shrunk: raw * (rs.length / (rs.length + shrink)), n: rs.length };
  }

  // When raters haven't been sampled, approximate the crowd's rater-normalised z
  // from the film's public average. Fitted on sampled films (Parasite 4.51 → +0.87,
  // The Room 2.58 → −1.00); a rough proxy, not a substitute for sampling.
  function crowdZFromAverage(avg) {
    return Number.isFinite(avg) ? 0.97 * (avg - 3.61) : 0;
  }

  // Taste facets: a person's ratings of films sharing something with the target
  // film. w = how much a full-confidence facet counts, k = shrinkage (films needed
  // for half confidence). Specific facets (similar films, director) beat broad ones.
  const FACETS = {
    similar: { w: 1.0, k: 3, label: 'similar films' },
    director: { w: 0.8, k: 2, label: 'director' },
    theme: { w: 0.6, k: 5, label: 'theme' },
    actor: { w: 0.35, k: 3, label: 'cast' },
    genre: { w: 0.5, k: 8, label: 'genre' },
    language: { w: 0.35, k: 6, label: 'language' },
    country: { w: 0.25, k: 8, label: 'country' },
    decade: { w: 0.2, k: 10, label: 'decade' },
  };
  // Fixed site-wide scale for comparing films (roughly the pooled mean/sd of
  // sampled raters across many films).
  const GLOBAL_REF = { mean: 3.35, sd: 1.0 };

  const TASTE_PRIOR = 0.5; // pseudo-weight pulling the combined taste signal toward 0

  // Predict how a specific person would rate a film.
  //   counts  their rating histogram (this film's rating already removed if they rated it)
  //   facets  [{ type, label, ratings: [numbers], films?: [{ name, rating }] }]
  //           (genreRatings / similarRatings are shorthand for one facet each)
  //   crowdZ  how far above their own norms the crowd rates the film
  //   boost   extra z from recommendation context (e.g. a taste-matched friend loved it)
  // Model: taste = Σ w·c·a / (Σ w·c + prior), where a = mean z on the facet and
  // c = n/(n+k); z_hat = crowdZ + taste + boost; rating = mu + sigma·z_hat.
  function predictRating(counts, { facets = [], genreRatings, similarRatings, crowdZ, ref, boost = 0 } = {}) {
    const base = personBaseline(counts, ref);
    if (!base || !Number.isFinite(crowdZ)) return null;
    const all = facets.slice();
    if (genreRatings) all.push({ type: 'genre', label: 'genre', ratings: genreRatings });
    if (similarRatings) all.push({ type: 'similar', label: 'similar films', ratings: similarRatings });

    let num = 0, den = TASTE_PRIOR, evidence = 0;
    const parts = all.map((f) => {
      const spec = FACETS[f.type] || FACETS.genre;
      const a = affinity(f.ratings, base, 0);
      const c = a.n / (a.n + spec.k);
      num += spec.w * c * a.raw;
      den += spec.w * c;
      evidence += a.n * spec.w;
      return { ...f, n: a.n, raw: a.raw, weight: spec.w * c };
    }).filter((p) => p.n > 0);
    const taste = num / den;
    parts.forEach((p) => { p.contribution = (p.weight * p.raw) / den; });
    parts.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));

    const zHat = crowdZ + taste + boost;
    const rating = Math.min(5, Math.max(0.5, base.mean + base.sd * zHat));
    const rounded = Math.min(5, Math.max(0.5, Math.round(rating * 2) / 2));
    const confidence = base.n >= 200 && evidence >= 12 ? 'high' : base.n >= 50 && evidence >= 4 ? 'medium' : 'low';
    const genre = parts.filter((p) => p.type === 'genre');
    const similar = parts.find((p) => p.type === 'similar');
    return {
      rating, rounded, mean: base.rawMean, baseMean: base.mean, n: base.n, sd: base.sd, zHat, crowdZ, boost, taste,
      parts, evidence,
      // summary fields kept for simple displays
      rawAffinity: genre.length ? genre.reduce((s, p) => s + p.raw * p.n, 0) / genre.reduce((s, p) => s + p.n, 0) : 0,
      genreN: genre.reduce((s, p) => s + p.n, 0),
      similarAffinity: similar ? similar.raw : 0,
      similarN: similar ? similar.n : 0,
      pct: percentileAt(counts, rating), confidence,
    };
  }

  // "People who love X also love Y": films over-represented among fans' favourites
  // compared with a control group. fans/controls: arrays of [{ slug, name, rating }].
  function alsoLoved(fanLists, controlLists, { minFans = 3, exclude = [] } = {}) {
    const skip = new Set(exclude);
    const count = (lists) => {
      const m = new Map();
      lists.forEach((films) => {
        new Set(films.filter((f) => f.rating >= 4.5).map((f) => f.slug)).forEach((s) => m.set(s, (m.get(s) || 0) + 1));
      });
      return m;
    };
    const names = new Map();
    fanLists.flat().forEach((f) => names.set(f.slug, f.name));
    const fans = count(fanLists), ctrl = count(controlLists);
    const F = Math.max(1, fanLists.length), C = Math.max(1, controlLists.length);
    return [...fans.entries()]
      .filter(([slug, n]) => n >= minFans && !skip.has(slug))
      .map(([slug, n]) => {
        const fanShare = n / F;
        const ctrlShare = ((ctrl.get(slug) || 0) + 0.5) / (C + 1);
        return { slug, name: names.get(slug) || slug, fans: n, fanShare, lift: fanShare / ctrlShare };
      })
      .sort((a, b) => b.lift * Math.sqrt(b.fans) - a.lift * Math.sqrt(a.fans));
  }

  // Taste match between two people: Pearson correlation of their z-scores on
  // films both have rated, shrunk toward 0 when the overlap is small.
  // a, b: Map(slug -> rating); baseA/baseB from personBaseline.
  function tasteMatch(a, baseA, b, baseB, shrink = 10) {
    const xs = [], ys = [];
    for (const [slug, ra] of a) {
      const rb = b.get(slug);
      if (rb == null) continue;
      xs.push((ra - baseA.mean) / baseA.sd);
      ys.push((rb - baseB.mean) / baseB.sd);
    }
    const n = xs.length;
    if (n < 3) return { r: 0, raw: NaN, n };
    const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    // Fall back to mean absolute agreement when someone has rated every overlap the same.
    const raw = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 1 - Math.min(1, xs.reduce((s, v, i) => s + Math.abs(v - ys[i]), 0) / n / 2);
    return { r: raw * (n / (n + shrink)), raw, n };
  }

  // Per-genre affinity, sorted strongest-like first.
  // genreLists: { genre: [ratings] }
  function tasteFingerprint(lists, base, shrink = 8) {
    return Object.entries(lists)
      .map(([key, ratings]) => ({ key, ...affinity(ratings, base, shrink) }))
      .filter((g) => g.n >= 3)
      .sort((x, y) => y.shrunk - x.shrunk);
  }

  // Who likes this film? Compare segments of the sampled raters.
  function segments(raters) {
    const sample = raters.filter((r) => r.source === 'sample' && r.n >= 10);
    const seg = (label, pred) => {
      const g = sample.filter(pred);
      return {
        label,
        n: g.length,
        mean: weightedMean(g, (r) => r.rating, (r) => r.weight),
        delta: weightedMean(g, (r) => r.delta, (r) => r.weight),
      };
    };
    return [
      seg('Harsh raters (avg < 3)', (r) => r.rawMean < 3),
      seg('Middle (3–3.75)', (r) => r.rawMean >= 3 && r.rawMean <= 3.75),
      seg('Generous (avg > 3.75)', (r) => r.rawMean > 3.75),
      seg('Casual (< 100 ratings)', (r) => r.n < 100),
      seg('Regulars (100–999)', (r) => r.n >= 100 && r.n < 1000),
      seg('Cinephiles (1000+)', (r) => r.n >= 1000),
    ].filter((s) => s.n >= 3);
  }

  // Pearson correlation and least-squares line y = a + b·x.
  function linearFit(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 3) return { r: NaN, slope: NaN, intercept: NaN, n };
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const slope = sxx ? sxy / sxx : NaN;
    return { r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN, slope, intercept: my - slope * mx, n };
  }

  // Shannon entropy of a histogram, as 'effective number of rating levels used'.
  function levelsUsed(counts) {
    const n = counts.reduce((a, b) => a + b, 0);
    if (!n) return 0;
    const h = counts.reduce((a, c) => (c ? a - (c / n) * Math.log(c / n) : a), 0);
    return Math.exp(h);
  }

  const api = {
    RATINGS, idxOf, histSummary, median, percentileOf, percentileAt, leaveOneOut, raterBaseline,
    pooledReference, activityWeight, weightedMean, allocateSample, bimodality, analyse,
    FACETS, GLOBAL_REF, personBaseline, affinity, crowdZFromAverage, predictRating, alsoLoved, linearFit, levelsUsed, tasteMatch, tasteFingerprint, segments,
  };
  root.LBW = Object.assign(root.LBW || {}, { stats: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
