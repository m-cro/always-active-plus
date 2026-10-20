const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('popup refreshes its active state when site rules change in storage', async () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        textContent: '',
        className: '',
        disabled: false,
        hidden: true,
        listeners: new Map(),
        addEventListener(type, listener) { this.listeners.set(type, listener); },
        setAttribute(name, value) { this[name] = value; }
      });
    }
    return elements.get(id);
  };
  let storageListener;
  let enabled = true;
  const context = vm.createContext({
    chrome: {
      tabs: {query: async () => [{id: 1, url: 'https://example.com/'}]},
      runtime: {
        getURL: file => `chrome-extension://test/${file}`,
        sendMessage: async () => ({
          available: true,
          enabled,
          globallyEnabled: true,
          host: 'example.com',
          allSites: true,
          ruleCount: enabled ? 0 : 1
        }),
        openOptionsPage() {}
      },
      storage: {onChanged: {addListener(listener) { storageListener = listener; }}}
    },
    document: {getElementById: element}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../v3/data/popup/index.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(element('status').textContent, 'Active on this site');

  enabled = false;
  storageListener({hosts: {newValue: ['example.com']}}, 'local');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(element('status').textContent, 'Paused on this site');
});
