const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/lib/stats.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test('histSummary mean/sd', () => {
  const c = [0, 0, 0, 0, 0, 0, 0, 2, 0, 2]; // two 4s, two 5s
  const r = s.histSummary(c);
  assert.equal(r.n, 4);
  close(r.mean, 4.5);
  close(r.sd, 0.5);
});

test('percentileOf uses mid-rank', () => {
  const c = [0, 0, 0, 0, 0, 10, 0, 0, 0, 10]; // 3s and 5s
  close(s.percentileOf(c, 3), 0.25);
  close(s.percentileOf(c, 5), 0.75);
  close(s.percentileOf(c, 4), 0.5);
});

test('leaveOneOut removes the judged rating', () => {
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  assert.deepEqual(s.leaveOneOut(c, 5), new Array(10).fill(0));
});

test('harsh rater giving 5 stars scores a large positive z', () => {
  const harsh = [20, 40, 60, 80, 60, 30, 10, 4, 1, 1]; // mostly 1-2.5 stars
  const b = s.raterBaseline(harsh, 5, { mean: 3.3, sd: 1 });
  assert.ok(b.z > 2.5, `z=${b.z}`);
  assert.ok(b.pct > 0.99);
});

test('thin accounts are shrunk toward the reference', () => {
  const thin = [0, 0, 0, 0, 0, 0, 0, 0, 0, 3]; // three 5s, judging a 5 -> two remain
  const b = s.raterBaseline(thin, 0.5, { mean: 3.3, sd: 1 });
  assert.ok(b.mean < 3.6, `mean=${b.mean}`);
  assert.ok(Math.abs(b.z) < 4, `z=${b.z}`);
});

test('activityWeight grows and caps at 1', () => {
  assert.equal(s.activityWeight(0), 0);
  assert.ok(s.activityWeight(10) < s.activityWeight(100));
  assert.equal(s.activityWeight(5000), 1);
});

test('allocateSample is proportional with a floor', () => {
  const a = s.allocateSample([1, 0, 0, 0, 0, 0, 0, 0, 0, 999], 100);
  assert.equal(a[0], 1); // capped by availability
  assert.equal(a[1], 0);
  assert.equal(a[9], 100);
  const b = s.allocateSample([100, 0, 0, 0, 0, 0, 0, 0, 0, 9900], 100);
  assert.equal(b[0], 4);
});

test('bimodality flags a split crowd', () => {
  const split = [50, 0, 0, 0, 0, 0, 0, 0, 0, 50];
  const unimodal = [0, 0, 5, 20, 50, 80, 50, 20, 5, 0];
  assert.ok(s.bimodality(split) > 0.555);
  assert.ok(s.bimodality(unimodal) < 0.555);
});

test('analyse: generous-crowd film scores below raw once normalised', () => {
  const generous = [0, 0, 0, 0, 1, 5, 20, 60, 60, 40]; // avg ~4.1
  const film = [0, 0, 0, 0, 0, 0, 0, 0, 0, 100];
  const raters = Array.from({ length: 20 }, (_, i) => ({ user: 'u' + i, rating: 4, counts: generous, weight: 5, source: 'sample' }));
  const r = s.analyse(film, raters);
  assert.ok(r.meanDelta < 0);
  assert.equal(r.sampleSize, 20);
  assert.equal(r.flagged.length, 0);
});

test('analyse flags out-of-character ratings once per user', () => {
  const harsh = [20, 40, 60, 80, 60, 30, 10, 4, 1, 1];
  const raters = [
    { user: 'grump', rating: 5, counts: harsh, weight: 1, source: 'sample' },
    { user: 'grump', rating: 5, counts: harsh, weight: 0, source: 'review', link: '/grump/film/x/' },
  ];
  const r = s.analyse([0, 0, 0, 0, 0, 0, 0, 0, 0, 10], raters);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].user, 'grump');
  assert.ok(r.flagged[0].contrarian === false);
});

test('predictRating: crowd loves it relative to norms -> above friend average', () => {
  const friend = [2, 4, 8, 15, 25, 40, 40, 30, 15, 6]; // avg ~3.3
  const p = s.predictRating(friend, { crowdZ: 1.0, ref: { mean: 3.3, sd: 1 } });
  assert.ok(p.rating > p.mean + 0.5, `${p.rating} vs ${p.mean}`);
  assert.ok(p.pct > 0.7);
});

