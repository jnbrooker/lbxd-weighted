# Letterboxd Weighted Stats

A Chrome extension that adds a **Weighted stats** dashboard to every Letterboxd film page
(`letterboxd.com/film/<slug>/`), just above Popular Reviews.

It reads each rating against **the rater's own rating habits**. A 4★ from someone who
averages 2.3 means more than a 4★ from someone who gives everything 4★. It also flags ratings
that are **out of character** for the person who gave them.

## What it shows

| Metric | Meaning |
|---|---|
| **Letterboxd** | Letterboxd's own weighted average. Their formula isn't public. |
| **Raw mean** | Plain mean of the full rating histogram, plus the median. |
| **Activity-weighted** | Each rater counts by `log(ratings)`, reaching full weight at 300 ratings, so new or barely-used accounts count less. |
| **Normalised** | Each rating becomes a z-score against that rater's own history. The z-scores are averaged, then mapped back onto the pooled star scale. This corrects for harsh and generous raters. |
| **Vs their norm** | Average of (rating − the rater's personal average), in stars. |
| **Personal rank** | Average percentile of this film within each rater's own ratings. 50% means an ordinary film for them. |
| Top/bottom 10% | Share of raters for whom this film sits in their personal top or bottom decile. |
| Polarisation | Spread (sd) plus Sarle's bimodality coefficient: *Consensus / Typical / Mixed / Divisive*. |
| Low-activity raters | Share of sampled raters with fewer than 50 ratings. |

**Deviation chart:** a beeswarm with one dot per sampled rater, positioned by how far their rating sits
from their own average. Hover a dot for details. Ringed dots are flagged.

**Out-of-character lists:** "Loved it, against type" and "Hated it, against type". A rating is
listed when it's at least *z* (default 2) standard deviations from the rater's own average. Only
raters with 25+ ratings are considered. Each entry links to the rating or review. A
**contrarian** chip means the rating is also ≥1.75★ from the crowd's mean. A **review** chip means
the rater came from the popular reviews, and the entry shows an excerpt.

## How it works

1. Fetches the film's histogram (`/csi/film/<slug>/rating-histogram/`).
2. Splits a sample (default 120 raters) across the ten star buckets in proportion to the
   histogram, with at least 4 raters per bucket. It picks raters at random from
   `/film/<slug>/ratings/rated/<n>/`. Each sampled rater is weighted back to their bucket's true
   size, so the estimates represent the whole population.
3. Adds the raters behind the top popular reviews (default 2 pages, 24 reviews). These are used for
   flags only, not for the averages.
4. Reads each rater's profile histogram. **This film's own rating is removed** (leave-one-out)
   before computing their baseline. Thin accounts are shrunk toward the pooled average so tiny
   samples can't produce extreme z-scores.

Requests are same-origin, limited to 4 at a time, and back off on HTTP 429. Results are cached in
`chrome.storage.local`: profiles for 14 days, bucket lists and reviews for 2 days. The sample is
seeded per film, so revisiting a film reuses cached profiles. **Resample** draws a new sample.

## Install (unpacked)

1. Clone this repo.
2. Open `chrome://extensions`, then turn on **Developer mode**.
3. Click **Load unpacked** and choose the repo folder.
4. Open any film page, e.g. <https://letterboxd.com/film/parasite-2019/>.

Click the toolbar icon to open the options: sample size, flag threshold, number of review pages,
cache length, auto-run, and clear cache.

## Development

```bash
npm test
```

Runs the unit tests for the pure stats module (`src/lib/stats.js`). The scraping selectors live in
`src/lib/letterboxd.js`. If Letterboxd changes its markup, fix it there.

## Caveats

- Everything except the Letterboxd figure is an **estimate from a sample**. Expect about ±0.05★ run to run.
- Rated-bucket pages list the 500 most recent raters, so the sample leans toward recent activity.
- Unofficial and not affiliated with Letterboxd. It only reads public pages, at a modest rate.
