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

test('resolves a nested cgroup v2 process path', () => {
  const result = readCgroupMemory(reader({
    '/proc/self/cgroup': '0::/machine.slice/fly-app.scope',
    '/proc/self/mountinfo': '36 25 0:32 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw',
    '/sys/fs/cgroup/machine.slice/fly-app.scope/memory.current': String(512 * 1024 * 1024),
    '/sys/fs/cgroup/machine.slice/fly-app.scope/memory.max': String(2 * 1024 * 1024 * 1024),
  }));
  assert.equal(result.version, 2);
  assert.equal(result.currentBytes, 512 * 1024 * 1024);
  assert.equal(result.limitBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(result.usagePct, 25);
});

test('resolves cgroup v2 paths when the mount has a non-root cgroup root', () => {
  const result = readCgroupMemory(reader({
    '/proc/self/cgroup': '0::/tenant/app',
    '/proc/self/mountinfo': '36 25 0:32 /tenant /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw',
    '/sys/fs/cgroup/app/memory.current': '1048576',
    '/sys/fs/cgroup/app/memory.max': '4194304',
  }));
  assert.equal(result.version, 2);
  assert.equal(result.usagePct, 25);
});

test('falls back to conventional cgroup v2 paths', () => {
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

test('resolves a nested cgroup v1 memory controller path', () => {
  const result = readCgroupMemory(reader({
    '/proc/self/cgroup': '5:memory:/docker/abc123',
    '/proc/self/mountinfo': '29 23 0:26 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec,relatime - cgroup cgroup rw,memory',
    '/sys/fs/cgroup/memory/docker/abc123/memory.usage_in_bytes': '262144000',
    '/sys/fs/cgroup/memory/docker/abc123/memory.limit_in_bytes': '1048576000',
  }));
  assert.equal(result.version, 1);
  assert.equal(result.usagePct, 25);
});

test('falls back to conventional cgroup v1 paths', () => {
  const result = readCgroupMemory(reader({
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '262144000',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1048576000',
  }));
  assert.equal(result.version, 1);
  assert.equal(result.usagePct, 25);
});

test('treats conventional huge cgroup v1 limits as unlimited', () => {
  const result = readCgroupMemory(reader({
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '1048576',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(2 ** 61),
  }));
  assert.equal(result.version, 1);
  assert.equal(result.limitBytes, null);
  assert.equal(result.usagePct, null);
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