test('predictRating: genre affinity moves the prediction', () => {
  const friend = [2, 4, 8, 15, 25, 40, 40, 30, 15, 6];
  const ref = { mean: 3.3, sd: 1 };
  const base = s.predictRating(friend, { crowdZ: 0, ref });
  const fan = s.predictRating(friend, { genreRatings: Array(30).fill(4.5), crowdZ: 0, ref });
  const hater = s.predictRating(friend, { genreRatings: Array(30).fill(1.5), crowdZ: 0, ref });
  assert.ok(fan.rating > base.rating + 0.5);
  assert.ok(hater.rating < base.rating - 0.5);
  assert.equal(fan.confidence, 'medium'); // 185 ratings < 200
  assert.equal(s.predictRating(friend.map((c) => c * 2), { genreRatings: Array(30).fill(4.5), crowdZ: 0, ref }).confidence, 'high');
});

test('predictRating: few genre films barely move it, and output is clamped', () => {
  const friend = [0, 0, 0, 0, 0, 0, 0, 5, 20, 80];
  const ref = { mean: 3.3, sd: 1 };
  const a = s.predictRating(friend, { crowdZ: 0, ref });
  const b = s.predictRating(friend, { genreRatings: [0.5], crowdZ: 0, ref });
  assert.ok(Math.abs(a.rating - b.rating) < 0.4);
  assert.ok(s.predictRating(friend, { crowdZ: 5, ref }).rating <= 5);
  assert.equal(s.predictRating(friend, { crowdZ: NaN, ref }), null);
});

test('predictRating: similar-film ratings outweigh genre', () => {
  const friend = [4, 8, 16, 30, 50, 80, 80, 60, 30, 12];
  const ref = { mean: 3.3, sd: 1 };
  const p = s.predictRating(friend, { genreRatings: Array(20).fill(2), similarRatings: [5, 5, 4.5], crowdZ: 0, ref });
  assert.ok(p.rating > p.mean, `${p.rating} vs ${p.mean}`);
});

test('tasteMatch: aligned vs opposed tastes', () => {
  const base = { mean: 3, sd: 1 };
  const films = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const A = new Map(films.map((f, i) => [f, 1 + (i % 5)]));
  const same = new Map(films.map((f, i) => [f, 1 + (i % 5)]));
  const opp = new Map(films.map((f, i) => [f, 5 - (i % 5)]));
  assert.ok(s.tasteMatch(A, base, same, base).r > 0.45);
  assert.ok(s.tasteMatch(A, base, opp, base).r < -0.45);
  assert.equal(s.tasteMatch(A, base, new Map([['a', 3]]), base).r, 0);
});

test('crowdZFromAverage is centred near 3.6', () => {
  assert.ok(Math.abs(s.crowdZFromAverage(3.61)) < 1e-9);
  assert.ok(s.crowdZFromAverage(4.5) > 0.8);
});

test('segments splits harsh vs generous raters', () => {
  const mk = (rawMean, n, rating) => ({ source: 'sample', n, rawMean, rating, delta: rating - rawMean, weight: 1 });
  const seg = s.segments([mk(2.5, 50, 4), mk(2.6, 60, 4), mk(2.7, 70, 4), mk(4, 2000, 5), mk(4.1, 1500, 5), mk(4.2, 1200, 5)]);
  assert.equal(seg.find((x) => x.label.startsWith('Harsh')).mean, 4);
  assert.equal(seg.find((x) => x.label.startsWith('Cinephiles')).n, 3);
});

test('predictRating: facets combine and report their contributions', () => {
  const friend = [4, 8, 16, 30, 50, 80, 80, 60, 30, 12];
  const ref = { mean: 3.3, sd: 1 };
  const p = s.predictRating(friend, {
    crowdZ: 0, ref,
    facets: [
      { type: 'director', label: 'Celine Song', ratings: [5, 5] },
      { type: 'language', label: 'Korean', ratings: [4.5, 4, 4.5, 5, 4] },
      { type: 'decade', label: '2020s', ratings: Array(40).fill(3) },
    ],
  });
  assert.equal(p.parts[0].type, 'director');
  assert.ok(p.parts[0].contribution > 0);
  assert.ok(p.rating > p.mean + 0.4);
});

test('alsoLoved surfaces films over-represented among fans', () => {
  const godfather = { slug: 'godfather', name: 'The Godfather', rating: 5 };
  const niche = { slug: 'before-sunrise', name: 'Before Sunrise', rating: 5 };
  const fans = Array.from({ length: 10 }, (_, i) => (i < 6 ? [godfather, niche] : [godfather]));
  const ctrl = Array.from({ length: 10 }, () => [godfather]);
  const out = s.alsoLoved(fans, ctrl);
  assert.equal(out[0].slug, 'before-sunrise');
  assert.ok(out[0].lift > 3);
});
