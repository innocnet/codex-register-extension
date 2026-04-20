const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractFunction(name) {
  const markers = [`async function ${name}(`, `function ${name}(`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .find((index) => index >= 0);
  if (start < 0) {
    throw new Error(`missing function ${name}`);
  }

  let parenDepth = 0;
  let signatureEnded = false;
  let braceStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') {
      parenDepth += 1;
    } else if (ch === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        signatureEnded = true;
      }
    } else if (ch === '{' && signatureEnded) {
      braceStart = i;
      break;
    }
  }
  if (braceStart < 0) {
    throw new Error(`missing body for function ${name}`);
  }

  let depth = 0;
  let end = braceStart;
  for (; end < source.length; end += 1) {
    const ch = source[end];
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }

  return source.slice(start, end);
}

test('getMailProviderLoginUrl reuses preferred icloud host when preference is auto', () => {
  const bundle = [
    extractFunction('getSelectedIcloudHostPreference'),
    extractFunction('getMailProviderLoginUrl'),
  ].join('\n');

  const api = new Function(`
const ICLOUD_PROVIDER = 'icloud';
const selectMailProvider = { value: ICLOUD_PROVIDER };
const selectIcloudHostPreference = { value: 'auto' };
const latestState = { icloudHostPreference: 'auto', preferredIcloudHost: 'icloud.com.cn' };
function normalizeIcloudHost(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'icloud.com' || normalized === 'icloud.com.cn' ? normalized : '';
}
function getIcloudLoginUrlForHost(host) {
  return host === 'icloud.com.cn' ? 'https://www.icloud.com.cn/' : 'https://www.icloud.com/';
}
function getMailProviderLoginConfig() {
  return { label: 'iCloud 邮箱' };
}
${bundle}
return { getSelectedIcloudHostPreference, getMailProviderLoginUrl };
`)();

  assert.equal(api.getSelectedIcloudHostPreference(), 'icloud.com.cn');
  assert.equal(api.getMailProviderLoginUrl(), 'https://www.icloud.com.cn/');
});
