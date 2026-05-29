// background/cpa-admin-client.js
(function attachCpaAdminClient(root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.MultiPageCpaAdminClient = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createCpaAdminClientModule() {
  const DEFAULTS = Object.freeze({
    LIST_PATH: '/api/v1/admin/accounts',
    REFRESH_PATH: (id) => `/api/v1/admin/accounts/${id}/refresh`,
    DISABLE_PATH: (id) => `/api/v1/admin/accounts/${id}`,
    TIMEOUT_MS: 30000,
  });

  class CpaAdminError extends Error {
    constructor(message, code) {
      super(message);
      this.name = 'CpaAdminError';
      this.code = code || 'UNKNOWN';
    }
  }

  function deriveOrigin(rawUrl) {
    const url = new URL(String(rawUrl));
    return url.origin;
  }

  function createCpaAdminClient(options = {}) {
    const managementKey = String(options.managementKey || '').trim();
    const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULTS.TIMEOUT_MS;

    if (!managementKey) throw new CpaAdminError('managementKey is required', 'NO_KEY');
    if (!fetchImpl) throw new CpaAdminError('fetch implementation missing', 'NO_FETCH');

    const origin = deriveOrigin(options.baseUrl || '');

    function authHeader() {
      return { Authorization: `Bearer ${managementKey}` };
    }

    async function requestJson(path, { method = 'GET', body } = {}) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        const response = await fetchImpl(`${origin}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...authHeader() },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          ...(controller ? { signal: controller.signal } : {}),
        });
        return response;
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function listAccounts() {
      const response = await requestJson(DEFAULTS.LIST_PATH);
      if (!response.ok) {
        throw new CpaAdminError(`listAccounts HTTP ${response.status}`, `HTTP_${response.status}`);
      }
      const payload = await response.json();
      const items = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.list) ? payload.list
        : Array.isArray(payload) ? payload
        : [];
      return items;
    }

    async function probeAccount(id) {
      const response = await requestJson(DEFAULTS.REFRESH_PATH(id), { method: 'POST' });
      if (response.status === 401) return { abnormal: true };
      if (response.ok) return { abnormal: false };
      return { abnormal: false, error: `probeAccount HTTP ${response.status}` };
    }

    return { origin, authHeader, listAccounts, probeAccount };
  }

  return { createCpaAdminClient, CpaAdminError, DEFAULTS };
});
