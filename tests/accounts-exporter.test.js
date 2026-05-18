// tests/accounts-exporter.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountsExporter, STORAGE_KEY } = require('../background/accounts-exporter.js');

function makeMocks(initialStorage = {}) {
  const storage = { ...initialStorage };
  const downloadCalls = [];
  return {
    chromeStorage: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (patch) => Object.assign(storage, patch),
    },
    chromeDownloads: {
      download: async (opts) => { downloadCalls.push(opts); return 1; },
    },
    storage,
    downloadCalls,
  };
}

test('appendAccount stores record and triggers download with overwrite', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await exporter.appendAccount({ email: 'a@b.com', password: 'pw' });

  assert.equal(m.storage[STORAGE_KEY].length, 1);
  assert.equal(m.storage[STORAGE_KEY][0].email, 'a@b.com');
  assert.equal(m.downloadCalls.length, 1);
  assert.equal(m.downloadCalls[0].filename, 'accounts.txt');
  assert.equal(m.downloadCalls[0].conflictAction, 'overwrite');
  assert.match(m.downloadCalls[0].url, /^data:text\/plain;charset=utf-8;base64,/);
});
