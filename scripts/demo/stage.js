// Demo stage controller (runs as an extension page — MV3 CSP forbids inline
// scripts, hence this file). Reads its layout from query params:
//   ?web=<url-or-relative>   the "website" iframe (e.g. the fixture article,
//                            or workspace.html#models for console scenes)
//   &panel=1                 show the live side-panel iframe on the right
//   &title=<tab title>       label for the active fake tab
//
// Because this page is an extension page, it can read chrome.tabs and mirror
// the REAL open tabs into the fake tab strip — so when the agent opens pages
// into a tab group during a scene, the viewer sees tabs appear.

const params = new URLSearchParams(location.search);
const webSrc = params.get('web') ?? 'about:blank';
const showPanel = params.get('panel') === '1';
const title = params.get('title') ?? 'New tab';

document.getElementById('web-frame').src = webSrc;
document.getElementById('url').textContent = decodeURIComponent(
  webSrc.startsWith('http') ? webSrc : `chrome-extension://…/${webSrc}`,
);
if (!showPanel) document.body.classList.add('nopanel');
else document.getElementById('panel-frame').src = 'sidebar.html';

const strip = document.getElementById('tabstrip');

function renderTabs(extra) {
  strip.textContent = '';
  const mk = (label, active) => {
    const el = document.createElement('span');
    el.className = active ? 'tab active' : 'tab';
    const fav = document.createElement('span');
    fav.className = 'fav';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = label;
    el.append(fav, t);
    strip.appendChild(el);
  };
  mk(title, true);
  for (const label of extra) mk(label, false);
}

async function refreshTabs() {
  let extra = [];
  try {
    const tabs = await chrome.tabs.query({});
    extra = tabs
      .filter((t) => /^https?:/.test(t.url ?? '') && t.title)
      .map((t) => t.title)
      .slice(0, 4);
  } catch {
    // tabs API unavailable — keep just the active fake tab.
  }
  renderTabs(extra);
}

renderTabs([]);
refreshTabs();
setInterval(refreshTabs, 700);
