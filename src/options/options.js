const DEFAULTS = { sampleSize: 120, zThreshold: 2, reviewPages: 2, profileTtlDays: 14, autoRun: true, username: '', maxFriends: 40, friends: true };
const $ = (id) => document.getElementById(id);
const flash = (msg) => { $('status').textContent = msg; setTimeout(() => ($('status').textContent = ''), 1800); };

chrome.storage.sync.get(DEFAULTS).then((s) => {
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'boolean') $(k).checked = s[k];
    else $(k).value = s[k];
  }
});

$('save').addEventListener('click', async () => {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const t = typeof DEFAULTS[k];
    out[k] = t === 'boolean' ? $(k).checked : t === 'string' ? $(k).value.trim().replace(/^@/, '') : (Number.isFinite(parseFloat($(k).value)) ? parseFloat($(k).value) : DEFAULTS[k]);
  }
  await chrome.storage.sync.set(out);
  flash('Saved');
});

$('clear').addEventListener('click', async () => {
  await chrome.storage.local.clear();
  flash('Cache cleared');
});
