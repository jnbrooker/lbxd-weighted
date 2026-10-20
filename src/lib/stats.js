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
    const ref = pooledReference(raters.map((r) => r.counts));

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
      favouriteShare,
      dislikeShare,
      lowActivityShare,
      sampleSize: sample.length,
      raters: enriched,
      flagged,
    };
  }

  // Predict how a specific person would rate this film.
  //   counts       their rating histogram (this film's rating already removed if they rated it)
  //   genreRatings their ratings of other films sharing this film's genres
  //   crowdZ       how far above their own norms the sampled crowd rates this film (analyse().meanZ)
  //   ref          pooled reference { mean, sd }
  // Model: z_hat = crowdZ + GENRE_WEIGHT * shrunk(genre affinity); rating = mu + sigma * z_hat.
  const GENRE_WEIGHT = 0.8;
  const GENRE_SHRINK = 8;
  function predictRating(counts, genreRatings, crowdZ, ref, k = 20) {
    const s = histSummary(counts);
    if (!s.n || !Number.isFinite(crowdZ)) return null;
    const mean = (s.n * s.mean + k * ref.mean) / (s.n + k);
    const sd = Math.max(0.35, Math.sqrt((s.n * s.sd ** 2 + k * ref.sd ** 2) / (s.n + k)));

    const gr = (genreRatings || []).filter(Number.isFinite);
    const rawAffinity = gr.length ? gr.reduce((a, r) => a + (r - mean) / sd, 0) / gr.length : 0;
    const affinity = rawAffinity * (gr.length / (gr.length + GENRE_SHRINK));

    const zHat = crowdZ + GENRE_WEIGHT * affinity;
    const rating = Math.min(5, Math.max(0.5, mean + sd * zHat));
    const rounded = Math.min(5, Math.max(0.5, Math.round(rating * 2) / 2));
    const confidence = s.n >= 200 && gr.length >= 15 ? 'high' : s.n >= 50 && gr.length >= 5 ? 'medium' : 'low';
    return {
      rating, rounded, mean: s.mean, n: s.n, sd, zHat, affinity, rawAffinity, genreN: gr.length,
      pct: percentileOf(counts, rounded), confidence,
    };
  }

  const api = {
    RATINGS, idxOf, histSummary, median, percentileOf, leaveOneOut, raterBaseline,
    pooledReference, activityWeight, weightedMean, allocateSample, bimodality, analyse, predictRating,
  };
  root.LBW = Object.assign(root.LBW || {}, { stats: api });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
