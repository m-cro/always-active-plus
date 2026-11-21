const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const hook = () => ({
  listeners: [],
  addListener(listener) {
    this.listeners.push(listener);
  }
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const normalize = value => JSON.parse(JSON.stringify(value));

const loadWorker = (initialPrefs, openTabs = [{id: 1}]) => {
  const prefs = {...initialPrefs};
  const toolbar = new Map();
  const tabOnActivated = hook();
  const tabOnUpdated = hook();
  const registrations = [];
  const storageWrites = [];
  const onStartup = hook();
  const onInstalled = hook();
  const onChanged = hook();
  const onMessage = hook();
  const reloadedTabs = [];
  const executedScripts = [];

  const chrome = {
    action: {
      setBadgeText({tabId, text}) { toolbar.set(tabId, {...toolbar.get(tabId), text}); },
      setBadgeBackgroundColor({tabId, color}) { toolbar.set(tabId, {...toolbar.get(tabId), color}); },
      setIcon() {},
      setTitle({tabId, title}) { toolbar.set(tabId, {...toolbar.get(tabId), title}); }
    },
    management: {},
    runtime: {
      getManifest: () => ({}),
      onInstalled,
      onMessage,
      onStartup,
      setUninstallURL() {}
    },
    scripting: {
      async executeScript(details) {
        executedScripts.push(details);
        return [{frameId: 0, result: 'example.com'}];
      },
      async registerContentScripts(scripts) {
        registrations.push(scripts);
      },
      async unregisterContentScripts() {}
    },
    storage: {
      local: {
        get(defaults, callback) {
          callback({...defaults, ...prefs});
        },
        async set(values, callback) {
          const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, {
            oldValue: prefs[key],
            newValue: value
          }]));
          Object.assign(prefs, values);
          storageWrites.push(values);
          for (const listener of onChanged.listeners) listener(changes, 'local');
          callback?.();
        }
      },
      onChanged
    },
    tabs: {
      query: async () => openTabs,
      get: async id => openTabs.find(tab => tab.id === id),
      onActivated: tabOnActivated,
      onUpdated: tabOnUpdated,
      reload(tabId) {
        reloadedTabs.push(tabId);
      }
    },
    windows: {}
  };

  const context = vm.createContext({
    URL,
    chrome,
    console,
    navigator: {webdriver: true},
    setTimeout: callback => callback()
  });
  const source = fs.readFileSync(
    path.join(__dirname, '../v3/worker.js'),
    'utf8'
  );
  vm.runInContext(source, context);

  return {
    hooks: {onChanged, onMessage, onStartup, tabOnActivated, tabOnUpdated},
    toolbar,
    prefs,
    registrations,
    storageWrites,
    reloadedTabs,
    executedScripts,
    message(request) {
      return new Promise(resolve => onMessage.listeners[0](request, {}, resolve));
    }
  };
};

test('all-sites mode registers every URL with hostname exceptions', async () => {
  const worker = loadWorker({
    allSites: true,
    enabled: true,
    hosts: ['example.com', '*.internal.test']
  });

  worker.hooks.onStartup.listeners[0]();
  await flush();

  const [main, isolated] = worker.registrations.at(-1);
  assert.deepEqual(normalize(main.matches), ['*://*/*']);
  assert.deepEqual(normalize(main.excludeMatches), [
    '*://example.com/*',
    '*://*.internal.test/*'
  ]);
  assert.deepEqual(normalize(isolated.excludeMatches), normalize(main.excludeMatches));
});

test('new installations register every URL by default', async () => {
  const worker = loadWorker({});

  worker.hooks.onStartup.listeners[0]();
  await flush();

  const [main, isolated] = worker.registrations.at(-1);
  assert.deepEqual(normalize(main.matches), ['*://*/*']);
  assert.deepEqual(normalize(isolated.matches), ['*://*/*']);
});

test('legacy wildcard storage enables all sites without reinterpreting old entries', async () => {
  const worker = loadWorker({
    allSites: false,
    enabled: true,
    hosts: ['*', 'example.com']
  });

  worker.hooks.onStartup.listeners[0]();
  await flush();

  const [main] = worker.registrations.at(-1);
  assert.deepEqual(normalize(main.matches), ['*://*/*']);
  assert.equal(main.excludeMatches, undefined);
});

test('changing the all-sites preference refreshes registrations', async () => {
  const worker = loadWorker({allSites: true, enabled: true, hosts: []});

  worker.hooks.onChanged.listeners[0]({allSites: {newValue: true}});
  await flush();

  assert.equal(worker.registrations.length, 1);
  assert.deepEqual(normalize(worker.registrations[0][0].matches), ['*://*/*']);
});

