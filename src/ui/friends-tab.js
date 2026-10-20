// "Friends" tab: predicted ratings for this film for everyone you follow
// (mutuals first), with actual ratings, taste match and a model check.
(function (root) {
  const LBW = root.LBW;
  const { esc, fmt, signed, stars, rankFor, matchPct, topFacets, confDot } = LBW.ui;

  const nameOf = (r) => (r.isMe ? 'You' : r.name || r.user);
  const mutualChip = (r) => (r.mutual ? '<span class="lbw-chip -mutual" title="You follow each other">mutual</span>' : '');
  const matchChip = (r) => (r.match && r.match.n >= 5
    ? `<span class="lbw-chip" title="Taste correlation ${fmt(r.match.raw)} across ${r.match.n} films you've both rated">${matchPct(r.match.r)} match</span>`
    : '');

  function render(el, state, slug) {
    if (state.status === 'need-user') {
      el.innerHTML = `<p class="lbw-muted">Sign in to Letterboxd, or set your username in the extension options, to see predicted ratings for the people you follow.</p>`;
      return;
    }
    if (state.status === 'waiting') {
      el.innerHTML = `<p class="lbw-muted">Friend predictions start once the film's raters are sampled…</p>`;
      return;
    }
    const rows = state.rows.filter((r) => r.pred);
    const unseen = rows.filter((r) => !r.seen).sort((a, b) => b.pred.pct - a.pred.pct || b.pred.rating - a.pred.rating);
    const seen = rows.filter((r) => r.seen && r.actual != null).sort((a, b) => b.actual - a.actual);
    const seenUnrated = state.rows.filter((r) => r.seen && r.actual == null);
    const recs = unseen.filter((r) => !r.isMe && r.pred.pct >= 0.7).slice(0, 6);
    const me = state.rows.find((r) => r.isMe);
    const loading = state.status === 'loading';
    const remaining = state.friends.length - state.queued;

    el.innerHTML = `
      <p class="lbw-muted">${loading ? `Checking ${state.done}/${state.queued}…` : `${state.queued} of ${state.friends.length} people you follow checked`} · ${state.mutuals} mutual${remaining > 0 && !loading ? ` · <button type="button" class="lbw-btn -small" data-act="more-friends">Check ${Math.min(remaining, state.batch)} more</button>` : ''}</p>
      ${me && !me.seen && me.pred ? `<p class="lbw-me">Your predicted rating: <span class="lbw-stars">${stars(me.pred.rounded)}</span> <strong>${fmt(me.pred.rating)}</strong> <span class="lbw-muted">· ${rankFor(me.pred.pct)} of your ratings</span> ${topFacets(me.pred, 3)}</p>` : ''}
      ${recs.length ? `<div class="lbw-recs"><span class="lbw-muted">Recommend to</span> ${recs.map((r) => `<a class="lbw-rec${r.mutual ? ' -mutual' : ''}" href="/${esc(r.user)}/" title="Predicted ${fmt(r.pred.rating)} · ${rankFor(r.pred.pct)} of their ratings">${esc(nameOf(r))} <span class="lbw-stars">${stars(r.pred.rounded)}</span></a>`).join('')}</div>`
        : !loading && unseen.length ? '<p class="lbw-muted">None of the friends checked look likely to rank this in their top 30%.</p>' : ''}
      <div class="lbw-flag-cols -wide">
        <div>
          <h3 class="lbw-sub-h">Haven't seen it · predicted</h3>
          ${unseen.length ? `<table class="lbw-table"><tbody>${unseen.map((r) => `<tr>
              <td><a class="lbw-user" href="/${esc(r.user)}/">${esc(nameOf(r))}</a> ${mutualChip(r)}</td>
              <td class="lbw-num"><span class="lbw-stars">${stars(r.pred.rounded)}</span> <span class="lbw-muted">${fmt(r.pred.rating)}</span></td>
              <td class="lbw-num">${rankFor(r.pred.pct)}</td>
              <td class="lbw-why">${confDot(r.pred.confidence)}<span class="lbw-muted">usually ${fmt(r.pred.mean)}</span> ${matchChip(r)} ${topFacets(r.pred, 2)}</td>
            </tr>`).join('')}</tbody></table>` : `<p class="lbw-muted">${loading ? '…' : 'Everyone checked has seen it.'}</p>`}
        </div>
        <div>
          <h3 class="lbw-sub-h">Already rated</h3>
          ${seen.length ? `<table class="lbw-table"><tbody>${seen.map((r) => {
            const err = r.pred.rounded - r.actual;
            return `<tr>
              <td><a class="lbw-user" href="/${esc(r.user)}/film/${esc(slug)}/">${esc(nameOf(r))}</a> ${mutualChip(r)}</td>
              <td class="lbw-num"><span class="lbw-stars">${stars(r.actual)}</span></td>
              <td class="lbw-num lbw-muted">predicted ${stars(r.pred.rounded)}</td>
              <td class="lbw-num lbw-muted">${err === 0 ? 'exact' : signed(err, 1) + '★'}</td>
            </tr>`;
          }).join('')}</tbody></table>` : `<p class="lbw-muted">${loading ? '…' : 'No one checked has rated it yet.'}</p>`}
          ${seenUnrated.length ? `<p class="lbw-muted">Watched without rating: ${seenUnrated.map((r) => esc(nameOf(r))).join(', ')}</p>` : ''}
          ${state.check ? `<p class="lbw-check" title="Each friend who rated it is predicted as if they hadn't (their rating removed everywhere), then compared with what they actually gave.">Model check on ${state.check.n} friend${state.check.n === 1 ? '' : 's'}: off by <strong>±${fmt(state.check.mae)}★</strong> on average, vs ±${fmt(state.check.baseline)}★ for just guessing their usual average.</p>` : ''}
        </div>
      </div>`;
  }

  LBW.friendsTab = { render };
})(globalThis);
