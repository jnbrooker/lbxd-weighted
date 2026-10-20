# Letterboxd Weighted Stats

A Chrome extension that adds a dashboard to every Letterboxd film page
(`letterboxd.com/film/<slug>/`), just above Popular Reviews. It has three tabs.

It reads every rating against **the rater's own taste**. A 4★ from someone who averages 2.3
means more than a 4★ from someone who gives everything 4★. The same idea extends to genres, directors,
languages, themes and similar films.

## Film stats

| Metric | Meaning |
|---|---|
| **Letterboxd** | Letterboxd's own weighted average. Their formula isn't public. |
| **Raw mean** | Plain mean of the full rating histogram, plus the median. |
| **Activity-weighted** | Each rater counts by `log(ratings)`, reaching full weight at 300 ratings, so new or barely-used accounts count less. |
| **Normalised** | Each rating becomes a z-score against that rater's own history. The z-scores are averaged, then mapped back onto the pooled star scale. This corrects for harsh and generous raters. |
| **Vs their norm** | Average of (rating − the rater's personal average), in stars. |
| **Personal rank** | Average percentile of this film within each rater's own ratings. 50% means an ordinary film for them. |
| Top/bottom 10% | Share of raters for whom it's a personal top or bottom decile film. |
| Polarisation | Spread (sd) plus Sarle's bimodality coefficient: *Consensus / Typical / Mixed / Divisive*. |

- **Deviation beeswarm:** one dot per sampled rater, placed by how far their rating sits from their own
  average. Hover a dot for details.
- **Who likes it:** the film's average and average vs-norm score for harsh, middle and generous raters, and for
  casual users, regulars and cinephiles.
- **Fans also love:** "people who like X also like Y". Raters who put this film in their *personal*
  top 10% are compared with raters who found it ordinary. The films that turn up far more often among the
  fans' 4½–5★ ratings are listed, each with its lift (e.g. `6/15 fans · 3.4×`).
- **Loved it / Hated it, against type:** the most unusual raters get a full **taste profile**, and each
  one's expected rating comes from:
  - their ratings of other films by the same **director**
  - films with the same **themes**, **genres**, **lead cast**, **language**, **country** and **decade**
  - this film's **similar films**
  - how far above or below their norms the crowd rates it

  A rating is flagged when it misses that expectation by 1.75+ standard deviations. The chips show
  which facets drove the expectation, e.g. `Korean-language films +0.8σ · 14`. Hover a chip for example films.

## Friends

The tab covers your signed-in account (or a username set in options) and everyone you follow.
**Mutual follows come first.** People are checked in batches of 40, with a button to check more.

- **Your predicted rating**, plus "Recommend to" picks: friends likely to put it in their personal top 30%.
- **Haven't seen it:** a predicted rating from each person's taste facets (as above), where it would rank among
  their own ratings, your taste match with them, and the facets that pushed it up or down.
- **Already rated:** their actual rating next to what the model would have predicted, with that
  rating left out of every input.
- **Model check:** the average error on friends who've rated the film, compared with simply guessing each
  person's usual average.

## For a friend

Pick anyone you follow (or yourself) and get the films to recommend to them.

1. It builds their **taste fingerprint** across all genres and decades, and their **taste match** with you.
2. It gathers candidates from:
   - films similar to *their* 4½–5★ favourites ("because they loved Heat")
   - *your* favourites, weighted by how well your tastes match
   - this film and its similar films
   - this film's "fans also love" list
3. It scores each candidate against their genre, decade, director, theme, language and cast history plus
   the film's Letterboxd average. It double-checks they haven't seen it, then ranks by where it would land among
   *their own* ratings.

## Top films · weighted

A **Weighted** item next to Films / Lists / Members opens `letterboxd.com/films/#weighted`. It ranks
Letterboxd's highest-rated or most popular films (top 100, 250 or 500) by the rater-normalised score instead of raw stars.
Columns: personal rank, top-10% share, activity-weighted and Bayesian scores, plus each film's move vs the Letterboxd order.

A full run is slow (thousands of page loads), so it's built to be efficient:
1. **Instant pass:** one histogram per film gives a Bayesian ranking straight away,
   (v·R + m·C)/(v + m), with m = 20,000 and C = 3.3.
2. **Refinement:** a small stratified panel per film (20/40/80/150 raters), worked top-down. Rater profiles are
   shared across films, because top films share raters, and every film is scored on one fixed scale so the list is comparable.
   95% intervals are shown.
3. **Resumable:** results are saved for 7 days, so you can pause, close the tab and continue later. Full
   300-rater results from film pages you've visited are reused.

## Member profiles

Every profile (`/<username>/`) gets an **Advanced stats** panel. It reads about 200 of that member's
rated films and each film's histogram:
- **Expected vs actual** scatter. The expected rating is their own norm, shifted by how the crowd rates the film.
  The chart shows the y = x line and their trend line.
- Their rating spread vs Letterboxd averages on the same films.
- **Crowd agreement:** correlation, and a slope that shows whether they amplify or compress the crowd.
- **Predictability:** error vs expectation.
- **Generosity** vs the crowd.
- **Mainstream:** median rating count of the films they rate, and their share of obscure films.
- **Acclaim taste:** the average Letterboxd rating of the films they choose.
- **Scale use:** effective rating levels, half-stars, 5★ share.
- **Harshness** percentile among members the extension has cached.
- Genre and decade fingerprints.
- **Drift** vs expectation over time.
- **Hot takes** in both directions.
- Taste match with you, plus the films you both love and the ones you clash on most.

## How the numbers are produced

1. The film's histogram comes from `/csi/film/<slug>/rating-histogram/`.
2. A **stratified sample** of raters (default 300) is spread across the ten star buckets in proportion
   to the histogram, with at least 4 per bucket, picked at random from
   `/film/<slug>/ratings/rated/<n>/`. Each sampled rater is weighted back to their bucket's true size.
3. Raters behind the top popular reviews are added for flags only.
4. Each rater's personal histogram comes from their profile, with **this film's rating removed**
   (leave-one-out). Thin accounts are shrunk toward the pooled average.
5. Taste facets come from per-user filtered film lists, e.g. `/<user>/films/with/director/<slug>/`,
   `/<user>/films/language/korean/` and `/<user>/films/theme/<theme>/`. Each facet's pull is the
   mean z of their ratings there, weighted by how specific the facet is (similar films > director >
   theme > genre > language > country > decade) and shrunk by the number of films behind it.

Requests are same-origin, at most 6 in flight and about 8 per second. On HTTP 429 they slow down for every request, not just the one that failed. Results are cached in
`chrome.storage.local`: profiles for 14 days, facet lists and film details for 7 days, bucket lists
for 2 days. The sample is seeded per film, so revisits reuse the cache. **Resample** draws a fresh sample.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, then turn on **Developer mode**.
3. Click **Load unpacked** and choose the repo folder.
4. Open any film page, e.g. <https://letterboxd.com/film/past-lives/>.

Click the toolbar icon to open the options: sample size, flag threshold, review pages, username,
batch size, taste checks, cache length, auto-run, and clear cache.

## Development

```bash
npm test
```

Runs the unit tests for the pure stats module (`src/lib/stats.js`). Scraping selectors live in
`src/lib/letterboxd.js`, the recommender in `src/lib/recommend.js`, and each tab's view in `src/ui/`.

## Caveats

- Everything except the Letterboxd figure is an **estimate from a sample**.
- Facet lists use the first page (72 films) of each filter, so heavy users' older films aren't seen.
- For films that weren't sampled, the crowd signal in recommendations is approximated from the Letterboxd average.
- Letterboxd's "mini-themes" can't be filtered per user, so only its main themes are used.
- The first run on a film makes a few hundred requests. Later runs are mostly served from cache.
- Unofficial and not affiliated with Letterboxd. It only reads public pages, at a modest rate.
