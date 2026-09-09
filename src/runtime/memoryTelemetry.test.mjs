import test from 'node:test';
import assert from 'node:assert/strict';
import { readCgroupMemory, runtimeMemorySnapshot } from './memoryTelemetry.js';

function reader(files) {
  return (filename) => {
    if (!(filename in files)) {
      const error = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return files[filename];
  };
}

test('reads cgroup v2 current/limit and computes usage', () => {
  const result = readCgroupMemory(reader({
    '/sys/fs/cgroup/memory.current': String(512 * 1024 * 1024),
    '/sys/fs/cgroup/memory.max': String(2 * 1024 * 1024 * 1024),
  }));
  assert.equal(result.version, 2);
  assert.equal(result.usagePct, 25);
});

test('treats cgroup v2 max as unlimited', () => {
  const result = readCgroupMemory(reader({
    '/sys/fs/cgroup/memory.current': '1048576',
    '/sys/fs/cgroup/memory.max': 'max',
  }));
  assert.equal(result.version, 2);
  assert.equal(result.limitBytes, null);
  assert.equal(result.usagePct, null);
});

test('falls back to cgroup v1', () => {
  const result = readCgroupMemory(reader({
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '262144000',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1048576000',
  }));
  assert.equal(result.version, 1);
  assert.equal(result.usagePct, 25);
});

test('runtime snapshot reports process and container headroom', () => {
  const snapshot = runtimeMemorySnapshot({
    memoryUsage: () => ({
      rss: 100 * 1024 * 1024,
      heapUsed: 40 * 1024 * 1024,
      heapTotal: 60 * 1024 * 1024,
      external: 2 * 1024 * 1024,
      arrayBuffers: 1 * 1024 * 1024,
    }),
    readFile: reader({
      '/sys/fs/cgroup/memory.current': String(600 * 1024 * 1024),
      '/sys/fs/cgroup/memory.max': String(2048 * 1024 * 1024),
    }),
  });
  assert.equal(snapshot.process.rssMiB, 100);
  assert.equal(snapshot.container.currentMiB, 600);
  assert.equal(snapshot.container.limitMiB, 2048);
  assert.equal(snapshot.container.headroomMiB, 1448);
});
