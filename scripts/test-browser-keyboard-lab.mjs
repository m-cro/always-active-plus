#!/usr/bin/env node

import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
execFileSync(process.execPath, [join(root, 'scripts/build-chrome.mjs')]);
const profile = mkdtempSync(join(tmpdir(), 'always-active-keyboard-'));
const browser = spawn(process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-extension-debugging', '--remote-debugging-pipe',
  `--user-data-dir=${profile}`
], {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
let nextId = 0;
let buffer = '';
let sessionId;
const pending = new Map();
const errors = [];
const timeout = setTimeout(() => browser.kill(), 30000);
browser.stdio[4].on('data', data => {
  buffer += data.toString();
  let boundary;
  while ((boundary = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, boundary));
    buffer = buffer.slice(boundary + 1);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
  }
});
const send = (method, params = {}, browserCommand = false) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, message => message.error ? reject(Error(message.error.message)) : resolve(message.result));
  browser.stdio[3].write(JSON.stringify({id, method, params,
    ...(!browserCommand && sessionId ? {sessionId} : {})}) + '\0');
});
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true});
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const waitFor = async expression => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error('Timed out waiting for: ' + expression);
};
const prepare = keys => evaluate(`(() => {
  const editor = document.getElementById('blockedKeys');
  editor.value = ${JSON.stringify(keys)};
  editor.dispatchEvent(new Event('input', {bubbles: true}));
  document.getElementById('clear-events').click();
  const field = document.getElementById('key-input');
  field.value = '';
  field.focus();
})()`);
const press = async (key, code, keyCode, text = '', modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', {type, key, code, windowsVirtualKeyCode: keyCode,
      modifiers, ...(type === 'keyDown' && text ? {text} : {})});
  }
};
const observed = () => evaluate(`({
  value: document.getElementById('key-input').value,
  keys: [...document.querySelectorAll('#events tr')]
    .filter(row => row.querySelector('input'))
    .map(row => row.cells[2].textContent)
})`);
const assertBlocked = async label => {
  assert.deepEqual(await observed(), {value: '', keys: []}, label);
};

try {
  const {id: extensionId} = await send('Extensions.loadUnpacked', {path: join(root, 'dist/chrome')}, true);
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'}, true);
  ({sessionId} = await send('Target.attachToTarget', {targetId, flatten: true}, true));
  await send('Runtime.enable');
  const url = `chrome-extension://${extensionId}/data/options/index.html`;
  await send('Page.navigate', {url});
  await waitFor("document.readyState === 'complete' && Boolean(document.getElementById('lwys-ctv-port')?.dataset.blockedKeys)");

  await prepare('a');
  await press('a', 'KeyA', 65, 'a');
  await assertBlocked('Live key values must prevent typing and keep blocked events out of the table');
  await press('b', 'KeyB', 66, 'b');
  const passed = await observed();
  assert.equal(passed.value, 'b');
  assert.ok(passed.keys.length > 0 && passed.keys.every(key => key === 'b'), 'Unblocked events must remain observable');

  for (const rule of ['KeyA', '65']) {
    await prepare(rule);
    await press('a', 'KeyA', 65, 'a');
    await assertBlocked('Code and numeric key rules: ' + rule);
  }
  for (const rule of ['Shift', 'Alt+Shift']) {
    await prepare(rule);
    await press('A', 'KeyA', 65, 'A', rule === 'Shift' ? 8 : 9);
    await assertBlocked('Modifier rules must filter events while held: ' + rule);
  }

  await evaluate("chrome.storage.local.set({blockedKeys: ['a']})");
  const previousDocument = await evaluate('performance.timeOrigin');
  await send('Page.navigate', {url});
  await waitFor(`performance.timeOrigin !== ${previousDocument} && document.readyState === 'complete' && document.getElementById('lwys-ctv-port')?.dataset.blockedKeys === 'a'`);
  await evaluate("document.getElementById('key-input').focus()");
  await press('a', 'KeyA', 65, 'a');
  await assertBlocked('Saved rules must still filter events after reopening options');

  await prepare('');
  await evaluate("chrome.storage.local.set({blockedKeys: [], blockedKeyStates: []})");
  await waitFor("document.getElementById('lwys-ctv-port').dataset.blockedKeys === ''");
  await press('Shift', 'ShiftLeft', 16, '', 9);
  await evaluate(`document.querySelectorAll('#events input').forEach(input => input.click());
    document.getElementById('block-key-states').click()`);
  await waitFor("document.getElementById('blockedKeys').value.includes('Shift@Alt+Shift')");
  assert.equal(await evaluate("document.getElementById('blockedKeys').value"), 'Shift@Alt+Shift',
    'The button must deduplicate key states directly in Blocked key values');
  await prepare('Shift@Alt+Shift');
  await press('Shift', 'ShiftLeft', 16, '', 9);
  await assertBlocked('Key and modifier state entries must filter matching events');
  await press('Shift', 'ShiftLeft', 16, '', 8);
  assert.ok((await observed()).keys.includes('Shift'), 'A different modifier state must remain observable');

  const beforeReload = await evaluate('performance.timeOrigin');
  await send('Page.navigate', {url});
  await waitFor(`performance.timeOrigin !== ${beforeReload} && document.readyState === 'complete' && document.getElementById('blockedKeys')?.value.includes('Shift@Alt+Shift')`);
  await prepare('');
  await press('Shift', 'ShiftLeft', 16, '', 9);
  assert.ok((await observed()).keys.includes('Shift'), 'Removing the entry must allow the key state again');

  assert.equal(await evaluate("document.getElementById('autoSave').checked"), true, 'Auto save must be enabled by default');
  await evaluate("document.getElementById('log').click()");
  await waitFor("chrome.storage.local.get({log: false}).then(prefs => prefs.log === true)");
  await evaluate("document.getElementById('autoSave').click()");
  await waitFor("chrome.storage.local.get({autoSave: true}).then(prefs => prefs.autoSave === false)");
  await evaluate("document.getElementById('log').click(); new Promise(resolve => setTimeout(resolve, 600))");
  assert.equal(await evaluate("chrome.storage.local.get({log: false}).then(prefs => prefs.log)"), true,
    'Disabling auto save must leave edits unsaved');
  await evaluate("document.getElementById('save').click()");
  await waitFor("chrome.storage.local.get({log: true}).then(prefs => prefs.log === false)");

  assert.deepEqual(errors, [], 'Options must load and handle keyboard input without runtime errors');
  console.log('Keyboard lab browser checks passed: live and saved keys, codes, keyCodes, modifiers, state rules, and unblocked input.');
}
finally {
  clearTimeout(timeout);
  const exited = new Promise(resolve => browser.once('exit', resolve));
  browser.kill();
  if (browser.exitCode === null) await exited;
  rmSync(profile, {recursive: true, force: true});
}
