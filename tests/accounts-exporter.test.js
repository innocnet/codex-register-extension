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

test('appendAccount appends to existing list cumulatively', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await exporter.appendAccount({ email: 'a@b.com', password: 'p1' });
  await exporter.appendAccount({ email: 'c@d.com', password: 'p2' });

  assert.equal(m.storage[STORAGE_KEY].length, 2);

  const lastUrl = m.downloadCalls[1].url;
  const base64 = lastUrl.replace(/^data:text\/plain;charset=utf-8;base64,/, '');
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  assert.equal(decoded, 'a@b.com----p1\nc@d.com----p2\n');
});

test('reexportAll writes complete file based on storage', async () => {
  const m = makeMocks({
    [STORAGE_KEY]: [
      { email: 'x@y.com', password: 'a' },
      { email: 'y@z.com', password: 'b' },
    ],
  });
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await exporter.reexportAll();

  const base64 = m.downloadCalls[0].url.replace(/^data:text\/plain;charset=utf-8;base64,/, '');
  const decoded = Buffer.from(base64, 'base64').toString('utf-8');
  assert.equal(decoded, 'x@y.com----a\ny@z.com----b\n');
});

test('listAccounts returns [] when storage is empty', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  assert.deepEqual(await exporter.listAccounts(), []);
});

test('appendAccount rejects missing fields', async () => {
  const m = makeMocks();
  const exporter = createAccountsExporter({ chromeStorage: m.chromeStorage, chromeDownloads: m.chromeDownloads });
  await assert.rejects(() => exporter.appendAccount({ email: '', password: 'p' }));
  await assert.rejects(() => exporter.appendAccount({ email: 'a@b.com', password: '' }));
});
