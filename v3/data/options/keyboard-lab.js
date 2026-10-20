const eventRows = document.getElementById('events');
const eventCount = document.getElementById('event-count');
const saveStatus = document.getElementById('save-status');
const captureInput = document.getElementById('key-input');
const port = document.createElement('span');
port.id = 'lwys-ctv-port';
port.hidden = true;
document.documentElement.append(port);
const rows = new Map();
let selected = new Set();
const modifierNames = ['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'];
let blockedKeysDraft;
let sortField;
let sortDirection = 1;

const injectionDefaults = {
  enabled: true,
  keyboard: true,
  blockedKeys: ['AltGraph'],
  blockedKeyStates: [],
  blockedEvents: []
};

const updateInjection = prefs => {
  port.dataset.enabled = String(prefs.enabled !== false);
  port.dataset.keyboard = String(prefs.keyboard !== false);
  if (blockedKeysDraft === undefined) {
    port.dataset.blockedKeys = (Array.isArray(prefs.blockedKeys) ? prefs.blockedKeys : [])
      .map(key => String(key).trim().toLowerCase()).filter(Boolean).join('\n');
  }
  port.dataset.blockedEvents = JSON.stringify(Array.isArray(prefs.blockedEvents) ? prefs.blockedEvents : []);
  port.dataset.blockedKeyStates = JSON.stringify(Array.isArray(prefs.blockedKeyStates) ? prefs.blockedKeyStates : []);
};

updateInjection(injectionDefaults);

document.getElementById('blockedKeys').addEventListener('input', event => {
  blockedKeysDraft = event.target.value
    .split(/[\n,]+/)
    .map(key => key.trim().toLowerCase())
    .filter(Boolean)
    .join('\n');
  port.dataset.blockedKeys = blockedKeysDraft;
});

chrome.storage.local.get(injectionDefaults, prefs => {
  updateInjection(prefs);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  chrome.storage.local.get(injectionDefaults, prefs => {
    if (changes.blockedKeys) blockedKeysDraft = undefined;
    updateInjection(prefs);
  });
});

const signature = event => JSON.stringify([
  event.type,
  event.key,
  event.code,
  Number(event.keyCode),
  Number(event.location || 0),
  event.modifiers || []
]);

const activeModifiers = event => modifierNames.filter(name => {
  try {
    return event.getModifierState(name);
  }
  catch (error) {
    return false;
  }
});

const isBlocked = event => {
  if (port.dataset.enabled !== 'true' || port.dataset.keyboard === 'false') return false;
  const modifiers = activeModifiers(event);
  try {
    const blockedKeyStates = JSON.parse(port.dataset.blockedKeyStates || '[]');
    if (blockedKeyStates.some(rule => rule.key === String(event.key) &&
        JSON.stringify(rule.modifiers || []) === JSON.stringify(modifiers))) return true;
    const blockedEvents = JSON.parse(port.dataset.blockedEvents || '[]');
    if (blockedEvents.some(rule => rule.type === event.type &&
        rule.key === String(event.key) &&
        rule.code === String(event.code) &&
        Number(rule.keyCode) === Number(event.keyCode) &&
        Number(rule.location || 0) === Number(event.location || 0) &&
        JSON.stringify(rule.modifiers || []) === JSON.stringify(modifiers))) return true;
  }
  catch (error) {}

  const keys = new Set((port.dataset.blockedKeys || '').split('\n').filter(Boolean));
  if (keys.has(String(event.key).toLowerCase()) ||
      keys.has(String(event.code).toLowerCase()) ||
      keys.has(String(event.keyCode))) return true;

  const modifierAliases = {
    alt: ['Alt', 'altKey'],
    control: ['Control', 'ctrlKey'],
    ctrl: ['Control', 'ctrlKey'],
    meta: ['Meta', 'metaKey'],
    shift: ['Shift', 'shiftKey'],
    altgraph: ['AltGraph', 'altGraphKey']
  };
  const hasModifier = name => {
    const [stateName, property] = modifierAliases[name] || [];
    if (!stateName) return false;
    try {
      if (event.getModifierState?.(stateName)) return true;
    }
    catch (error) {}
    return Boolean(event[property]);
  };
  for (const key of keys) {
    if (key.includes('@')) {
      const separator = key.lastIndexOf('@');
      try {
        const keyName = decodeURIComponent(key.slice(0, separator));
        const state = key.slice(separator + 1);
        const expected = state === 'none' ? [] : [...new Set(state.split('+').map(name => name.trim() === 'ctrl' ? 'control' : name.trim()))].sort();
        const active = ['alt', 'altgraph', 'control', 'meta', 'shift'].filter(hasModifier).sort();
        if (keyName === String(event.key).toLowerCase() && JSON.stringify(expected) === JSON.stringify(active)) return true;
      }
      catch (error) {}
      continue;
    }
    const chord = key.toLowerCase().split('+').map(part => part.trim());
    if (chord.length > 1 && chord.every(part => modifierAliases[part]) && chord.every(hasModifier)) return true;
    if (chord.length === 1 && modifierAliases[chord[0]] && hasModifier(chord[0])) return true;
  }
  try {
    return keys.has('altgraph') && Boolean(event.getModifierState?.('AltGraph'));
  }
  catch (error) {
    return false;
  }
};

