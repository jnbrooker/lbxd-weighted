// Fetching + parsing of Letterboxd HTML. All requests are same-origin from the
// film page, throttled, and cached in chrome.storage.local.
(function (root) {
  const LBW = (root.LBW = root.LBW || {});
  const DAY = 24 * 60 * 60 * 1000;

  // ---------- parsing ----------

  const toInt = (s) => {
    const m = String(s || '').match(/[\d,]+/);
    return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
  };

  // Works for both the film histogram and the one in a user's profile sidebar.
  function parseHistogram(doc) {
    const bars = [...doc.querySelectorAll('.rating-histogram tr.column, .rating-histogram li.rating-histogram-bar')];
    if (bars.length !== 10) return null;
    return bars.map((bar) => {
      const a = bar.querySelector('a.barcolumn, a');
      return a ? toInt(a.getAttribute('title') || a.textContent) : 0;
    });
  }

  function parseWeightedAverage(doc) {
    const el = doc.querySelector('.averagerating');
    const m = el && (el.getAttribute('title') || '').match(/average of ([\d.]+)/i);
    return m ? parseFloat(m[1]) : NaN;
  }

  // aria-label like "★★★★½" or "½"
  function parseStars(label) {
    if (!label) return NaN;
    const full = (label.match(/★/g) || []).length;
    const half = label.includes('½') ? 0.5 : 0;
    const v = full + half;
    return v > 0 ? v : NaN;
  }

  function parseRatedUsers(doc) {
    return [...doc.querySelectorAll('a.watchedstate-avatar')]
      .map((a) => (a.getAttribute('href') || '').split('/')[1])
      .filter(Boolean);
  }

  function parseReviews(doc) {
    return [...doc.querySelectorAll('.viewing-list .listitem')]
      .map((li) => {
        const user = (li.querySelector('a.avatar')?.getAttribute('href') || '').split('/')[1];
        const rating = parseStars(li.querySelector('.inline-rating svg')?.getAttribute('aria-label'));
        const link = li.querySelector('a.context')?.getAttribute('href');
        const name = li.querySelector('.displayname')?.textContent.trim();
        const likes = toInt(li.querySelector('[data-count]')?.dataset.count);
        const excerpt = li.querySelector('.js-review-body')?.textContent.trim().replace(/\s+/g, ' ').slice(0, 220);
        return { user, rating, link, name, likes, excerpt };
      })
      .filter((r) => r.user && Number.isFinite(r.rating));
  }

  function parseProfile(doc) {
    const counts = parseHistogram(doc);
    const name = doc.querySelector('.profile-name .displayname, h1.title-1')?.textContent.trim();
    const avatar = doc.querySelector('.profile-avatar img, .profile-summary img.avatar, .avatar img')?.getAttribute('src');
    return counts ? { counts, name, avatar } : null;
  }

  // ---------- fetching ----------

  const parser = new DOMParser();
  let active = 0;
  const waiters = [];
  const MAX_CONCURRENT = 6;
  const GAP_MS = 120;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function slot() {
    if (active < MAX_CONCURRENT) { active++; return; }
    await new Promise((r) => waiters.push(r));
    active++;
  }
  function release() {
    active--;
    const next = waiters.shift();
    if (next) setTimeout(next, GAP_MS);
  }

  async function fetchDoc(path, { allow404 = false } = {}, attempt = 0) {
    await slot();
    let res;
    try {
      res = await fetch(path, { credentials: 'include' });
    } finally {
      release();
    }
    if (res.status === 429 && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      return fetchDoc(path, { allow404 }, attempt + 1);
    }
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return parser.parseFromString(await res.text(), 'text/html');
  }

  // ---------- cache ----------

  const store = () => chrome.storage.local;

  async function cached(key, ttl, producer) {
    try {
      const hit = (await store().get(key))[key];
      if (hit && Date.now() - hit.t < ttl) return hit.v;
    } catch (_) { /* storage unavailable — just fetch */ }
    const v = await producer();
    try { await store().set({ [key]: { t: Date.now(), v } }); } catch (_) {}
    return v;
  }

  async function clearCache() {
    await store().clear();
  }

  // ---------- high-level API ----------

  const bucketPath = (r) => {
    const whole = Math.floor(r);
    const label = r % 1 ? `${whole || ''}½` : String(whole);
    return encodeURIComponent(label);
  };

  async function getFilmHistogram(slug) {
    const doc = await fetchDoc(`/csi/film/${slug}/rating-histogram/`);
    return { counts: parseHistogram(doc), weightedAverage: parseWeightedAverage(doc) };
  }

  async function getUsersInBucket(slug, rating) {
    return cached(`bucket:${slug}:${rating}`, 2 * DAY, async () =>
      parseRatedUsers(await fetchDoc(`/film/${slug}/ratings/rated/${bucketPath(rating)}/`))
    );
  }

  async function getPopularReviews(slug, pages) {
    return cached(`reviews:${slug}:${pages}`, 2 * DAY, async () => {
      const out = [];
      for (let p = 1; p <= pages; p++) {
        const suffix = p > 1 ? `page/${p}/` : '';
        out.push(...parseReviews(await fetchDoc(`/film/${slug}/reviews/by/activity/${suffix}`)));
      }
      return out;
    });
  }

  async function getProfile(user, ttlDays) {
    return cached(`user:${user}`, ttlDays * DAY, async () => {
      try {
        return parseProfile(await fetchDoc(`/${user}/`));
      } catch (e) {
        return null;
      }
    });
  }

  // ---------- friends ----------

  // The signed-in user's name lives in an inline `person = { username: "..." }` script.
  function detectUsername(doc) {
    for (const s of doc.querySelectorAll('script:not([src])')) {
      const m = s.textContent.match(/person\s*=\s*\{\s*username:\s*"([^"]*)"/);
      if (m) return m[1] || null;
    }
    return null;
  }

  function parseFilmGenres(doc) {
    const links = doc.querySelectorAll('#tab-panel-genres a[href^="/films/genre/"], #tab-genres a[href^="/films/genre/"]');
    return [...new Set([...links].map((a) => a.getAttribute('href').split('/')[3]).filter(Boolean))];
  }

  function parseFollowing(doc) {
    return [...doc.querySelectorAll('.person-summary a.name')].map((a) => ({
      user: (a.getAttribute('href') || '').split('/')[1],
      name: a.textContent.trim(),
    })).filter((f) => f.user);
  }

  // Film grid items carry `rated-N` where N is half-stars (absent when unrated).
  function parseGridFilms(doc) {
    return [...doc.querySelectorAll('.griditem')].map((li) => {
      const item = li.querySelector('[data-item-slug]');
      if (!item) return null;
      const m = (li.querySelector('.rating')?.className || '').match(/rated-(\d+)/);
      return { slug: item.dataset.itemSlug, name: item.dataset.itemName || item.dataset.itemSlug, rating: m ? parseInt(m[1], 10) / 2 : null };
    }).filter(Boolean);
  }
  const parseGridRatings = (doc) => parseGridFilms(doc).filter((f) => f.rating != null);

  function parseSimilar(doc, selfSlug) {
    const seen = new Set([selfSlug]);
    return [...doc.querySelectorAll('.griditem [data-item-slug], li.poster-container [data-item-slug]')]
      .map((e) => ({ slug: e.dataset.itemSlug, name: e.dataset.itemName || e.dataset.itemSlug }))
      .filter((f) => f.slug && !seen.has(f.slug) && seen.add(f.slug));
  }

  // Everything about a film that a person's taste can be measured against.
  // Each facet's `path` is a filter that also works on a user's films:
  // /<user>/films/<path>/ (mini-themes don't, so they're skipped).
  function parseFacets(doc) {
    const facets = [];
    const seen = new Set();
    const add = (type, path, label) => {
      if (!path || path.endsWith('/') || seen.has(path)) return;
      seen.add(path);
      facets.push({ type, path, label });
    };
    const after = (href, seg) => ((href || '').split(`/${seg}/`)[1] || '').split('/')[0];
    const each = (sel, max, fn) => [...doc.querySelectorAll(sel)].slice(0, max).forEach(fn);

    each('a[href^="/director/"]', 2, (a) => add('director', `with/director/${after(a.getAttribute('href'), 'director')}`, a.textContent.trim()));
    each('#tab-panel-genres a[href^="/films/theme/"]', 2, (a) => add('theme', `theme/${after(a.getAttribute('href'), 'theme')}`, a.textContent.trim()));
    each('#tab-panel-genres a[href^="/films/genre/"]', 3, (a) => add('genre', `genre/${after(a.getAttribute('href'), 'genre')}`, a.textContent.trim()));
    const cast = doc.querySelectorAll('#tab-panel-cast a[href^="/actor/"]').length ? '#tab-panel-cast a[href^="/actor/"]' : 'a[href^="/actor/"]';
    each(cast, 3, (a) => add('actor', `with/actor/${after(a.getAttribute('href'), 'actor')}`, a.textContent.trim()));
    each('#tab-panel-details a[href^="/films/language/"]', 2, (a) => add('language', `language/${after(a.getAttribute('href'), 'language')}`, a.textContent.trim()));
    each('#tab-panel-details a[href^="/films/country/"]', 1, (a) => add('country', `country/${after(a.getAttribute('href'), 'country')}`, a.textContent.trim()));
    const year = parseInt(((doc.querySelector('meta[property="og:title"]')?.content || '').match(/\((\d{4})\)\s*$/) || [])[1], 10);
    if (year) add('decade', `decade/${Math.floor(year / 10) * 10}s`, `${Math.floor(year / 10) * 10}s`);
    return facets;
  }

  function parseFilmInfo(doc, slug) {
    const meta = (n) => doc.querySelector(`meta[name="${n}"], meta[property="${n}"]`)?.content || '';
    const avg = parseFloat(meta('twitter:data2'));
    const title = meta('og:title') || slug;
    return {
      slug,
      name: title,
      year: parseInt((title.match(/\((\d{4})\)\s*$/) || [])[1], 10) || null,
      director: meta('twitter:data1'),
      avg: Number.isFinite(avg) ? avg : NaN,
      genres: parseFilmGenres(doc),
      facets: parseFacets(doc),
    };
  }

  // kind: 'following' | 'followers'. 25 people per page.
  async function getFollowList(user, kind, max) {
    return cached(`${kind}:${user}:${max}`, DAY, async () => {
      const out = [];
      for (let p = 1; out.length < max && p <= Math.ceil(max / 25); p++) {
        const doc = await fetchDoc(`/${user}/${kind}/${p > 1 ? `page/${p}/` : ''}`);
        const batch = parseFollowing(doc);
        out.push(...batch);
        if (!batch.length || !doc.querySelector('.pagination a.next')) break;
      }
      return out.slice(0, max);
    });
  }

  // { seen: false } | { seen: true, rating: number|NaN }
  async function getUserFilmRating(user, slug) {
    return cached(`seen:${user}:${slug}`, 2 * DAY, async () => {
      const doc = await fetchDoc(`/${user}/film/${slug}/`, { allow404: true });
      if (!doc) return { seen: false };
      const label = [...doc.querySelectorAll('meta[name="twitter:data2"]')].map((m) => m.content)[0];
      const rating = parseStars(label);
      return { seen: true, rating: Number.isFinite(rating) ? rating : null };
    });
  }

  const GENRES = [
    'action', 'adventure', 'animation', 'comedy', 'crime', 'documentary', 'drama', 'family', 'fantasy',
    'history', 'horror', 'music', 'mystery', 'romance', 'science-fiction', 'thriller', 'tv-movie', 'war', 'western',
  ];
  const DECADES = ['1920s', '1930s', '1940s', '1950s', '1960s', '1970s', '1980s', '1990s', '2000s', '2010s', '2020s'];

  async function getSimilar(slug, limit = 40) {
    return cached(`similar:${slug}`, 7 * DAY, async () =>
      parseSimilar(await fetchDoc(`/film/${slug}/similar/`), slug).slice(0, limit)
    );
  }

  async function getFilmInfo(slug) {
    return cached(`film:${slug}`, 7 * DAY, async () => parseFilmInfo(await fetchDoc(`/film/${slug}/`), slug));
  }

  // Their highest-rated films (first page, up to 72).
  async function getUserTopRated(user) {
    return cached(`top:${user}`, 2 * DAY, async () => parseGridRatings(await fetchDoc(`/${user}/films/by/entry-rating/`)));
  }

  // First page (72 most recent) of a user's films matching a facet path, rated or
  // not, so it doubles as a partial "already seen" list.
  async function getUserFacet(user, path) {
    return cached(`facet:${user}:${path}`, 7 * DAY, async () => {
      try {
        const doc = await fetchDoc(`/${user}/films/${path}/`, { allow404: true });
        return doc ? parseGridFilms(doc) : [];
      } catch (_) {
        return [];
      }
    });
  }

  // Broad taste profile: every genre and decade. { 'genre/drama': [films], ... }
  async function getUserBroadProfile(user, onStep) {
    const paths = [...GENRES.map((g) => `genre/${g}`), ...DECADES.map((d) => `decade/${d}`)];
    const out = {};
    await Promise.all(paths.map(async (p) => {
      out[p] = await getUserFacet(user, p);
      onStep && onStep(paths.length);
    }));
    return out;
  }

  // Facet ratings for one person against one film's facets (+ its similar films).
  // `lean` skips the near-universal English/USA/UK facets to save requests.
  async function getUserFacetRatings(user, facets, { excludeSlug, similar = [], lean = false } = {}) {
    const wanted = facets.filter((f) => !(lean && /^(language\/english|country\/usa|country\/uk)$/.test(f.path)));
    const lists = await Promise.all(wanted.map((f) => getUserFacet(user, f.path)));
    const similarSet = new Set(similar.map((s) => s.slug));
    const seenFilms = new Map();
    const out = wanted.map((f, i) => {
      const films = lists[i].filter((x) => x.slug !== excludeSlug);
      films.forEach((x) => seenFilms.set(x.slug, x));
      const rated = films.filter((x) => x.rating != null);
      return { ...f, ratings: rated.map((x) => x.rating), films: rated };
    });
    const simRated = [...seenFilms.values()].filter((x) => x.rating != null && similarSet.has(x.slug));
    if (simRated.length) out.push({ type: 'similar', path: 'similar', label: 'similar films', ratings: simRated.map((x) => x.rating), films: simRated });
    return out;
  }

  // Everyone the user follows, with mutuals (they follow back) first.
  async function getFriends(user, maxFriends) {
    const [following, followers] = await Promise.all([
      getFollowList(user, 'following', maxFriends),
      getFollowList(user, 'followers', 500).catch(() => []),
    ]);
    const back = new Set(followers.map((f) => f.user));
    return following
      .map((f, i) => ({ ...f, mutual: back.has(f.user), order: i }))
      .sort((a, b) => b.mutual - a.mutual || a.order - b.order);
  }

  LBW.lb = {
    GENRES, DECADES,
    parseHistogram, parseWeightedAverage, parseStars, parseRatedUsers, parseReviews, parseProfile,
    detectUsername, parseFilmGenres, parseFollowing, parseGridFilms, parseGridRatings, parseSimilar, parseFacets, parseFilmInfo,
    getFilmHistogram, getUsersInBucket, getPopularReviews, getProfile,
    getFollowList, getFriends, getUserFilmRating, getSimilar, getFilmInfo, getUserTopRated,
    getUserFacet, getUserBroadProfile, getUserFacetRatings, clearCache, cached, DAY,
  };
})(globalThis);
