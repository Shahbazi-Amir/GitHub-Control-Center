export const CACHE_LIMIT_BYTES = 10 * 1024 ** 3;
const PROTECTED = /(release|final|evidence|audit|delivery|deliverable|product|governance|snapshot)/i;
const EPHEMERAL = /(^|[-_.])(tmp|temp|debug|diagnostic|test|pytest|coverage|logs?)([-_.]|$)/i;

export function daysOld(date, now = Date.now()) {
  const t = new Date(date || 0).getTime();
  return Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 0;
}

export function pressureFor(repo) {
  const cachePct = repo.cacheLimitBytes ? (repo.cacheBytes / repo.cacheLimitBytes) * 100 : 0;
  let score = Math.min(70, cachePct * .7);
  score += Math.min(15, repo.queued * 5);
  score += Math.min(10, repo.recentFailures * 2);
  if (repo.artifactBytes > 500 * 1024 ** 2) score += 5;
  score = Math.round(Math.min(100, score));
  const level = score >= 85 ? 'critical' : score >= 65 ? 'high' : score >= 40 ? 'medium' : 'low';
  return { score, level };
}

export function safeCandidates({ caches = [], artifacts = [], cacheBytes = 0, cacheLimitBytes = CACHE_LIMIT_BYTES }, now = Date.now()) {
  const protectedArtifacts = [];
  const artifactCandidates = [];
  const byName = new Map();
  for (const a of artifacts) {
    const rows = byName.get(a.name) || [];
    rows.push(a);
    byName.set(a.name, rows);
  }
  for (const rows of byName.values()) rows.sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  for (const a of artifacts) {
    if (PROTECTED.test(a.name || '')) { protectedArtifacts.push(a); continue; }
    const age = daysOld(a.created_at, now);
    const newerSameName = (byName.get(a.name) || [])[0]?.id !== a.id;
    if ((EPHEMERAL.test(a.name || '') && age >= 7) || (age >= 30 && newerSameName)) artifactCandidates.push(a);
  }

  const newestByFamily = new Map();
  const family = c => `${c.ref || ''}|${String(c.key || '').split('-').slice(0,4).join('-')}`;
  for (const c of [...caches].sort((a,b) => new Date(b.last_accessed_at) - new Date(a.last_accessed_at))) {
    const f = family(c);
    if (!newestByFamily.has(f)) newestByFamily.set(f, c.id);
  }
  const sortedOldest = [...caches].sort((a,b) => new Date(a.last_accessed_at) - new Date(b.last_accessed_at));
  const cacheCandidates = [];
  let remaining = cacheBytes;
  const target = cacheLimitBytes * .60;
  if (cacheBytes > cacheLimitBytes * .80) {
    for (const c of sortedOldest) {
      if (remaining <= target) break;
      if (newestByFamily.get(family(c)) === c.id && daysOld(c.last_accessed_at, now) < 14) continue;
      cacheCandidates.push(c);
      remaining -= Number(c.size_in_bytes || 0);
    }
  }
  return { cacheCandidates, artifactCandidates, protectedArtifacts, projectedCacheBytes: Math.max(0, remaining) };
}
