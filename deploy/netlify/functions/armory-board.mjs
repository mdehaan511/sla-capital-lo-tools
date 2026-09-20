/**
 * armory-board.mjs — POST /api/armory-board
 *
 * Deploy 237.191 — the cork board's one endpoint (Dan's idea, Mike's shape).
 * Team members only, same gate as the rest of the Armory.
 *
 * Body: { action, ... }
 *   list                                  → { items }
 *   pin    { kind:'note'|'photo', ... }   → { item }      (photo: dataUrl)
 *   move   { id, x, y, w, rot, z }        → { item }      anyone may tidy
 *   edit   { id, text|caption|color|keep }→ { item }      author or admin
 *   react  { id, emoji }                  → { item }
 *   unpin  { id }                         → { ok }        author or admin
 *
 * Every write answers with the item so the page can repaint just that pin
 * instead of reloading the whole wall.
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin } from './_shared/auth.mjs';
import { isTeamMember, displayNameFor } from './_shared/armory.mjs';
import {
  listBoard, createItem, moveItem, editItem, reactToItem, deleteItem, signPhoto,
} from './_shared/corkboard.mjs';

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
      return json(200, { ok: true, items: await listBoard() });
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
      );
      return json(200, { ok: true, item: item.kind === 'photo' ? Object.assign({}, item, { photoUrl: signPhoto(item.id) }) : item });
    }

    if (action === 'move')  return json(200, { ok: true, item: await moveItem(user, body) });
    if (action === 'edit')  return json(200, { ok: true, item: await editItem(user, body, admin) });
    if (action === 'react') return json(200, { ok: true, item: await reactToItem(user, body) });
    if (action === 'unpin') { await deleteItem(user, body.id, admin); return json(200, { ok: true }); }

    return json(400, { error: 'Unknown action: ' + action });
  } catch (e) {
    const msg = (e && e.message) || 'unknown';
    console.error('armory-board error:', msg);
    // The thrown messages above are written for the person reading them.
    return json(/required|full|too large|Only the person|no longer|not editable|cannot be taken|did not look|Write something/i.test(msg) ? 400 : 500,
      { error: msg });
  }
};
