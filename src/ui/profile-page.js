// Advanced stats panel on member profiles (/<username>/).
(function (root) {
  const LBW = root.LBW;
  const { esc, fmt, signed, pct, stars, hash, matchPct } = LBW.ui;

  const SVG_NS_ATTR = 'xmlns="http://www.w3.org/2000/svg"';
  const fmtVotes = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

  function tile(label, value, note, help, accent) {
    return `<div class="lbw-tile${accent ? ' -accent' : ''}" title="${esc(help)}">
      <div class="lbw-tile-label">${esc(label)}</div>
      <div class="lbw-tile-value">${value}</div>
      <div class="lbw-tile-note">${note}</div>
    </div>`;
  }

  // Expected (x) vs actual (y), with the y = x "as predicted" line and their fitted line.
  function scatter(rows, fit) {
    const W = 640, H = 300, L = 40, R = 14, T = 12, B = 34;
    const x = (v) => L + ((v - 0.5) / 4.5) * (W - L - R);
    const y = (v) => H - B - ((v - 0.5) / 4.5) * (H - T - B);
    const ticks = [1, 2, 3, 4, 5];
    const dots = rows.map((r) => {
      const jx = ((hash(r.slug) % 1000) / 1000 - 0.5) * 0.08;
      const jy = ((hash(r.slug + 'y') % 1000) / 1000 - 0.5) * 0.28;
      const cls = r.resid > 0.5 ? '-up' : r.resid < -0.5 ? '-down' : '-flat';
      const tip = `${r.name}: gave ${stars(r.rating)} · expected ${fmt(r.expected)} · Letterboxd ${fmt(r.avg)} · ${fmtVotes(r.votes)} ratings`;
      return `<g class="lbw-dot ${cls}" data-tip="${esc(tip)}"><circle class="hit" cx="${x(r.expected + jx).toFixed(1)}" cy="${y(r.rating + jy).toFixed(1)}" r="8"></circle><circle class="mark" cx="${x(r.expected + jx).toFixed(1)}" cy="${y(r.rating + jy).toFixed(1)}" r="3.5"></circle></g>`;
    }).join('');
    // Trend line over the data's x-range, clipped where it leaves the 0.5–5 band
    // (clamping the endpoints instead would bend it onto the diagonal).
    let fitLine = '';
    if (Number.isFinite(fit.slope) && rows.length) {
      const xs = rows.map((r) => r.expected);
      let x0 = Math.min(...xs), x1 = Math.max(...xs);
      const at = (v) => fit.intercept + fit.slope * v;
      const solve = (yv) => (yv - fit.intercept) / fit.slope;
      if (fit.slope) {
        const lo = Math.min(solve(0.5), solve(5)), hi = Math.max(solve(0.5), solve(5));
        x0 = Math.max(x0, lo); x1 = Math.min(x1, hi);
      }
      if (x1 > x0) fitLine = `<line class="lbw-fit" x1="${x(x0).toFixed(1)}" y1="${y(at(x0)).toFixed(1)}" x2="${x(x1).toFixed(1)}" y2="${y(at(x1)).toFixed(1)}"></line>`;
    }
    return `<figure class="lbw-chart">
      <figcaption><span>Expected vs actual — each dot is one of their films</span>
        <span class="lbw-legend"><i class="-up"></i>beat expectation <i class="-flat"></i>as expected <i class="-down"></i>below expectation <b class="lbw-key-line -diag"></b>as predicted <b class="lbw-key-line -fit"></b>their trend</span></figcaption>
      <div class="lbw-chart-wrap">
        <svg ${SVG_NS_ATTR} viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter of expected versus actual ratings">
          ${ticks.map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"></line><line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"></line>
            <text class="tick" x="${x(t)}" y="${H - B + 16}">${t}★</text><text class="tick -y" x="${L - 8}" y="${y(t) + 3}">${t}★</text>`).join('')}
          <text class="tick" x="${(L + W - R) / 2}" y="${H - 2}">expected rating (their norm + how the crowd rates the film)</text>
          <line class="lbw-diag" x1="${x(0.5)}" y1="${y(0.5)}" x2="${x(5)}" y2="${y(5)}"></line>
          ${fitLine}
          ${dots}
        </svg>
        <div class="lbw-tip" hidden></div>
      </div>
    </figure>`;
  }

  // Their rating distribution vs the crowd's averages for the same films.
  function distribution(rows) {
    const theirs = new Array(10).fill(0), crowd = new Array(10).fill(0);
    rows.forEach((r) => {
      theirs[Math.round(r.rating * 2) - 1]++;
      crowd[Math.max(0, Math.min(9, Math.round(r.avg * 2) - 1))]++;
    });
    const max = Math.max(...theirs, ...crowd, 1);
    const W = 640, H = 150, L = 10, B = 22, T = 8, bw = (W - 2 * L) / 10;
    const h = (v) => ((H - B - T) * v) / max;
    return `<figure class="lbw-chart">
      <figcaption><span>How they spread their ratings vs the crowd on the same films</span>
        <span class="lbw-legend"><i class="-theirs"></i>their ratings <b class="lbw-key-line -crowd"></b>Letterboxd averages (averages always bunch toward the middle)</span></figcaption>
      <svg ${SVG_NS_ATTR} viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating distribution">
        ${theirs.map((v, i) => `<rect class="lbw-bar-theirs" x="${L + i * bw + 3}" y="${H - B - h(v)}" width="${bw - 6}" height="${Math.max(0, h(v))}" rx="3"><title>${stars((i + 1) / 2)}: ${v} of their ratings, ${crowd[i]} crowd averages</title></rect>`).join('')}
        <polyline class="lbw-crowd-line" points="${crowd.map((v, i) => `${L + i * bw + bw / 2},${H - B - h(v)}`).join(' ')}"></polyline>
        ${crowd.map((v, i) => `<circle class="lbw-crowd-pt" cx="${L + i * bw + bw / 2}" cy="${H - B - h(v)}" r="4"></circle>`).join('')}
        ${theirs.map((_, i) => `<text class="tick" x="${L + i * bw + bw / 2}" y="${H - 6}">${stars((i + 1) / 2)}</text>`).join('')}
      </svg>
    </figure>`;
  }

  function divergingBars(list, title) {
    if (!list.length) return '';
    const max = Math.max(0.5, ...list.map((g) => Math.abs(g.raw)));
    return `<div class="lbw-fpbars"><h3 class="lbw-sub-h">${esc(title)}</h3>
      ${list.map((g) => {
        const w = (Math.abs(g.raw) / max) * 50;
        return `<div class="lbw-fprow" title="${g.n} rated · ${signed(g.raw, 2)} standard deviations vs their usual">
          <span class="lbw-fplabel">${esc(g.key.replace(/-/g, ' '))}</span>
          <span class="lbw-fptrack"><span class="${g.raw >= 0 ? '-up' : '-down'}" style="width:${w}%"></span></span>
          <span class="lbw-fpval">${signed(g.raw, 1)}σ</span>
        </div>`;
      }).join('')}</div>`;
  }

  function driftBars(drift) {
    const valid = drift.filter((d) => d.n >= 5);
    if (valid.length < 3) return '';
    const max = Math.max(0.3, ...valid.map((d) => Math.abs(d.resid)));
    return `<div class="lbw-fpbars"><h3 class="lbw-sub-h">Drift · vs expectation over time</h3>
      ${valid.map((d) => `<div class="lbw-fprow" title="${d.n} films · average ${fmt(d.rating)}★">
        <span class="lbw-fplabel">${d.label}</span>
        <span class="lbw-fptrack"><span class="${d.resid >= 0 ? '-up' : '-down'}" style="width:${(Math.abs(d.resid) / max) * 50}%"></span></span>
        <span class="lbw-fpval">${signed(d.resid, 2)}★</span>
      </div>`).join('')}</div>`;
  }

  function filmList(rows, title, empty) {
    return `<div class="lbw-flags"><h3 class="lbw-sub-h">${esc(title)}</h3>${rows.length ? `<ol>${rows.map((r) => `<li>
      <a class="lbw-user" href="/film/${esc(r.slug)}/">${esc(r.name)}</a>
      <div class="lbw-flag-line"><span class="lbw-stars">${stars(r.rating)}</span><span class="lbw-muted">expected ${fmt(r.expected)} · Letterboxd ${fmt(r.avg)} · ${signed(r.resid, 1)}★</span></div>
    </li>`).join('')}</ol>` : `<p class="lbw-muted">${esc(empty)}</p>`}</div>`;
  }

  function crowdStyle(fit) {
    if (!Number.isFinite(fit.slope)) return '—';
    if (fit.slope > 1.25) return 'amplifies the crowd';
    if (fit.slope < 0.6) return 'compresses the crowd';
    return 'tracks the crowd';
  }

  function render(el, a, viewerIsThem) {
    const s = a.summary;
    const who = viewerIsThem ? 'you' : 'them';
    const m = a.match;
    el.innerHTML = `
      <div class="lbw-tiles">
        ${tile('Ratings', s.n.toLocaleString(), `avg ${fmt(s.mean)} · sd ${fmt(s.sd)}`, 'From their profile rating histogram.')}
        ${tile('Harshness', Number.isFinite(s.harsherThan) ? pct(s.harsherThan) : '—', Number.isFinite(s.harsherThan) ? `harsher than members seen` : 'needs more cached members', `Share of the ${s.memberPool} members cached by this extension whose average rating is higher.`)}
        ${tile('Crowd agreement', fmt(a.crowd.fit.r), crowdStyle(a.crowd.fit), `Correlation between their ratings and Letterboxd averages on ${a.rows.length} films. Slope ${fmt(a.crowd.fit.slope)}: above 1 exaggerates the crowd's differences, below 1 flattens them.`, true)}
        ${tile('vs the crowd', signed(a.crowd.generosity) + '★', 'avg rating − LB avg', 'How much kinder (positive) or harsher (negative) they are than the Letterboxd average on the same films.', true)}
        ${tile('Predictability', `±${fmt(a.model.mae)}★`, `${pct(a.model.offByOne)} off by 1★+`, 'Average gap between their rating and the expected rating (their norm shifted by how the crowd rates the film).', true)}
        ${tile('Mainstream', fmtVotes(a.crowd.medianVotes), `${pct(a.crowd.obscureShare)} under 10K ratings`, 'Median number of Letterboxd ratings on the films they rate.')}
        ${tile('Acclaim taste', fmt(a.crowd.meanAvg), `${pct(a.crowd.acclaimedShare)} rated 4+ by LB`, 'Average Letterboxd rating of the films they choose to watch.')}
        ${tile('Scale use', fmt(s.levels, 1), `levels · ${pct(s.half)} half-stars`, `Effective number of rating levels used (entropy). ${pct(s.fives)} of ratings are 5★, ${pct(s.lows)} are 1★ or below.`)}
      </div>
      ${m && m.n >= 5 ? `<div class="lbw-person"><strong>${matchPct(m.r)} taste match with you</strong> <span class="lbw-muted">· correlation ${fmt(m.raw)} on ${m.n} shared films</span>
        <div class="lbw-chips">${m.agree.map((f) => `<span class="lbw-chip -source" title="You ${stars(f.mine)} · them ${stars(f.theirs)}">both love ${esc(f.name)}</span>`).join('')}
        ${m.clash.map((f) => `<span class="lbw-chip -source -warn" title="You ${stars(f.mine)} · them ${stars(f.theirs)}">${esc(f.name)}: you ${stars(f.mine)}, them ${stars(f.theirs)}</span>`).join('')}</div></div>` : ''}
      ${scatter(a.rows, a.model.fit)}
      ${distribution(a.rows)}
      <div class="lbw-two">
        ${divergingBars(a.genres, 'Genres · vs their usual')}
        <div>
          ${divergingBars(a.decades, 'Decades · vs their usual')}
          ${driftBars(a.drift)}
        </div>
      </div>
      <div class="lbw-flag-cols">
        ${filmList(a.hotTakes.loved, 'Hot takes · loved beyond expectation', 'Nothing far above expectation.')}
        ${filmList(a.hotTakes.hated, 'Hot takes · below expectation', 'Nothing far below expectation.')}
      </div>
      <details class="lbw-method"><summary>How this is calculated</summary>
        <p>Based on ${a.rows.length} of ${who === 'you' ? 'your' : 'their'} rated films (the most recent ones plus top and bottom rated), each matched with its Letterboxd histogram. <strong>Expected rating</strong> = their own average shifted by how far above or below raters' norms the crowd rates that film, scaled by their own spread. Genre and decade affinity compare their ratings in each with their overall habits. Drift splits the recent films into four chronological groups.</p>
        <p class="lbw-muted">Computed ${new Date(a.at).toLocaleString()}.</p>
      </details>`;
    // tooltip
    const wrap = el.querySelector('.lbw-chart-wrap');
    const tip = wrap?.querySelector('.lbw-tip');
    wrap?.addEventListener('mouseover', (e) => {
      const g = e.target.closest('.lbw-dot');
      if (!g) { tip.hidden = true; return; }
      const rect = wrap.getBoundingClientRect();
      const c = g.querySelector('.mark').getBoundingClientRect();
      tip.textContent = g.dataset.tip;
      tip.hidden = false;
      tip.style.left = `${Math.min(rect.width - tip.offsetWidth - 4, Math.max(4, c.left - rect.left - tip.offsetWidth / 2))}px`;
      tip.style.top = `${c.top - rect.top - tip.offsetHeight - 8}px`;
    });
    wrap?.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  function mount(user) {
    const header = document.querySelector('.profile-header');
    if (!header || document.getElementById('lbw-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'lbw-panel';
    panel.className = 'lbw lbw-profile';
    panel.innerHTML = `
      <header class="lbw-head">
        <div><h2 class="lbw-title">Advanced stats</h2><p class="lbw-sub">Their ratings against the crowd and against their own habits</p></div>
        <div class="lbw-actions">
          <button type="button" class="lbw-btn" data-act="profile-run">Analyse</button>
          <button type="button" class="lbw-btn -ghost" data-act="toggle" title="Collapse">–</button>
        </div>
      </header>
      <div class="lbw-progress" hidden><div class="lbw-bar"></div><span class="lbw-progress-label"></span></div>
      <div class="lbw-body"><p class="lbw-muted">Reads ~200 of their rated films and each film's Letterboxd histogram (a minute or two the first time, instant after that).</p></div>`;
    header.after(panel);
    const body = panel.querySelector('.lbw-body');
    const prog = panel.querySelector('.lbw-progress');
    const key = `pstats:${user}`;
    let busy = false;

    const me = (async () => {
      try {
        const s = await chrome.storage.sync.get({ username: '' });
        return (s.username || '').trim().toLowerCase() || LBW.lb.detectUsername(document);
      } catch (_) { return LBW.lb.detectUsername(document); }
    })();

    async function go() {
      if (busy) return;
      busy = true;
      const btn = panel.querySelector('[data-act="profile-run"]');
      btn.disabled = true; btn.textContent = 'Analysing…';
      try {
        const viewer = await me;
        const a = await LBW.profileStats.analyseMember(user, {
          me: viewer,
          onProgress: (d, t) => {
            prog.hidden = d >= t;
            prog.querySelector('.lbw-bar').style.width = `${(100 * d) / t}%`;
            prog.querySelector('.lbw-progress-label').textContent = `Reading ratings · ${d}/${t}`;
          },
        });
        try { await chrome.storage.local.set({ [key]: { t: Date.now(), v: a } }); } catch (_) {}
        render(body, a, viewer === user);
      } catch (e) {
        console.error('[lbxd-weighted] profile', e);
        body.innerHTML = `<p class="lbw-error">${esc(e.message)}</p>`;
      } finally {
        prog.hidden = true;
        busy = false; btn.disabled = false; btn.textContent = 'Refresh';
      }
    }

    panel.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'profile-run') go();
      if (act === 'toggle') {
        const c = panel.classList.toggle('-collapsed');
        e.target.textContent = c ? '+' : '–';
      }
    });

    // Show a cached analysis straight away.
    (async () => {
      try {
        const hit = (await chrome.storage.local.get(key))[key];
        if (hit && Date.now() - hit.t < 7 * LBW.lb.DAY) {
          render(body, hit.v, (await me) === user);
          panel.querySelector('[data-act="profile-run"]').textContent = 'Refresh';
        }
      } catch (_) {}
    })();
  }

  LBW.profilePage = { mount };
})(globalThis);
