const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background.js', 'utf8');

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

function loadApi() {
  const bundle = [
    extractFunction('normalizeIcloudAliasLabelPattern'),
    extractFunction('buildIcloudAliasLabelPatternRegex'),
    extractFunction('computeNextIcloudAliasSequence'),
    extractFunction('formatIcloudAliasLabel'),
    extractFunction('getIcloudAliasLabel'),
  ].join('\n');

  return new Function(`
const DEFAULT_ICLOUD_ALIAS_LABEL_PATTERN = '{seq:003}';
${bundle}
return {
  normalizeIcloudAliasLabelPattern,
  buildIcloudAliasLabelPatternRegex,
  computeNextIcloudAliasSequence,
  formatIcloudAliasLabel,
  getIcloudAliasLabel,
};
`)();
}

test('normalizeIcloudAliasLabelPattern trims, falls back, and caps length', () => {
  const api = loadApi();
  assert.equal(api.normalizeIcloudAliasLabelPattern(undefined), '{seq:003}');
  assert.equal(api.normalizeIcloudAliasLabelPattern(''), '{seq:003}');
  assert.equal(api.normalizeIcloudAliasLabelPattern('   '), '{seq:003}');
  assert.equal(api.normalizeIcloudAliasLabelPattern('  Codex {seq:003}  '), 'Codex {seq:003}');
  const long = 'x'.repeat(200);
  assert.equal(api.normalizeIcloudAliasLabelPattern(long).length, 80);
});

test('buildIcloudAliasLabelPatternRegex captures seq group and matches existing labels', () => {
  const api = loadApi();
  const compiled = api.buildIcloudAliasLabelPatternRegex('{seq:003}');
  assert.equal(compiled.hasSeqToken, true);
  assert.match('001', compiled.regex);
  assert.match('137', compiled.regex);
  assert.doesNotMatch('1', compiled.regex);
  assert.doesNotMatch('0001', compiled.regex);
  const match137 = '137'.match(compiled.regex);
  assert.equal(match137[compiled.seqGroupIndex], '137');
});

test('buildIcloudAliasLabelPatternRegex handles prefix and date tokens', () => {
  const api = loadApi();
  const compiled = api.buildIcloudAliasLabelPatternRegex('Codex {seq} {date}');
  assert.match('Codex 5 2026-05-19', compiled.regex);
  assert.doesNotMatch('Codex 5 2026/05/19', compiled.regex);
  assert.doesNotMatch('Other 5 2026-05-19', compiled.regex);
});

test('computeNextIcloudAliasSequence returns max+1 among matching labels', () => {
  const api = loadApi();
  const aliases = [];
  for (let i = 1; i <= 137; i += 1) {
    aliases.push({ label: String(i).padStart(3, '0') });
  }
  aliases.push({ label: '不匹配的标签' });
  aliases.push({ label: 'Codex 999' });
  const next = api.computeNextIcloudAliasSequence(aliases, '{seq:003}');
  assert.equal(next, 138);
});

test('computeNextIcloudAliasSequence ignores labels not matching pattern width', () => {
  const api = loadApi();
  const aliases = [
    { label: '01' },
    { label: '0001' },
    { label: '120' },
    { label: '999' },
  ];
  const next = api.computeNextIcloudAliasSequence(aliases, '{seq:003}');
  assert.equal(next, 1000);
});

test('computeNextIcloudAliasSequence returns 1 when pattern has no seq token', () => {
  const api = loadApi();
  const aliases = [{ label: 'Codex' }, { label: 'Codex' }];
  const next = api.computeNextIcloudAliasSequence(aliases, 'Codex');
  assert.equal(next, 1);
});

test('formatIcloudAliasLabel renders {seq:NNN}, {seq}, {date} tokens', () => {
  const api = loadApi();
  assert.equal(api.formatIcloudAliasLabel('{seq:003}', { seq: 138 }), '138');
  assert.equal(api.formatIcloudAliasLabel('Codex {seq:003}', { seq: 138 }), 'Codex 138');
  assert.equal(api.formatIcloudAliasLabel('Codex {seq}', { seq: 9 }), 'Codex 9');
  const today = new Date();
  const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  assert.equal(api.formatIcloudAliasLabel('Codex {date}', { seq: 1 }), `Codex ${dateStr}`);
  assert.equal(api.formatIcloudAliasLabel('{date}-{seq:002}', { seq: 3, date: '2026-05-19' }), '2026-05-19-03');
});

test('getIcloudAliasLabel produces 138 for existing 001-137 with default pattern', () => {
  const api = loadApi();
  const aliases = [];
  for (let i = 1; i <= 137; i += 1) {
    aliases.push({ label: String(i).padStart(3, '0') });
  }
  const label = api.getIcloudAliasLabel(undefined, aliases);
  assert.equal(label, '138');
});

test('getIcloudAliasLabel supports custom prefix template', () => {
  const api = loadApi();
  const aliases = [{ label: 'Codex 005' }, { label: 'Codex 008' }, { label: '001' }];
  const label = api.getIcloudAliasLabel('Codex {seq:003}', aliases);
  assert.equal(label, 'Codex 009');
});

test('formatIcloudAliasLabel zero-pads seq narrower than width via padStart', () => {
  const api = loadApi();
  assert.equal(api.formatIcloudAliasLabel('{seq:005}', { seq: 1 }), '00001');
  assert.equal(api.formatIcloudAliasLabel('{seq:005}', { seq: 12345 }), '12345');
  assert.equal(api.formatIcloudAliasLabel('{seq:005}', { seq: 123456 }), '123456');
});
