// "Film stats" tab: weighted scores, deviation chart, who-likes-it segments,
// taste-aware out-of-character ratings and "fans also love".
(function (root) {
  const LBW = root.LBW;
  const { esc, fmt, signed, pct, stars, rankFor, hash, topFacets } = LBW.ui;

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
    const R = raters.length > 200 ? 3.5 : 4.5, D = 2 * R + 1, mid = top + plotH / 2, maxOff = plotH / 2 - R;
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
      const cls = r.delta > 0.25 ? '-up' : r.delta < -0.25 ? '-down' : '-flat';
      const ring = flaggedUsers.has(r.user) ? ' -flag' : '';
      const tip = `${r.name || r.user}: gave ${stars(r.rating)} · usually ${fmt(r.rawMean)} (${r.n} ratings) · ${signed(r.delta)}★ · z ${signed(r.z, 1)}`;
      return `<g class="lbw-dot ${cls}${ring}" data-tip="${esc(tip)}">
        <circle class="hit" cx="${x(r.delta).toFixed(1)}" cy="${ys.get(r).toFixed(1)}" r="9"></circle>
        <circle class="mark" cx="${x(r.delta).toFixed(1)}" cy="${ys.get(r).toFixed(1)}" r="${R}"></circle>
      </g>`;
    }).join('');

    return `
      <figure class="lbw-chart">
        <figcaption>
          <span>Each dot is a rater: how far this rating sits from their own average</span>
          <span class="lbw-legend"><i class="-down"></i>below their norm <i class="-flat"></i>about usual <i class="-up"></i>above their norm <i class="-ring"></i>against type</span>
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

  function wireTooltip(container) {
    const wrap = container.querySelector('.lbw-chart-wrap');
    const tip = wrap?.querySelector('.lbw-tip');
    if (!wrap) return;
    wrap.addEventListener('mouseover', (e) => {
      const g = e.target.closest('.lbw-dot');
      if (!g) { tip.hidden = true; return; }
      const rect = wrap.getBoundingClientRect();
      const c = g.querySelector('.mark').getBoundingClientRect();
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      const left = Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, c.left - rect.left - tip.offsetWidth / 2));
      tip.style.left = `${left}px`;
      tip.style.top = `${c.top - rect.top - tip.offsetHeight - 8}px`;
    });
    wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  function segmentsTable(segs) {
    if (!segs.length) return '';
    const max = Math.max(...segs.map((s) => Math.abs(s.delta)).filter(Number.isFinite), 0.5);
    return `<div class="lbw-segs">
      <h3 class="lbw-sub-h">Who likes it</h3>
      <table class="lbw-table"><tbody>${segs.map((s) => {
        const w = Number.isFinite(s.delta) ? (Math.abs(s.delta) / max) * 50 : 0;
        return `<tr>
          <td>${esc(s.label)} <span class="lbw-muted">· ${s.n}</span></td>
          <td class="lbw-num">${fmt(s.mean)}</td>
          <td class="lbw-segbar" title="Average vs their own norm: ${signed(s.delta)}★"><span class="${s.delta >= 0 ? '-up' : '-down'}" style="width:${w}%"></span></td>
          <td class="lbw-num lbw-muted">${signed(s.delta)}★</td>
        </tr>`;
      }).join('')}</tbody></table>
    </div>`;
  }

  // Out-of-character list. Rows are either quick (z vs own average) or refined
  // (residual vs a taste-aware expectation with reasons).
  function flagsList(rows, title, empty, slug) {
    if (!rows.length) return `<div class="lbw-flags"><h3 class="lbw-sub-h">${esc(title)}</h3><p class="lbw-muted">${esc(empty)}</p></div>`;
    return `<div class="lbw-flags"><h3 class="lbw-sub-h">${esc(title)}</h3><ol>${rows.slice(0, 8).map((r) => {
      const link = r.link || `/${r.user}/film/${slug}/`;
      const expect = r.expected
        ? `expected ${stars(r.expected.rounded)} from their taste · gave <span class="lbw-stars">${stars(r.rating)}</span>`
        : `<span class="lbw-stars">${stars(r.rating)}</span> · usually ${fmt(r.rawMean)} · ${rankFor(r.pct)} of their ${r.n} ratings`;
      return `<li>
        <a class="lbw-user" href="${esc(link)}">${esc(r.name || r.user)}</a>
        ${r.source === 'review' ? '<span class="lbw-chip">review</span>' : ''}
        ${r.contrarian ? '<span class="lbw-chip -contra" title="Also far from the crowd average">contrarian</span>' : ''}
        <div class="lbw-flag-line"><span class="lbw-muted">${expect}</span></div>
        ${r.expected ? `<div class="lbw-chips">${topFacets(r.expected, 3)}</div>` : ''}
        ${r.excerpt ? `<p class="lbw-excerpt">${esc(r.excerpt)}${r.excerpt.length >= 220 ? '…' : ''}</p>` : ''}
      </li>`;
    }).join('')}</ol></div>`;
  }

  function renderFlags(container, state, slug) {
    const el = container.querySelector('.lbw-flag-slot');
    if (!el) return;
    const rows = state.refined || state.quick;
    const key = state.refined ? 'resid' : 'z';
    const loved = rows.filter((r) => r[key] > 0);
    const hated = rows.filter((r) => r[key] < 0);
    el.innerHTML = `
      <p class="lbw-muted lbw-flag-note">${state.refined
        ? `Ratings that miss what each rater's own taste predicts: their history with this film's director, themes, genres, cast, language, decade and similar films, plus how the crowd rates it. ${state.checked} raters checked.`
        : `Quick pass: ratings far from each rater's average.${state.pending ? ` Checking ${state.pending} raters' tastes…` : ''}`}</p>
      <div class="lbw-flag-cols">
        ${flagsList(loved, 'Loved it, against type', 'No unusually generous ratings found.', slug)}
        ${flagsList(hated, 'Hated it, against type', 'No unusually harsh ratings found.', slug)}
      </div>`;
  }

  function renderAlsoLoved(container, state, filmName) {
    const el = container.querySelector('.lbw-also-slot');
    if (!el) return;
    if (state.status === 'loading') { el.innerHTML = `<h3 class="lbw-sub-h">Fans also love</h3><p class="lbw-muted">Reading ${state.total} raters' favourites…</p>`; return; }
    if (!state.items?.length) { el.innerHTML = state.status === 'done' ? `<h3 class="lbw-sub-h">Fans also love</h3><p class="lbw-muted">Not enough fans in the sample to find a pattern.</p>` : ''; return; }
    el.innerHTML = `<h3 class="lbw-sub-h">Fans also love <span class="lbw-muted">· people who rank ${esc(filmName)} in their personal top 10% disproportionately 4½–5★…</span></h3>
      <ol class="lbw-also">${state.items.slice(0, 10).map((f) => `<li>
        <a href="/film/${esc(f.slug)}/">${esc(f.name)}</a>
        <span class="lbw-muted" title="${f.fans} of ${state.fans} fans rated it 4½★+, vs ${pct(f.fanShare / f.lift)} of a comparison group">${f.fans}/${state.fans} fans · ${fmt(f.lift, 1)}×</span>
      </li>`).join('')}</ol>`;
  }

  function render(container, a, meta) {
    const f = a.film;
    const flaggedUsers = new Set((meta.flagUsers || a.flagged.map((r) => r.user)));
    container.innerHTML = `
      <div class="lbw-tiles">
        ${tile('Letterboxd', fmt(meta.weightedAverage), `${f.n.toLocaleString()} ratings`, "Letterboxd's own weighted average (their weighting formula is not public).")}
        ${tile('Raw mean', fmt(f.mean), `median ${stars(f.median)}`, 'Plain unweighted mean of every rating in the histogram.')}
        ${tile('Activity-weighted', fmt(a.activityWeighted), 'new accounts count less', 'Population-weighted sample mean where each rater counts by log(ratings), reaching full weight at 300 ratings.')}
        ${tile('Normalised', fmt(a.normalised), `z ${signed(a.meanZ)}`, "Each rating converted to a z-score against the rater's own history, averaged, then mapped back onto the pooled rating scale. Corrects for harsh and generous raters.", true)}
        ${tile('Vs their norm', signed(a.meanDelta) + '★', 'avg rating − rater avg', 'On average, how many stars above or below their personal average raters scored this film.', true)}
        ${tile('Personal rank', pct(a.meanPct), 'avg percentile', "Where this film sits within each rater's own ratings (50% = an ordinary film for them).", true)}
      </div>
      <div class="lbw-strip">
        <span><strong>${pct(a.favouriteShare)}</strong> put it in their top 10%</span>
        <span><strong>${pct(a.dislikeShare)}</strong> in their bottom 10%</span>
        <span title="Standard deviation ${fmt(f.sd)}; bimodality coefficient ${fmt(f.bimodality)}"><strong>${polarisationLabel(f)}</strong> · sd ${fmt(f.sd)}</span>
        <span title="Share of sampled raters with fewer than 50 ratings"><strong>${pct(a.lowActivityShare)}</strong> low-activity raters</span>
      </div>
      ${deviationChart(a.raters, flaggedUsers)}
      <div class="lbw-two">
        ${segmentsTable(LBW.stats.segments(a.raters))}
        <div class="lbw-also-slot"></div>
      </div>
      <div class="lbw-flag-slot"></div>
      <details class="lbw-method">
        <summary>How this is calculated</summary>
        <p>${a.sampleSize} raters sampled across all ten star buckets in proportion to the histogram (minimum 4 per bucket), each weighted back to its bucket's true size, plus raters from the top ${meta.reviewPages * 12} popular reviews (used for flags only). Each rater's personal histogram is read from their profile, with this film's rating removed. Thin accounts are shrunk toward the pooled average (μ ${fmt(a.ref.mean)}, σ ${fmt(a.ref.sd)}).</p>
        <p><strong>Against type</strong>: the most unusual raters get a taste profile built from their own ratings of films sharing this one's director, themes, genres, lead cast, language, country, decade, and its similar films. Each facet pulls the expected rating by how far above or below their norm they rate it, weighted by how specific it is and how many films back it. A rating is flagged when it lands ${meta.zThreshold}+ standard deviations from that expectation.</p>
        <p><strong>Fans also love</strong>: raters who put this film in their personal top 10% vs raters who found it ordinary; films that are far more common among the fans' 4½–5★ ratings.</p>
        <p class="lbw-muted">${meta.partial ? 'Still loading — numbers will settle.' : `Sampled ${new Date(meta.at).toLocaleString()}. Profiles cached for ${meta.profileTtlDays} days.`}</p>
      </details>`;
    wireTooltip(container);
  }

  LBW.filmTab = { render, renderFlags, renderAlsoLoved, hash };
})(globalThis);
