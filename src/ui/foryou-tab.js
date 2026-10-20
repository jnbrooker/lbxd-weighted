// "For a friend" tab: pick someone, see what to recommend to them.
(function (root) {
  const LBW = root.LBW;
  const { esc, fmt, stars, rankFor, matchPct, signed, topFacets, confDot } = LBW.ui;

  const SOURCE_TEXT = {
    loved: (s) => `because they loved ${s.label}`,
    you: (s) => `you gave it ${stars(s.rating)}`,
    fans: (s) => `fans of ${s.label} love it`,
    similarThis: (s) => `similar to ${s.label}`,
    thisFilm: () => 'this film',
    disliked: (s) => `like ${s.label}, which they gave ${stars(s.rating)}`,
  };

  function sourceChips(c, matchR) {
    const loved = c.sources.filter((s) => s.type === 'loved');
    const rest = c.sources.filter((s) => s.type !== 'loved');
    const chips = [];
    if (loved.length) chips.push([`because they loved ${loved.slice(0, 2).map((s) => s.label).join(' & ')}${loved.length > 2 ? ` +${loved.length - 2}` : ''}`, '']);
    // Warning tint: similar to something they hated, or your favourite when your tastes clash.
    rest.forEach((s) => chips.push([SOURCE_TEXT[s.type](s), s.type === 'disliked' || (s.type === 'you' && matchR < 0) ? '-warn' : '']));
    return chips.map(([t, cls]) => `<span class="lbw-chip -source ${cls}">${esc(t)}</span>`).join('');
  }

  // One film row. variant: 'rec' | 'gem' | 'avoid'.
  function filmItem(c, whoName, variant, matchR) {
    const score = variant === 'avoid'
      ? `<span class="lbw-stars">${stars(c.pred.rounded)}</span> <strong>${fmt(c.pred.rating)}</strong> <span class="lbw-muted">vs LB ${fmt(c.info.avg)} · ${rankFor(c.pred.pct)}</span> <span class="lbw-delta -down">${signed(c.aboveAvg, 1)}★</span>`
      : variant === 'gem'
      ? `<span class="lbw-stars">${stars(c.pred.rounded)}</span> <strong>${fmt(c.pred.rating)}</strong> <span class="lbw-muted">vs LB ${fmt(c.info.avg)}</span> <span class="lbw-delta">${signed(c.aboveAvg, 1)}★</span>`
      : `<span class="lbw-stars">${stars(c.pred.rounded)}</span> <strong>${fmt(c.pred.rating)}</strong> <span class="lbw-muted">${rankFor(c.pred.pct)} for ${esc(whoName)}</span>`;
    const meta = variant !== 'rec' ? esc(c.info.director || '') : `${esc(c.info.director || '')} · LB ${fmt(c.info.avg)}`;
    return `<li>
      <div class="lbw-rec-head">
        <a class="lbw-user" href="/film/${esc(c.slug)}/">${esc(c.info.name)}</a>
        <span class="lbw-muted">${meta}</span>
        <span class="lbw-rec-score">${confDot(c.pred.confidence)}${score}</span>
      </div>
      <div class="lbw-chips">${sourceChips(c, matchR)}${topFacets(c.pred, 3)}</div>
    </li>`;
  }

  const filmList = (list, n, whoName, variant, matchR, cls = '') =>
    `<ol class="lbw-recs-list ${cls}">${list.slice(0, n).map((c) => filmItem(c, whoName, variant, matchR)).join('')}</ol>`;

  function fingerprint(list, label) {
    const liked = list.filter((g) => g.shrunk > 0.1).slice(0, 4);
    const disliked = list.filter((g) => g.shrunk < -0.1).slice(-3).reverse();
    const chip = (g, cls) => `<span class="lbw-chip -facet ${cls}" title="${g.n} rated · ${signed(g.raw, 2)}σ vs their usual">${esc(g.key.replace(/-/g, ' '))} ${signed(g.raw, 1)}σ</span>`;
    if (!liked.length && !disliked.length) return '';
    return `<div class="lbw-fp"><span class="lbw-muted">${label}</span> ${liked.map((g) => chip(g, '-pos')).join('')}${disliked.map((g) => chip(g, '-neg')).join('')}</div>`;
  }

  function controls(state) {
    const opts = state.people.map((p) =>
      `<option value="${esc(p.user)}"${p.user === state.selected ? ' selected' : ''}>${p.isMe ? 'You' : esc(p.name || p.user)}${p.mutual ? ' · mutual' : ''}</option>`).join('');
    return `<div class="lbw-controls">
      <label class="lbw-muted" for="lbw-friend-pick">Recommend films for</label>
      <select id="lbw-friend-pick" class="lbw-select" data-act="pick-friend">${opts}</select>
      <button type="button" class="lbw-btn" data-act="run-foryou"${state.status === 'loading' ? ' disabled' : ''}>${state.status === 'loading' ? 'Working…' : 'Find films'}</button>
    </div>`;
  }

  function render(el, state) {
    if (state.status === 'need-user') {
      el.innerHTML = `<p class="lbw-muted">Sign in to Letterboxd, or set your username in the extension options, to get recommendations for the people you follow.</p>`;
      return;
    }
    if (!state.people) { el.innerHTML = '<p class="lbw-muted">Loading the people you follow…</p>'; return; }

    let bodyHtml = '';
    if (state.status === 'loading') {
      bodyHtml = `<div class="lbw-progress -inline"><div class="lbw-bar" style="width:${state.total ? (100 * state.done) / state.total : 0}%"></div><span class="lbw-progress-label">Reading their taste · ${state.done}/${state.total}</span></div>`;
    } else if (state.status === 'error') {
      bodyHtml = `<p class="lbw-error">${esc(state.error)}</p>`;
    } else if (state.result) {
      const r = state.result;
      const who = state.people.find((p) => p.user === r.target);
      const whoName = who?.isMe ? 'you' : who?.name || r.target;
      const matchR = r.match ? r.match.r : 0;
      bodyHtml = `
        <div class="lbw-person">
          <div><strong>${esc(who?.isMe ? 'You' : whoName)}</strong> <span class="lbw-muted">· ${r.profile.n.toLocaleString()} ratings · average ${fmt(r.profile.mean)}</span>
            ${r.match && r.match.n >= 5 ? `<span class="lbw-chip" title="Correlation ${fmt(r.match.raw)} across ${r.match.n} films you've both rated">${matchPct(r.match.r)} taste match with you · ${r.match.n} shared</span>` : ''}</div>
          ${fingerprint(r.genres, 'Genres')}
          ${fingerprint(r.decades, 'Decades')}
        </div>
        <h3 class="lbw-sub-h">Recommend</h3>
        ${r.items.length ? filmList(r.items, 12, whoName, 'rec', matchR) : '<p class="lbw-muted">No unseen candidates look likely to land in their top half.</p>'}
        <div class="lbw-flag-cols -wide lbw-foryou-cols">
          <div>
            <h3 class="lbw-sub-h">They'd rate way above average</h3>
            <p class="lbw-muted lbw-col-note">Predicted well above the Letterboxd average, so their taste rather than the film's reputation is doing the work.</p>
            ${r.gems.length ? filmList(r.gems, 6, whoName, 'gem', matchR, '-compact') : '<p class="lbw-muted">Nothing found clearly above the consensus for them.</p>'}
          </div>
          <div>
            <h3 class="lbw-sub-h">Don't recommend</h3>
            <p class="lbw-muted lbw-col-note">Likely to land low among their own ratings and below the Letterboxd average, furthest below the crowd first.</p>
            ${r.avoid.length ? filmList(r.avoid, 6, whoName, 'avoid', matchR, '-compact -avoid') : '<p class="lbw-muted">No obvious misses among the films checked.</p>'}
          </div>
        </div>
        <p class="lbw-muted lbw-fineprint">Candidates come from films similar to their 4½–5★ favourites (and, for the warnings, their lowest-rated films), your own favourites (weighted by taste match), this film and its similar films, and what this film's fans also love. Each is scored against their genre, decade, director, theme, language and cast history plus the film's Letterboxd average, and ranked by where it would land among their own ratings.</p>`;
    }
    el.innerHTML = controls(state) + bodyHtml;
  }

  LBW.forYouTab = { render };
})(globalThis);
