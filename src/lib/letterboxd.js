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
  const MAX_CONCURRENT = 4;
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

  // Film grid items carry `rated-N` where N is half-stars.
  function parseGridRatings(doc) {
    return [...doc.querySelectorAll('.griditem')].map((li) => {
      const slug = li.querySelector('[data-item-slug]')?.dataset.itemSlug;
      const m = (li.querySelector('.rating')?.className || '').match(/rated-(\d+)/);
      return slug && m ? { slug, rating: parseInt(m[1], 10) / 2 } : null;
    }).filter(Boolean);
  }

  async function getFollowing(user, maxFriends) {
    return cached(`following:${user}:${maxFriends}`, DAY, async () => {
      const out = [];
      for (let p = 1; out.length < maxFriends && p <= 20; p++) {
        const doc = await fetchDoc(`/${user}/following/${p > 1 ? `page/${p}/` : ''}`);
        const batch = parseFollowing(doc);
        out.push(...batch);
        if (!doc.querySelector('.pagination a.next')) break;
      }
      return out.slice(0, maxFriends);
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

  // The user's ratings of films in the same genre(s): the combined genres first,
  // then the primary genre alone if the combination is too thin.
  async function getUserGenreRatings(user, genres) {
    if (!genres.length) return [];
    const key = genres.slice(0, 2).join('+');
    return cached(`genre:${user}:${key}`, 7 * DAY, async () => {
      let rated = parseGridRatings(await fetchDoc(`/${user}/films/genre/${key}/`));
      if (rated.length < 10 && genres.length > 1) {
        rated = parseGridRatings(await fetchDoc(`/${user}/films/genre/${genres[0]}/`));
      }
      return rated;
    });
  }

  LBW.lb = {
    parseHistogram, parseWeightedAverage, parseStars, parseRatedUsers, parseReviews, parseProfile,
    detectUsername, parseFilmGenres, parseFollowing, parseGridRatings,
    getFilmHistogram, getUsersInBucket, getPopularReviews, getProfile,
    getFollowing, getUserFilmRating, getUserGenreRatings, clearCache, cached, DAY,
  };
})(globalThis);