test('popup toggle adds and removes exceptions in all-sites mode', async () => {
  const worker = loadWorker({allSites: true, hosts: []});
  const request = {method: 'toggle-site', tabId: 1, url: 'https://example.com/'};

  assert.deepEqual(normalize(await worker.message(request)), {
    ok: true,
    enabled: false,
    host: 'example.com',
    allSites: true,
    ruleCount: 1
  });
  assert.deepEqual(normalize(worker.storageWrites.at(-1)), {
    allSites: true,
    hosts: ['example.com']
  });
  assert.deepEqual(worker.reloadedTabs, []);
  assert.equal(worker.executedScripts.length, 1);

  assert.equal((await worker.message(request)).enabled, true);
  assert.equal(worker.executedScripts.length, 4);
  assert.deepEqual(normalize(worker.storageWrites.at(-1)), {
    allSites: true,
    hosts: []
  });
});

test('popup reads current site state from the active mode and host rules', async () => {
  const worker = loadWorker({
    allSites: false,
    enabled: true,
    hosts: ['*.example.com']
  });

  assert.deepEqual(normalize(await worker.message({
    method: 'site-state',
    url: 'https://docs.example.com/article'
  })), {
    available: true,
    enabled: true,
    globallyEnabled: true,
    host: 'docs.example.com',
    allSites: false,
    ruleCount: 1
  });
});

test('popup toggle migrates legacy wildcard storage before adding an exception', async () => {
  const worker = loadWorker({
    allSites: false,
    hosts: ['*', 'old-redundant-entry.test']
  });

  await worker.message({method: 'toggle-site', tabId: 1, url: 'https://example.com/'});

  assert.deepEqual(normalize(worker.storageWrites.at(-1)), {
    allSites: true,
    hosts: ['example.com']
  });
});

test('the toolbar button announces the state of each tab', async () => {
  const worker = loadWorker({allSites: true, enabled: true, hosts: ['blocked.test']}, [
    {id: 1, url: 'https://example.com/page'},
    {id: 2, url: 'https://blocked.test/'},
    {id: 3, url: 'about:blank'}
  ]);

  worker.hooks.onStartup.listeners.at(-1)();
  await flush();

  const [on, off, unsupported] = [1, 2, 3].map(id => normalize(worker.toolbar.get(id)));
  assert.equal(on.text, 'ON');
  assert.match(on.title, /^Enabled\. example\.com stays active/);
  assert.equal(off.text, 'OFF');
  assert.match(off.title, /^Not enabled\. blocked\.test is not kept active/);
  assert.notDeepEqual(on.color, off.color);
  assert.equal(unsupported.text, '');
  assert.match(unsupported.title, /cannot control this page/);
});

test('the toolbar button follows allow-list mode, global pause and rule changes', async () => {
  const worker = loadWorker({allSites: false, enabled: true, hosts: ['example.com']}, [
    {id: 1, url: 'https://example.com/'},
    {id: 2, url: 'https://other.test/'}
  ]);

  worker.hooks.onStartup.listeners.at(-1)();
  await flush();
  assert.deepEqual([1, 2].map(id => worker.toolbar.get(id).text), ['ON', 'OFF']);

  worker.prefs.enabled = false;
  worker.hooks.onChanged.listeners.at(-1)({enabled: {newValue: false}});
  await flush();
  assert.deepEqual([1, 2].map(id => worker.toolbar.get(id).text), ['OFF', 'OFF']);
  assert.match(worker.toolbar.get(1).title, /is paused/);

  worker.prefs.enabled = true;
  worker.prefs.hosts = ['other.test'];
  worker.hooks.onChanged.listeners.at(-1)({hosts: {newValue: ['other.test']}});
  await flush();
  assert.deepEqual([1, 2].map(id => worker.toolbar.get(id).text), ['OFF', 'ON']);
});

test('the toolbar button is repainted when a tab is activated or navigates', async () => {
  const worker = loadWorker({allSites: true, enabled: true, hosts: []}, [
    {id: 5, url: 'https://example.com/'}
  ]);

  worker.hooks.tabOnActivated.listeners[0]({tabId: 5});
  await flush();
  assert.equal(worker.toolbar.get(5).text, 'ON');

  worker.toolbar.delete(5);
  worker.hooks.tabOnUpdated.listeners[0](5, {status: 'loading'}, {id: 5, url: 'https://example.com/'});
  await flush();
  assert.equal(worker.toolbar.get(5).text, 'ON');

  worker.toolbar.delete(5);
  worker.hooks.tabOnUpdated.listeners[0](5, {title: 'unrelated'}, {id: 5, url: 'https://example.com/'});
  await flush();
  assert.equal(worker.toolbar.has(5), false);
});

test('the badge text can be turned off while the accessible title stays', async () => {
  const worker = loadWorker({allSites: true, enabled: true, hosts: [], badge: false}, [
    {id: 1, url: 'https://example.com/'}
  ]);

  worker.hooks.onStartup.listeners.at(-1)();
  await flush();

  assert.equal(worker.toolbar.get(1).text, '');
  assert.match(worker.toolbar.get(1).title, /^Enabled\./);
});
