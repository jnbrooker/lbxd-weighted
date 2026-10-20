// Site-wide entry: adds a "Weighted" item to Letterboxd's main nav, mounts the
// top-films page at /films/#weighted, and the advanced stats panel on profiles.
(function () {
  const LBW = globalThis.LBW;
  const TOP_PATH = '/films/';
  const TOP_HASH = '#weighted';

  function addNavItem() {
    const members = document.querySelector('li.main-nav-people');
    if (!members || document.querySelector('li.main-nav-weighted')) return;
    const li = document.createElement('li');
    li.className = 'navitem main-nav-weighted';
    li.innerHTML = `<a href="${TOP_PATH}${TOP_HASH}" class="navlink" title="Top films by weighted rating (Letterboxd Weighted Stats)"><span class="label">Weighted</span></a>`;
    members.after(li);
  }

  const isTopRoute = () => location.pathname === TOP_PATH && location.hash === TOP_HASH;

  function mountTop() {
    const content = document.querySelector('#content .content-wrap') || document.querySelector('#content');
    if (!content || content.querySelector('.lbw-top')) return;
    document.title = 'Top films · weighted • Letterboxd';
    document.querySelector('li.main-nav-weighted')?.classList.add('-active');
    LBW.topPage.open(content);
  }

  addNavItem();
  if (isTopRoute()) mountTop();
  window.addEventListener('hashchange', () => {
    if (isTopRoute()) mountTop();
    else if (location.pathname === TOP_PATH && document.querySelector('.lbw-top')) location.reload();
  });

  // Profile pages: /<username>/ with a profile header.
  const parts = location.pathname.split('/').filter(Boolean);
  if (parts.length === 1 && document.querySelector('.profile-header[data-person]') && LBW.profilePage) {
    LBW.profilePage.mount(parts[0].toLowerCase());
  }
})();
