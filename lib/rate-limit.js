// very small brute-force guard for login and account-recovery attempts,
// keyed by "type:ip". in-memory only: resets on restart, which is fine for
// its purpose.
//
// reserveAttempt() checks the bucket AND increments it in one synchronous
// step -- no `await` in between -- so a burst of concurrent requests can't
// all read the same pre-increment count before any of them get recorded.
// The previous check-then-record-after-bcrypt shape had exactly that gap.

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 10;
const attemptTracker = new Map();

function reserveAttempt(type, ip) {
  const key = `${type}:${ip}`;
  const now = Date.now();
  const entry = attemptTracker.get(key);
  if (entry && now - entry.firstAttempt <= RATE_WINDOW_MS) {
    if (entry.count >= RATE_MAX_ATTEMPTS) return false;
    entry.count += 1;
    return true;
  }
  attemptTracker.set(key, { count: 1, firstAttempt: now });
  return true;
}

function clearAttempts(type, ip) {
  attemptTracker.delete(`${type}:${ip}`);
}

module.exports = { reserveAttempt, clearAttempts };
