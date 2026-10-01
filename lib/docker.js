const fs = require('fs');
const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// ---- figure out our own container id, so we can hide ourselves from the list ----

function getSelfContainerId() {
  try {
    // works for both cgroup v1 (".../docker/<64-hex-id>") and v2
    // (e.g. "0::/system.slice/docker-<64-hex-id>.scope") layouts.
    const raw = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match = raw.match(/[0-9a-f]{64}/);
    if (match) return match[0];
  } catch (e) { /* not available outside Linux containers */ }
  return null;
}

const SELF_ID = getSelfContainerId();
const SELF_NAME = 'pinnule'; // matches container_name in docker-compose.yml, used as a fallback

// container IDs the app itself hands out are always a 12-char hex prefix
// (see c.Id.slice(0, 12) in routes/containers.js), but accept up to a full
// 64-char id too. Rejecting anything else here means a crafted :id
// containing URL-structural characters (?, /, #...) never reaches
// dockerode's own request building.
function isValidContainerId(id) {
  return typeof id === 'string' && /^[a-f0-9]{12,64}$/i.test(id);
}

// Docker labels come from whatever image/compose file a container was
// started with -- not something pinnule controls -- so pinnule.url has to
// be treated as untrusted input. Only http/https can end up as a link.
function isSafeAppUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

// When a container publishes several ports, just taking whichever one
// Docker happened to list first often picks the wrong one (a metrics or
// API port ahead of the real web UI). Prefer a match against the
// container's private/internal port, since that's what the app itself is
// actually bound to, and only fall back to "first listed" when nothing
// here matches.
const PREFERRED_WEB_PORTS = [
  80, 443, 8080, 8443, 3000, 5000, 8081, 8888, 9000, 9090,
  8096, 8123, 32400, 5055, 19999, 8006, 81,
];

function pickAppPort(ports) {
  if (!ports.length) return null;
  for (const preferred of PREFERRED_WEB_PORTS) {
    const match = ports.find(p => p.private === preferred);
    if (match) return match;
  }
  return ports[0];
}

function cpuPercentFromStats(stats) {
  try {
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const sysDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cores = stats.cpu_stats.cpu_usage.percpu_usage
      ? stats.cpu_stats.cpu_usage.percpu_usage.length
      : (stats.cpu_stats.online_cpus || 1);
    if (sysDelta > 0 && cpuDelta > 0) return (cpuDelta / sysDelta) * cores * 100;
  } catch (e) { /* stats shape varies briefly on container start/stop */ }
  return null;
}

// Docker's log API multiplexes stdout/stderr into one stream, each chunk
// prefixed with an 8-byte header (byte 0: 1=stdout/2=stderr, bytes 4-7:
// big-endian payload length) -- but only when the container has no TTY
// attached. A TTY container's logs are already plain text with no framing,
// and running this demux against that would corrupt it by misreading real
// log bytes as fake frame headers. Callers must check Config.Tty first.
function demuxLogBuffer(buffer) {
  const parts = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    if (size < 0 || offset + size > buffer.length) break; // truncated/malformed, stop rather than misread
    parts.push(buffer.slice(offset, offset + size).toString('utf8'));
    offset += size;
  }
  return parts.join('');
}

// inspect() returns labels/restart count/start time — data that barely
// changes between polls — but was being re-fetched from the Docker API for
// every container on every poll cycle. Cache it briefly per container id
// instead; entries for containers that disappear (removed/recreated) get
// pruned by the caller (see routes/containers.js), since only it knows
// which ids are still current.
const inspectCache = new Map(); // id -> { restartCount, startedAt, labels, fetchedAt }
const INSPECT_CACHE_TTL_MS = 30 * 1000;

async function getContainerMeta(id, fallbackLabels) {
  const cached = inspectCache.get(id);
  if (cached && (Date.now() - cached.fetchedAt) < INSPECT_CACHE_TTL_MS) return cached;
  const inspect = await docker.getContainer(id).inspect();
  const meta = {
    restartCount: inspect.RestartCount || 0,
    startedAt: inspect.State && inspect.State.StartedAt,
    labels: (inspect.Config && inspect.Config.Labels) || fallbackLabels || {},
    fetchedAt: Date.now(),
  };
  inspectCache.set(id, meta);
  return meta;
}

module.exports = {
  docker,
  SELF_ID,
  SELF_NAME,
  isValidContainerId,
  isSafeAppUrl,
  pickAppPort,
  cpuPercentFromStats,
  demuxLogBuffer,
  getContainerMeta,
  inspectCache,
};
