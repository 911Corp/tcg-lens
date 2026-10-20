import test from 'node:test';
import assert from 'node:assert/strict';
import { versionedFetch } from '../lens/indexVersion.js';

const recorder = (version) => {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).endsWith('/index-version.json')) return version ? { ok: true, json: async () => ({ version }) } : { ok: false };
    return { ok: true };
  };
  return { calls, fetchImpl };
};

test('index requests carry the content version', async () => {
  const { calls, fetchImpl } = recorder('abc123');
  const f = versionedFetch('/data-a', fetchImpl);
  await f('/data-a/deep-index.json'); await f('/data-a/visual-index-ja.json');
  assert.deepEqual(calls, ['/data-a/index-version.json', '/data-a/deep-index.json?v=abc123', '/data-a/visual-index-ja.json?v=abc123']);
});

test('no version file → unchanged URLs; other paths are never versioned', async () => {
  const { calls, fetchImpl } = recorder(null);
  const f = versionedFetch('/data-b', fetchImpl);
  await f('/data-b/deep-index.json'); await f('/api/sealed?q=x');
  assert.deepEqual(calls, ['/data-b/index-version.json', '/data-b/deep-index.json', '/api/sealed?q=x']);
});
