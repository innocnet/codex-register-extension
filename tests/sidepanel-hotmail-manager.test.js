const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('sidepanel loads hotmail manager before sidepanel bootstrap', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  const hotmailManagerIndex = html.indexOf('<script src="hotmail-manager.js"></script>');
  const sidepanelIndex = html.indexOf('<script src="sidepanel.js"></script>');

  assert.notEqual(hotmailManagerIndex, -1);
  assert.notEqual(sidepanelIndex, -1);
  assert.ok(hotmailManagerIndex < sidepanelIndex);
});

test('hotmail manager exposes a factory and renders empty state', () => {
  const source = fs.readFileSync('sidepanel/hotmail-manager.js', 'utf8');
  const windowObject = {};
  const localStorageMock = {
    getItem() {
      return null;
    },
    setItem() {},
  };

  const api = new Function('window', 'localStorage', `${source}; return window.SidepanelHotmailManager;`)(
    windowObject,
    localStorageMock
  );

  assert.equal(typeof api?.createHotmailManager, 'function');

  const hotmailAccountsList = { innerHTML: '' };
  const toggleButton = {
    textContent: '',
    disabled: false,
    setAttribute() {},
  };
  const noopClassList = { toggle() {} };

  const manager = api.createHotmailManager({
    state: {
      getLatestState: () => ({ currentHotmailAccountId: null }),
      syncLatestState() {},
    },
    dom: {
      btnClearUsedHotmailAccounts: { textContent: '', disabled: false },
      btnDeleteAllHotmailAccounts: { textContent: '', disabled: false },
      btnToggleHotmailList: toggleButton,
      hotmailAccountsList,
      hotmailListShell: { classList: noopClassList },
      selectMailProvider: { value: 'hotmail-api' },
      inputEmail: { value: '' },
    },
    helpers: {
      getHotmailAccounts: () => [],
      getCurrentHotmailEmail: () => '',
      escapeHtml: (value) => String(value || ''),
      showToast() {},
      openConfirmModal: async () => true,
      copyTextToClipboard: async () => {},
    },
    runtime: {
      sendMessage: async () => ({}),
    },
    constants: {
      copyIcon: '',
      displayTimeZone: 'Asia/Shanghai',
      expandedStorageKey: 'multipage-hotmail-list-expanded',
    },
    hotmailUtils: {},
  });

  assert.equal(typeof manager.renderHotmailAccounts, 'function');
  assert.equal(typeof manager.bindHotmailEvents, 'function');
  assert.equal(typeof manager.initHotmailListExpandedState, 'function');

  manager.renderHotmailAccounts();
  assert.match(hotmailAccountsList.innerHTML, /还没有 Hotmail 账号/);
});
