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

    return { origin, authHeader };
  }

  return { createCpaAdminClient, CpaAdminError, DEFAULTS };
});
