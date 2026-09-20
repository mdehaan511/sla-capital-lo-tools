/**
 * armory-board.mjs — POST /api/armory-board
 *
 * Deploy 237.191 — the cork board's one endpoint (Dan's idea, Mike's shape).
 * Team members only, same gate as the rest of the Armory.
 * 237.192 — auto-pins, @mentions, the monthly archive.
 *
 * Body: { action, ... }
 *   list                                  → { items, archives }
 *   pin    { kind:'note'|'photo'|'tape'|'arrow', ... }   → { item }
 *   move   { id, x, y, w, rot, z }        → { item }   anyone may tidy
 *   edit   { id, text|caption|color|keep }→ { item }   author or admin
 *   react  { id, emoji }                  → { item }
 *   unpin  { id }                         → { ok }     author or admin
 *   archive{ month }                      → { archive }
 *
 * Every write answers with the item so the page repaints one pin instead of
 * reloading the wall.
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin } from './_shared/auth.mjs';
import { isTeamMember, displayNameFor } from './_shared/armory.mjs';
import { listBells } from './_shared/closing-bell.mjs';
import { loadTeamProfiles, celebrationsOn, todayPacific } from './_shared/team-events.mjs';
import { getAchievementsIndex, DEEDS, RANKS } from './_shared/achievements.mjs';
import {
  listBoard, createItem, moveItem, editItem, reactToItem, deleteItem, signPhoto,
  syncAutoPins, ensureMonthlyArchive, listArchiveMonths, getArchive,
} from './_shared/corkboard.mjs';

/** The roster, for resolving @names. Cheap: team-events already caches profiles. */
async function roster() {
  const profiles = await loadTeamProfiles().catch(() => []);
  return profiles.map((p) => ({ email: p.email, name: p.name }));
}

/**
 * Everything the auto-pins are derived from. All three sources are already
 * built for other parts of the Armory, so this is reads, not computation, and
 * a failure in any one of them must not stop the board from loading.
 */
async function autoSources() {
  const [bells, profiles, idx] = await Promise.all([
    listBells(20).catch(() => []),
    loadTeamProfiles().catch(() => []),
    getAchievementsIndex().catch(() => null),
  ]);
  const celebrations = { today: celebrationsOn(profiles, todayPacific(new Date())) };
  const byKey = {};
  DEEDS.forEach((d) => { byKey[d.key] = d; });
  const deeds = ((idx && idx.recent) || []).slice(0, 12).map((r) => ({
    email: r.email, name: r.name, key: r.key, tier: r.tier, at: r.at,
    label: (byKey[r.key] && byKey[r.key].name) || r.key,
    rank: RANKS[(r.tier || 1) - 1] || '',
  }));
  return { bells, celebrations, deeds };
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!(await isTeamMember(user))) return json(403, { error: 'The Armory is for SLA Capital team members.' });

    const body = await readJsonBody(req);
    if (body === null) return json(400, { error: 'Invalid JSON' });
    const action = String((body && body.action) || 'list');
    const admin = isAdmin(user);

    if (action === 'list') {
      let items = await listBoard();
      // The platform's own cards, and last month's snapshot. Both are
      // best-effort: the wall must still load if either one has a bad day.
      try {
        const src = await autoSources();
        const fresh = await syncAutoPins(Object.assign({ existing: items }, src));
        if (fresh.length) items = await listBoard();
      } catch (e) { console.warn('[board] auto-pin sync failed:', e && e.message); }
      try { await ensureMonthlyArchive(items); } catch (e) { console.warn('[board] archive failed:', e && e.message); }
      const archives = await listArchiveMonths().catch(() => []);
      return json(200, { ok: true, items, archives, isAdmin: admin });
    }

    if (action === 'archive') {
      return json(200, { ok: true, archive: await getArchive(body.month) });
    }

    if (action === 'pin') {
      // The client downsizes before upload (max edge 1400, JPEG) — this is
      // just the transport shape: a data: URL we split to base64 text.
      let b64 = '';
      if (body.kind === 'photo') {
        const dataUrl = String(body.dataUrl || '');
        const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(dataUrl);
        if (!m) return json(400, { error: 'That file did not look like an image' });
        b64 = m[2];
        body.photo = Object.assign({}, body.photo, { type: m[1] });
      }
      const item = await createItem(
        { email: user.email },
        Object.assign({}, body, { authorName: body.authorName || displayNameFor(user) }),
        b64,
        body.kind === 'note' ? await roster() : [],
      );
      return json(200, { ok: true, item: item.kind === 'photo' ? Object.assign({}, item, { photoUrl: signPhoto(item.id) }) : item });
    }

    if (action === 'move')  return json(200, { ok: true, item: await moveItem(user, body) });
    if (action === 'edit')  return json(200, { ok: true, item: await editItem(user, body, admin, body.text !== undefined ? await roster() : []) });
    if (action === 'react') return json(200, { ok: true, item: await reactToItem(user, body) });
    if (action === 'unpin') { await deleteItem(user, body.id, admin); return json(200, { ok: true }); }

    return json(400, { error: 'Unknown action: ' + action });
  } catch (e) {
    const msg = (e && e.message) || 'unknown';
    console.error('armory-board error:', msg);
    // The thrown messages above are written for the person reading them.
    return json(/required|full|too large|Only the person|no longer|fixed to the frame|posted by the Armory|did not look|Write something/i.test(msg) ? 400 : 500,
      { error: msg });
  }
};
