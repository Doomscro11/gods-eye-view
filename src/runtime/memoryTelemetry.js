import fs from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
const CGROUP_ROOT = '/sys/fs/cgroup';

function readText(readFile, filename) {
  try {
    return String(readFile(filename, 'utf8')).trim();
  } catch {
    return null;
  }
}

function finiteBytes(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function decodeMountField(value = '') {
  return value
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\');
}

function parseMountInfo(text) {
  if (!text) return [];
  const mounts = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const left = line.slice(0, separator).trim().split(/\s+/);
    const right = line.slice(separator + 3).trim().split(/\s+/);
    if (left.length < 6 || right.length < 3) continue;
    mounts.push({
      root: decodeMountField(left[3]),
      mountPoint: decodeMountField(left[4]),
      optional: left.slice(6),
      fsType: right[0],
      source: right[1],
      superOptions: right.slice(2).join(','),
    });
  }
  return mounts;
}

function parseSelfCgroup(text) {
  if (!text) return [];
  return text.split('\n').map((line) => {
    const first = line.indexOf(':');
    const second = first < 0 ? -1 : line.indexOf(':', first + 1);
    if (first < 0 || second < 0) return null;
    return {
      hierarchy: line.slice(0, first),
      controllers: line.slice(first + 1, second).split(',').filter(Boolean),
      cgroupPath: line.slice(second + 1) || '/',
    };
  }).filter(Boolean);
}

function isWithinMount(mountPoint, candidate) {
  const relative = path.posix.relative(mountPoint, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative));
}

function resolveMountedCgroupPath(mount, cgroupPath) {
  if (!mount || !cgroupPath) return null;
  const mountRoot = path.posix.normalize(mount.root || '/');
  const normalizedCgroup = path.posix.normalize(cgroupPath);

  let relative;
  if (mountRoot === '/') {
    relative = normalizedCgroup.replace(/^\/+/, '');
  } else if (normalizedCgroup === mountRoot) {
    relative = '';
  } else if (normalizedCgroup.startsWith(`${mountRoot}/`)) {
    relative = normalizedCgroup.slice(mountRoot.length + 1);
  } else {
    return null;
  }

  const resolved = path.posix.resolve(mount.mountPoint, relative);
  return isWithinMount(path.posix.resolve(mount.mountPoint), resolved) ? resolved : null;
}

function discoverCgroupBase(readFile, version) {
  const memberships = parseSelfCgroup(readText(readFile, '/proc/self/cgroup'));
  const mounts = parseMountInfo(readText(readFile, '/proc/self/mountinfo'));

  if (version === 2) {
    const membership = memberships.find((entry) => entry.hierarchy === '0' && entry.controllers.length === 0);
    const mount = mounts.find((entry) => entry.fsType === 'cgroup2');
    return membership && mount ? resolveMountedCgroupPath(mount, membership.cgroupPath) : null;
  }

  const membership = memberships.find((entry) => entry.controllers.includes('memory'));
  const mount = mounts.find((entry) => {
    if (entry.fsType !== 'cgroup') return false;
    const controllerText = `${entry.source},${entry.superOptions},${entry.optional.join(',')}`;
    return controllerText.split(',').includes('memory');
  });
  return membership && mount ? resolveMountedCgroupPath(mount, membership.cgroupPath) : null;
}

function readV2(readFile, base) {
  const current = readText(readFile, path.posix.join(base, 'memory.current'));
  const max = readText(readFile, path.posix.join(base, 'memory.max'));
  if (current === null && max === null) return null;
  const currentBytes = finiteBytes(current);
  const limitBytes = max === 'max' ? null : finiteBytes(max);
  return {
    version: 2,
    currentBytes,
    limitBytes,
    usagePct: currentBytes !== null && limitBytes > 0
      ? Math.round((currentBytes / limitBytes) * 1000) / 10
      : null,
  };
}

function readV1(readFile, base) {
  const current = readText(readFile, path.posix.join(base, 'memory.usage_in_bytes'));
  const limit = readText(readFile, path.posix.join(base, 'memory.limit_in_bytes'));
  if (current === null && limit === null) return null;
  const currentBytes = finiteBytes(current);
  const rawLimit = finiteBytes(limit);
  // Very large v1 values conventionally mean "unlimited".
  const limitBytes = rawLimit !== null && rawLimit < 2 ** 60 ? rawLimit : null;
  return {
    version: 1,
    currentBytes,
    limitBytes,
    usagePct: currentBytes !== null && limitBytes > 0
      ? Math.round((currentBytes / limitBytes) * 1000) / 10
      : null,
  };
}

/**
 * Read the process container's memory accounting without assuming a Fly-specific
 * API. Resolve the process's real cgroup first; fall back to conventional root
 * paths for private cgroup namespaces, local development and older runtimes.
 */
export function readCgroupMemory(readFile = fs.readFileSync) {
  const v2Base = discoverCgroupBase(readFile, 2);
  if (v2Base) {
    const result = readV2(readFile, v2Base);
    if (result) return result;
  }

  const conventionalV2 = readV2(readFile, CGROUP_ROOT);
  if (conventionalV2) return conventionalV2;

  const v1Base = discoverCgroupBase(readFile, 1);
  if (v1Base) {
    const result = readV1(readFile, v1Base);
    if (result) return result;
  }

  const conventionalV1 = readV1(readFile, path.posix.join(CGROUP_ROOT, 'memory'));
  if (conventionalV1) return conventionalV1;

  return { version: null, currentBytes: null, limitBytes: null, usagePct: null };
}

function mib(bytes) {
  return Number.isFinite(bytes) ? Math.round((bytes / MIB) * 10) / 10 : null;
}

export function runtimeMemorySnapshot({ memoryUsage = process.memoryUsage, readFile = fs.readFileSync } = {}) {
  const processMemory = memoryUsage();
  const cgroup = readCgroupMemory(readFile);
  return {
    process: {
      rssMiB: mib(processMemory.rss),
      heapUsedMiB: mib(processMemory.heapUsed),
      heapTotalMiB: mib(processMemory.heapTotal),
      externalMiB: mib(processMemory.external),
      arrayBuffersMiB: mib(processMemory.arrayBuffers),
    },
    container: {
      cgroupVersion: cgroup.version,
      currentMiB: mib(cgroup.currentBytes),
      limitMiB: mib(cgroup.limitBytes),
      usagePct: cgroup.usagePct,
      headroomMiB: cgroup.currentBytes !== null && cgroup.limitBytes !== null
        ? mib(Math.max(0, cgroup.limitBytes - cgroup.currentBytes))
        : null,
    },
  };
}
