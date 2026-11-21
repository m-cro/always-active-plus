const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('mouse sliders save their values without Save Options', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        listeners: new Map(),
        addEventListener(type, listener) { this.listeners.set(type, listener); }
      });
    }
    return elements.get(id);
  };
  const writes = [];
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    chrome: {storage: {
      local: {
        get() {},
        set(value) { writes.push(value); }
      },
      onChanged: {addListener() {}}
    }},
    document: {
      getElementById: element,
      addEventListener() {}
    },
    window: {},
    setTimeout(callback) {
      timers.set(++timerId, callback);
      return timerId;
    },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../v3/data/options/index.js'), 'utf8'), context);
  const humanize = element('mouseHumanize');
  humanize.value = '0.5';
  humanize.listeners.get('input')();
  for (const callback of timers.values()) callback();
  assert.equal(writes[0].mouseHumanize, 50);

  const slider = element('mouseInterpolation');
  slider.value = '0.82';
  slider.listeners.get('input')();
  assert.equal(element('mouseInterpolationValue').value, '0.82');
  assert.equal(writes.length, 1);
  for (const callback of timers.values()) callback();
  assert.equal(writes.at(-1).mouseInterpolation, 0.82);
  slider.value = '0.91';
  slider.listeners.get('input')();
  slider.listeners.get('change')();
  assert.equal(writes.at(-1).mouseInterpolation, 0.91);
});

test('factory reset needs a second activation, including from the keyboard', () => {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '',
        textContent: '',
        listeners: new Map(),
        addEventListener(type, listener) { this.listeners.set(type, listener); }
      });
    }
    return elements.get(id);
  };
  let cleared = 0;
  const context = vm.createContext({
    chrome: {
      runtime: {reload() {}},
      storage: {
        local: {
          get() {},
          set() {},
          clear(callback) { cleared++; callback(); }
        },
        onChanged: {addListener() {}}
      }
    },
    document: {getElementById: element, addEventListener() {}},
    localStorage: {clear() {}},
    window: {close() {}},
    setTimeout: () => 0,
    clearTimeout() {}
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../v3/data/options/index.js'), 'utf8'), context);

  // Keyboard activation reports detail 0, which must not skip the confirmation.
  const reset = element('reset').listeners.get('click');
  reset({detail: 0});
  assert.equal(cleared, 0);
  assert.match(element('toast').textContent, /again to confirm/);
  reset({detail: 0});
  assert.equal(cleared, 1);
});
