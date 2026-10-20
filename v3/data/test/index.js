const port = document.createElement('span');
port.id = 'lwys-ctv-port';
port.hidden = true;
document.documentElement.append(port);

const counts = new Map([...document.querySelectorAll('.event-row')].map(row => [row.dataset.event, 0]));
const updateCount = name => {
  const row = document.querySelector(`[data-event="${name}"] output`);
  if (!row) return;
  const count = (counts.get(name) || 0) + 1;
  counts.set(name, count);
  row.value = count;
};

const showMode = enabled => {
  port.dataset.enabled = String(enabled);
  document.getElementById('mode-label').textContent = enabled ? 'active' : 'paused';
  document.getElementById('mode-help').textContent = enabled ?
    'Hide-related events are suppressed while this test mode is active.' :
    'Page events pass through while this test mode is paused.';
  document.getElementById('test-status').textContent = enabled ?
    'Active mode set for this test page.' : 'Paused mode set for this test page.';
};

const setPreferences = prefs => {
  const booleanPrefs = ['blur', 'focus', 'keyboard', 'mouseleave', 'mouseout', 'pointercapture', 'redirect', 'visibility'];
  for (const name of booleanPrefs) port.dataset[name] = String(prefs[name] !== false);
  port.dataset.blockedKeys = (Array.isArray(prefs.blockedKeys) ? prefs.blockedKeys : ['AltGraph'])
    .map(key => String(key).trim().toLowerCase()).filter(Boolean).join('\n');
  port.dataset.blockedEvents = JSON.stringify(Array.isArray(prefs.blockedEvents) ? prefs.blockedEvents : []);
  port.dataset.blockedKeyStates = JSON.stringify(Array.isArray(prefs.blockedKeyStates) ? prefs.blockedKeyStates : []);
  port.dataset.mouseHumanize = String(prefs.mouseHumanize ?? 50);
  port.dataset.mouseInterpolation = String(prefs.mouseInterpolation ?? 0.35);
  port.dataset.mouseStartSmoothness = String(prefs.mouseStartSmoothness ?? 0.3);
  port.dataset.mouseStopSmoothness = String(prefs.mouseStopSmoothness ?? 0.3);
  showMode(prefs.testLabEnabled ?? (prefs.enabled !== false));
};

chrome.storage.local.get({
  enabled: true,
  testLabEnabled: null,
  blur: true,
  focus: true,
  keyboard: true,
  blockedKeys: ['AltGraph'],
  blockedKeyStates: [],
  blockedEvents: [],
  mouseHumanize: 50,
  mouseInterpolation: 0.35,
  mouseStartSmoothness: 0.3,
  mouseStopSmoothness: 0.3,
  mouseleave: true,
  mouseout: true,
  pointercapture: true,
  redirect: true,
  visibility: true
}, prefs => {
  setPreferences(prefs);
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('data/inject/main.js');
  script.onload = () => script.remove();
  document.head.append(script);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  chrome.storage.local.get({enabled: true, testLabEnabled: null}, prefs => {
    showMode(prefs.testLabEnabled ?? (prefs.enabled !== false));
  });
});

const chooseMode = enabled => {
  showMode(enabled);
  chrome.storage.local.set({testLabEnabled: enabled});
};
document.getElementById('active-mode').addEventListener('click', () => chooseMode(true));
document.getElementById('paused-mode').addEventListener('click', () => chooseMode(false));
document.getElementById('reset').addEventListener('click', () => {
  for (const name of counts.keys()) counts.set(name, 0);
  for (const output of document.querySelectorAll('.event-row output')) output.value = 0;
  document.getElementById('test-status').textContent = 'Event counts reset.';
});

for (const name of counts.keys()) {
  const target = name === 'mouseleave' || name === 'mouseout' ?
    document.getElementById('hover-target') : name === 'keydown' ?
      document.getElementById('probe') : name === 'pagehide' || name === 'blur' ? window : document;
  target.addEventListener(name, () => updateCount(name), true);
}

const updateReadouts = () => {
  document.getElementById('page-state').textContent = document.visibilityState;
  document.getElementById('focus-state').textContent = document.hasFocus() ? 'focused' : 'not focused';
};
updateReadouts();
document.addEventListener('visibilitychange', updateReadouts);
window.addEventListener('focus', updateReadouts);
window.addEventListener('blur', updateReadouts);
