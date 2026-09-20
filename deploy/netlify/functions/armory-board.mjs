/**
 * armory-board.mjs — POST /api/armory-board
 *
 * Deploy 237.191 — the cork board's one endpoint (Dan's idea, Mike's shape).
 * Team members only, same gate as the rest of the Armory.
 * 237.192 — auto-pins, @mentions, the monthly archive.
 * 237.193 — shout-outs; deed cards retired.
 * 237.195 — video pins, uploaded in chunks.
 *
 * Body: { action, ... }
 *   list                                  → { items, archives }
 *   pin    { kind:'note'|'photo'|'video'|'shoutout'|'tape'|'arrow', ... } → { item }
 *   video-chunk { uploadId, index, parts, b64 }          → { part }
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
import {
  listBoard, createItem, moveItem, editItem, reactToItem, deleteItem, withMediaUrls,
  syncAutoPins, ensureMonthlyArchive, listArchiveMonths, getArchive, putVideoPart,
} from './_shared/corkboard.mjs';

/** The roster, for resolving @names. Cheap: team-events already caches profiles. */
async function roster() {
  const profiles = await loadTeamProfiles().catch(() => []);
  return profiles.map((p) => ({ email: p.email, name: p.name }));
}

/**
 * What the auto-pins are derived from. Both sources are already built for
 * other parts of the Armory, so this is reads, not computation, and a failure
 * in either must not stop the board from loading. Deeds used to be a third
 * source; Mike had them removed in 237.193 (they buried the wall).
 */
async function autoSources() {
  const [bells, profiles] = await Promise.all([
    listBells(20).catch(() => []),
    loadTeamProfiles().catch(() => []),
  ]);
  return { bells, celebrations: { today: celebrationsOn(profiles, todayPacific(new Date())) } };
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
        (body.kind === 'note' || body.kind === 'shoutout') ? await roster() : [],
      );
      return json(200, { ok: true, item: withMediaUrls(item) });
    }

    // 237.195 — one slice of a clip on its way up. The browser has already
    // trimmed it to the first 20 seconds and re-encoded it; this just carries
    // the bytes in pieces a function body can accept.
    if (action === 'video-chunk') {
      const r = await putVideoPart(user.email, body.uploadId, body.index, body.parts, body.b64);
      return json(200, { ok: true, part: r });
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
    return json(/required|full|too large|Only the person|no longer|fixed to the frame|posted by the Armory|did not look|Write something|Say who|Say what|Bad chunk|Empty chunk|Chunk too large|did not finish|did not arrive|too large even after trimming/i.test(msg) ? 400 : 500,
      { error: msg });
  }
};
