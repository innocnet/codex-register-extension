// background/accounts-exporter.js
(function attachAccountsExporter(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageAccountsExporter = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createAccountsExporterModule() {
  const STORAGE_KEY = 'codexAccountsExport';
  const FILENAME = 'accounts.txt';

  function encodeContent(records) {
    const lines = records.map(r => `${r.email}----${r.password}`).join('\n');
    return lines.length ? lines + '\n' : '';
  }

  function toDataUrl(content) {
    const base64 = typeof btoa === 'function'
      ? btoa(unescape(encodeURIComponent(content)))
      : Buffer.from(content, 'utf-8').toString('base64');
    return `data:text/plain;charset=utf-8;base64,${base64}`;
  }

  function createAccountsExporter(deps = {}) {
    const storage = deps.chromeStorage;
    const downloads = deps.chromeDownloads;
    if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') {
      throw new Error('accounts-exporter requires chromeStorage with get/set');
    }
    if (!downloads || typeof downloads.download !== 'function') {
      throw new Error('accounts-exporter requires chromeDownloads with download()');
    }

    async function listAccounts() {
      const result = await storage.get(STORAGE_KEY);
      const value = result && result[STORAGE_KEY];
      return Array.isArray(value) ? value : [];
    }

    async function appendAccount({ email, password }) {
      if (!email || !password) throw new Error('email and password are required');
      const prev = await listAccounts();
      const next = [...prev, { email, password, savedAt: Date.now() }];
      await storage.set({ [STORAGE_KEY]: next });
      const url = toDataUrl(encodeContent(next));
      await downloads.download({
        url,
        filename: FILENAME,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      return { saved: next.length };
    }

    async function reexportAll() {
      const records = await listAccounts();
      const url = toDataUrl(encodeContent(records));
      await downloads.download({
        url,
        filename: FILENAME,
        conflictAction: 'overwrite',
        saveAs: false,
      });
      return { saved: records.length };
    }

    return { appendAccount, reexportAll, listAccounts };
  }

  return { createAccountsExporter, STORAGE_KEY, FILENAME };
});
