const hostname = document.getElementById('hostname');
const power = document.getElementById('power');
const buttonLabel = document.getElementById('button-label');
const status = document.getElementById('status');
const hint = document.getElementById('hint');
const scope = document.getElementById('scope');
const modeSummary = document.getElementById('mode-summary');
const liveDot = document.getElementById('live-dot');
const error = document.getElementById('error');

let activeTab;
let siteState;
let updatingSiteRule = false;
let refreshAfterUpdate = false;

const showError = message => {
  error.textContent = message;
  error.hidden = false;
};

const render = state => {
  siteState = state;
  if (!state.available) {
    hostname.textContent = 'Unsupported page';
    scope.textContent = 'N/A';
    status.textContent = 'No site controls here';
    hint.textContent = 'Open a regular website to use this switch.';
    modeSummary.textContent = 'Browser pages cannot be controlled';
    power.disabled = true;
    return;
  }

  hostname.textContent = state.testLab ? state.labName : state.host;
  scope.textContent = state.testLab ? 'TEST LAB' : state.allSites ? 'ALL SITES' : 'ALLOW LIST';
  modeSummary.textContent = state.testLab ? 'Local protection simulation' : state.allSites ?
    `${state.ruleCount} site ${state.ruleCount === 1 ? 'exception' : 'exceptions'}` :
    `${state.ruleCount} allowed ${state.ruleCount === 1 ? 'site' : 'sites'}`;
  liveDot.className = `live-dot ${state.enabled ? 'on' : 'off'}`;
  power.disabled = !state.globallyEnabled;
  power.setAttribute('aria-pressed', String(state.enabled));
  buttonLabel.textContent = state.enabled ?
    `Turn off protection for ${state.testLab ? 'the test lab' : state.host}` :
    `Turn on protection for ${state.testLab ? 'the test lab' : state.host}`;

  if (!state.globallyEnabled) {
    status.textContent = 'Extension paused';
    hint.textContent = 'Protection is disabled globally.';
  }
  else if (state.enabled) {
    status.textContent = 'Active on this site';
    hint.textContent = 'Protection applies to this tab immediately. Click to pause it.';
  }
  else {
    status.textContent = 'Paused on this site';
    hint.textContent = 'Protection is off in this tab. Click to resume it immediately.';
  }
};

const getTab = async () => {
  [activeTab] = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!activeTab) {
    render({available: false});
    return;
  }
  const labs = [
    ['data/test/index.html', 'Protection Test']
  ];
  const labFromUrl = activeTab.url && labs.find(([path]) =>
    activeTab.url.startsWith(chrome.runtime.getURL(path)));
  if (labFromUrl || !activeTab.url) {
    const prefs = await chrome.storage.local.get({enabled: true, testLabEnabled: null, testLabTabs: {}});
    const labName = labFromUrl?.[1] || prefs.testLabTabs?.[String(activeTab.id)];
    if (labName) {
      render({
        available: true,
        testLab: true,
        labName,
        enabled: prefs.testLabEnabled ?? prefs.enabled,
        globallyEnabled: true,
        host: labName,
        allSites: true,
        ruleCount: 0
      });
      return;
    }
  }
  if (!activeTab.url) {
    render({available: false});
    return;
  }
  const state = await chrome.runtime.sendMessage({method: 'site-state', url: activeTab.url});
  if (state?.available) {
    render(state);
    return;
  }
  render({available: false});
};

const refreshFromStorage = () => {
  if (updatingSiteRule) {
    refreshAfterUpdate = true;
    return;
  }
  getTab().catch(() => render({available: false}));
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.enabled || changes.allSites || changes.hosts || changes.testLabEnabled || changes.testLabTabs)) {
    refreshFromStorage();
  }
});

power.addEventListener('click', async () => {
  if (updatingSiteRule || !activeTab || !siteState?.available) return;
  updatingSiteRule = true;
  power.disabled = true;
  status.textContent = 'Applying site rule…';
  hint.textContent = 'Applying the change to this tab…';
  error.hidden = true;

  try {
    if (siteState.testLab) {
      const enabled = !siteState.enabled;
      await chrome.storage.local.set({testLabEnabled: enabled});
      render({...siteState, enabled});
      return;
    }
    const result = await chrome.runtime.sendMessage({
      method: 'toggle-site',
      tabId: activeTab.id,
      url: activeTab.url
    });
    if (!result?.ok) {
      showError(result?.message || 'Could not update this site.');
      await getTab();
      return;
    }

    render({...siteState, enabled: result.enabled, ruleCount: result.ruleCount});
    status.textContent = result.enabled ? 'Active on this site' : 'Paused on this site';
    hint.textContent = 'The change is active in this tab. Newly opened tabs use it too.';
  }
  catch (e) {
    showError(e.message || 'Could not update this site.');
    await getTab();
  }
  finally {
    updatingSiteRule = false;
    if (refreshAfterUpdate) {
      refreshAfterUpdate = false;
      await getTab().catch(() => render({available: false}));
    }
  }
});

document.getElementById('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

getTab().catch(() => render({available: false}));
