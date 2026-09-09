import fs from 'node:fs';

const MIB = 1024 * 1024;

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

/**
 * Read the container's memory accounting without assuming a Fly-specific API.
 * Supports Linux cgroup v2 first and v1 as a fallback. Bare-metal/dev hosts
 * simply return null fields.
 */
export function readCgroupMemory(readFile = fs.readFileSync) {
  const v2Current = readText(readFile, '/sys/fs/cgroup/memory.current');
  const v2Max = readText(readFile, '/sys/fs/cgroup/memory.max');
  if (v2Current !== null || v2Max !== null) {
    const currentBytes = finiteBytes(v2Current);
    const limitBytes = v2Max === 'max' ? null : finiteBytes(v2Max);
    return {
      version: 2,
      currentBytes,
      limitBytes,
      usagePct: currentBytes !== null && limitBytes > 0
        ? Math.round((currentBytes / limitBytes) * 1000) / 10
        : null,
    };
  }

  const v1Current = readText(readFile, '/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const v1Limit = readText(readFile, '/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1Current !== null || v1Limit !== null) {
    const currentBytes = finiteBytes(v1Current);
    const rawLimit = finiteBytes(v1Limit);
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