const capture = event => {
  if (event.target !== captureInput || !['keydown', 'keypress', 'keyup'].includes(event.type)) return;
  if (isBlocked(event)) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    return;
  }
  const rule = {
    type: event.type,
    key: String(event.key),
    code: String(event.code),
    keyCode: Number(event.keyCode),
    location: Number(event.location || 0),
    modifiers: activeModifiers(event)
  };
  const id = signature(rule);
  let current = rows.get(id);
  if (current) {
    current.seen += 1;
    current.repeat ||= event.repeat;
  }
  else {
    current = {rule, seen: 1, repeat: Boolean(event.repeat)};
    rows.set(id, current);
  }
  renderRows();
};

const renderRows = () => {
  eventCount.textContent = rows.size;
  if (!rows.size) {
    eventRows.innerHTML = '<tr class="keyboard-empty-row"><td colspan="9">No events captured yet. Try a key in the field above.</td></tr>';
    return;
  }
  const orderedRows = [...rows.entries()];
  if (sortField) {
    orderedRows.sort(([, left], [, right]) => {
      let a;
      let b;
      if (sortField === 'seen' || sortField === 'keyCode' || sortField === 'location') {
        a = sortField === 'seen' ? left.seen : Number(left.rule[sortField] || 0);
        b = sortField === 'seen' ? right.seen : Number(right.rule[sortField] || 0);
        return (a - b) * sortDirection;
      }
      if (sortField === 'repeat') {
        return (Number(left.repeat) - Number(right.repeat)) * sortDirection;
      }
      a = sortField === 'modifiers' ? (left.rule.modifiers || []).join(', ') : left.rule[sortField];
      b = sortField === 'modifiers' ? (right.rule.modifiers || []).join(', ') : right.rule[sortField];
      return String(a).localeCompare(String(b), undefined, {sensitivity: 'base'}) * sortDirection;
    });
  }
  eventRows.replaceChildren(...orderedRows.map(([id, item]) => {
    const row = document.createElement('tr');
    const checkCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(id);
    checkbox.setAttribute('aria-label', `Block ${item.rule.type} ${item.rule.key}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(id);
      else selected.delete(id);
    });
    checkCell.append(checkbox);
    row.append(checkCell);
    const values = [
      ['keyboard-event-type', item.rule.type],
      ['', item.rule.key],
      ['', item.rule.code],
      ['', item.rule.keyCode],
      ['', ['Standard', 'Left', 'Right', 'Numpad'][item.rule.location || 0] || item.rule.location || 0],
      ['', (item.rule.modifiers || []).join(', ') || '—'],
      ['', item.repeat ? 'yes' : 'no'],
      ['', item.seen]
    ];
    for (const [className, value] of values) {
      const cell = document.createElement('td');
      if (className) cell.className = className;
      const code = document.createElement('code');
      code.textContent = value;
      cell.append(code);
      row.append(cell);
    }
    return row;
  }));
};

for (const button of document.querySelectorAll('[data-sort]')) {
  button.addEventListener('click', () => {
    const field = button.dataset.sort;
    if (sortField === field) sortDirection *= -1;
    else {
      sortField = field;
      sortDirection = 1;
    }
    for (const header of document.querySelectorAll('th[aria-sort]')) {
      const active = header.querySelector('[data-sort]') === button;
      header.setAttribute('aria-sort', active ?
        (sortDirection === 1 ? 'ascending' : 'descending') : 'none');
    }
    renderRows();
  });
}

chrome.storage.local.get({blockedEvents: []}, prefs => {
  for (const rule of Array.isArray(prefs.blockedEvents) ? prefs.blockedEvents : []) {
    const id = signature(rule);
    if (!rows.has(id)) rows.set(id, {rule, seen: 0, repeat: false});
    selected.add(id);
  }
  renderRows();
});

window.addEventListener('keydown', capture, true);
window.addEventListener('keypress', capture, true);
window.addEventListener('keyup', capture, true);

document.getElementById('clear-events').addEventListener('click', () => {
  for (const [id, item] of rows) {
    if (item.seen > 0) {
      rows.delete(id);
      selected.delete(id);
    }
  }
  renderRows();
  saveStatus.textContent = 'Captured rows cleared. Saved rules remain selected.';
});

document.getElementById('save-events').addEventListener('click', async () => {
  const blockedEvents = [...selected].map(id => rows.get(id)?.rule).filter(Boolean);
  await chrome.storage.local.set({blockedEvents});
  saveStatus.textContent = `${blockedEvents.length} keyboard event${blockedEvents.length === 1 ? '' : 's'} saved.`;
});

const addBlockedKeys = async values => {
  const additions = values.map(value => String(value || '').trim()).filter(Boolean);
  if (!additions.length) {
    saveStatus.textContent = 'Select a captured row with a key value first.';
    return;
  }
  const prefs = await chrome.storage.local.get({blockedKeys: []});
  const existing = Array.isArray(prefs.blockedKeys) ? prefs.blockedKeys : [];
  const editorValues = document.getElementById('blockedKeys').value.split(/[\n,]+/);
  const byLowercase = new Map([...existing, ...editorValues, ...additions]
    .map(value => String(value).trim())
    .filter(Boolean)
    .map(value => [value.toLowerCase(), value]));
  const blockedKeys = [...byLowercase.values()];
  await chrome.storage.local.set({blockedKeys});
  document.getElementById('blockedKeys').value = blockedKeys.join(', ');
  blockedKeysDraft = undefined;
  port.dataset.blockedKeys = blockedKeys.map(key => key.toLowerCase()).join('\n');
  saveStatus.textContent = `${additions.length} key filter${additions.length === 1 ? '' : 's'} saved.`;
};

document.getElementById('block-keys').addEventListener('click', () => {
  const keys = [...selected].map(id => rows.get(id)?.rule.key).filter(Boolean);
  addBlockedKeys(keys);
});

document.getElementById('block-combinations').addEventListener('click', () => {
  const combinations = [...selected]
    .map(id => rows.get(id)?.rule.modifiers || [])
    .filter(modifiers => modifiers.length)
    .map(modifiers => modifiers.join('+'));
  addBlockedKeys(combinations);
});

document.getElementById('block-key-states').addEventListener('click', () => {
  const values = [...selected]
    .map(id => rows.get(id)?.rule)
    .filter(Boolean)
    .map(rule => `${encodeURIComponent(rule.key)}@${(rule.modifiers || []).join('+') || 'none'}`);
  addBlockedKeys(values);
});
