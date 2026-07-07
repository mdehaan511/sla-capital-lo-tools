# SLA Capital — Internal Loan Tools

Internal portal for SLA Capital loan officers. Hosted on Netlify at:
- **Live**: <https://slaloantools.netlify.app> (the vanity is the effective primary; use this for curl checks + LO-facing links)
- The old auto-generated `silver-narwhal-0d9f84.netlify.app` subdomain returns 404 as of 2026-07 — do NOT reference it.

This is **production software with active LOs**. Bugs are felt immediately.
Prefer small, surgical, reversible changes over large rewrites. When unsure,
ship diagnostic logging first, then the fix.

---

## Stack

- **Frontend**: vanilla HTML + ES5-flavored JS (no build step, no framework, no
  bundler). Each page is a self-contained `.html` file with inline `<script>`
  blocks, plus a few shared `.js` files loaded via `<script src>`. CSS lives
  inline in `<style>` blocks. We intentionally avoid React/Vue/build tools so
  any developer can open a file and see exactly what runs.
- **Backend**: Netlify Functions (Node.js, `.mjs` ES modules) under
  `netlify/functions/`. Storage is Netlify Blobs (key-value JSON store).
- **Auth**: Netlify Identity (JWT-based). Client side uses
  `netlifyIdentity.currentUser().jwt()`.
- **External services**: Resend (transactional email), Brevo (marketing list
  sync), Google Places (address autocomplete), Google Maps (geocoding for
  ZHVI lookups), pdf-lib (signature stamping), jsPDF (term sheet generation).
- **No TypeScript**. No transpilation. ES5 in browser-facing code so older
  browsers in LO field offices don't break.

---

## Top-level layout

```
deploy/
├── *.html                    # Pages — each is self-contained
├── *.js                      # Shared client modules (no bundler)
├── netlify/
│   └── functions/
│       ├── *.mjs             # Endpoint handlers
│       └── _shared/          # Backend helpers (auth, crypto, email, esign)
├── netlify.toml              # Redirects + headers + build config
├── inject-env.js             # Build-time injection of public env vars
└── (no node_modules in repo — npm i locally as needed)
```

### Key client files

- **`sla-api.js`** — All backend API calls. Single source of truth for HTTP.
  Exposes `window.SLA.Clients`, `SLA.Quotes`, `SLA.Prospects`, `SLA.Reminders`,
  `SLA.Envelopes`, `SLA.BorrowerInfo`, `SLA.Settings`, `SLA.Admin`. Wraps a
  localStorage cache (`sla_cache_*` keys, 5 min TTL) with `listCached()` for
  stale-while-revalidate paints.
- **`sla-forms.js`** — Google Places autocomplete + form helpers. Has the
  three-layer pac-container hide logic (place_changed, bindRoot sweep,
  document-level click-outside) — don't simplify without testing all three.
- **`sla-search.js`, `sla-notifications.js`, `sla-chat.js`** — Search bar,
  notification bell, chat widget. Loaded on most pages.
- **`quotes.js`** — `QuoteStore`: local + backend dual-write for saved quotes
  in the sizer's own panel (separate from the Loan Details store).
- **`dscr-sizer.html`** — DSCR pricing sizer + term sheet PDF generator.
- **`rtl-sizer.html`** — Bridge/Fix-Flip/Transactional sizer + term sheet PDF.
- **`loan-details.html`** — Per-loan dashboard. Most-visited page.
- **`pipeline.html`** — Kanban-style board of all loans in progress.
- **`clients.html`** — LO's full client list.
- **`apply.html`** — Public borrower application form (no auth required).
- **`borrower-info.html`** — Long-form borrower questionnaire (called the
  "long app" in conversation).

---

## Netlify Blob stores

All stores live in Netlify Blobs. Keys follow `ownerKey/recordId` convention
where `ownerKey = keySafe(loEmail)`. Admins can pass `?all=1` on list endpoints
to bypass owner scoping.

| Store | Contents | Notes |
|---|---|---|
| `clients` | Full client record (borrower info + array of loans) | Loans are nested under client; loan IDs are `l_<timestamp>_<random>` |
| `quotes` | Sizer-saved quotes panel | Separate from `clients` — saved-quote panel only, NOT loan-details |
| `prospects` | Application form submissions | Becomes a client + loan via `upsertClientFromProspect` |
| `reminders` | Per-loan reminders | Owner-scoped |
| `profiles` | LO profile data | `eventual` consistency in most call sites |
| `chat-logs` | Internal chat widget history | |
| `brevo-sync-log` | Audit trail of Brevo contact syncs | |
| `envelopes` | Native eSign envelopes (post-Deploy 185 — replaced PandaDoc) | |
| `envelope-pdfs` | Pre-signature PDF bytes | |
| `envelope-final-pdfs` | Signed PDF bytes | |
| `envelope-signer-idx` | Reverse index: signer token → envelope id | For signer landing pages |
| `borrower_info` | Long-app submissions | Per-loan: keyed by `(ownerKey, clientId, loanId)` since Deploy 168 |
| `borrower_info_token_idx` | Borrower-1 token → record lookup | |
| `signed_applications` | Final signed long-app PDFs | |
| `borrower2_token_idx` | Borrower-2 (co-signer) token lookup | |
| `pandadoc-send-log` | **Legacy read-only** — kept for audit history pre-Deploy 185 | |
| `settings` | Admin settings (Slack webhook, etc.) | |

### Consistency choices

- `clients`, `quotes`, `prospects`, `reminders` — `strong` (we read-modify-
  write, so we need fresh data)
- `profiles`, `brevo-sync-log` — `eventual` (writes are idempotent, slight
  staleness is fine)

---

## Naming conventions

- **Deploys are numbered sequentially** (currently at 194). Increment in the
  zip filename, commit message, and any new comment block referencing the
  change. Comment style: `// Deploy 194 (perf): <description>`.
- **Loan IDs**: `l_<timestamp>_<random6>`. Never reuse, never edit, treat as
  immutable once assigned.
- **Client IDs**: `c_<timestamp>_<random6>`.
- **Prospect IDs**: `p_<timestamp>_<random6>`.
- **Envelope IDs**: `env_<timestamp>_<random6>`.
- **Loan keys (frontend cache)**: `<ownerKey>|<clientId>|<loanId>` for the
  triple-keyed lookups in pipeline.html and similar.
- **`_editingLoanId` / `_editingClientId`**: Transient window-level vars set
  by sizer load flows. NEVER persist — strip before save (see Deploy 192's
  `loan-update-from-sizer.mjs` for the right pattern).
- **`_originalAddress`**: Tracks the address a loan was loaded with, so saves
  detect address renames. Reset to the new address on successful save.

---

## API conventions

### Endpoints

`/api/<resource>-<verb>` mapped via `netlify.toml` redirects to
`/.netlify/functions/<resource>-<verb>`. Always update **both** when adding
a new endpoint:

```toml
[[redirects]]
  from = "/api/loan-update-from-sizer"
  to = "/.netlify/functions/loan-update-from-sizer"
  status = 200
  force = true
```

### Response shapes

- Lists: `{ clients: [...] }` for self, `{ byOwner: { 'email': [...] } }`
  for admin `?all=1` mode.
- Mutations: `{ ok: true, <resource>: <updated record> }` on success.
- Errors: `{ error: 'human-readable message' }` with appropriate HTTP status.

### Auth pattern

Every endpoint:
```js
const user = requireAuth(context, req);
if (!user) return json(401, { error: 'Not authenticated' });
```

For admin-only endpoints:
```js
if (!isAdmin(user)) return json(403, { error: 'Admin only' });
```

For owner override (admin editing another LO's data):
```js
if (body.owner && body.owner !== selfEmail) {
  if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
  ownerKey = keySafe(normalizeEmail(body.owner));
}
```

All helpers exported from `netlify/functions/_shared/auth.mjs`:
`handleOptions`, `json`, `requireAuth`, `isAdmin`, `isSuperAdmin`,
`readJsonBody`, `normalizeEmail`, `keySafe`.

---

## The save flow (read this before touching it)

The save flow has been the source of multiple production bugs (Deploys
186–193). Current shape as of Deploy 192:

**Two paths**, decided per-save:

1. **`updateLoanDirect`** (preferred when both IDs are known) — POSTs to
   `/api/loan-update-from-sizer` with `{clientId, loanId, loanData}`. Backend
   reads the client by key, finds loan by ID, merges in place. No matching
   guesswork. This is the path for: sizer opened from Loan Details, sizer
   opened from Pipeline, any flow where the URL has `clientId=` and `loanId=`.

2. **`Clients.upsert`** (fallback for brand-new quotes) — Does a list →
   match-by-email → match-by-loanId-then-address → merge → save dance. Used
   when there's no existing client/loan yet. Has well-known fragility: address
   matching breaks if the borrower-typed address differs from Google Places'
   canonical form ("6525 N Monroe" vs "6525 N Monroe St"). Avoid extending
   this path; if you need a deterministic update, use `updateLoanDirect`.

**UX guarantees** (in both sizers):
- Success toast + green "✓ Saved" button fire **immediately** on click. The
  user always sees feedback within ~16ms. This is non-negotiable — earlier
  attempts to gate the toast on backend completion (Deploys 188–191) created
  the appearance of a broken save when promises hung.
- Failure (rejected promise) fires a **follow-up** toast: "⚠ Save did not
  reach the server: <reason>" + red "⚠ Save failed" button. Real errors are
  surfaced, but slow networks don't block the immediate feedback.

**Preservation rules** in the direct-update endpoint:
- `id`, `createdAt` — frozen, can never be changed by sizer
- `loanAmt` — preserved when `loanAmtLocked` is true (LO manual override)
- `status` — preserved when terminal (`submitted`, `approved`, `denied`).
  A save can move `active` → `on_hold` etc., but never demote.
- App-section fields (`bedrooms`, `bathrooms`, `sqft`, `projectDescription`,
  `notes`) — preserved if the sizer doesn't send them.
- `_editingLoanId`, `_editingClientId` — stripped before write.

---

## Recurring gotchas

### 1. The `rateEl is not defined` class of bugs

The sizer save was undeclared-variable broken for several deploys before we
found it via the browser console. Static `node --check` does NOT catch
undeclared identifiers — JS allows them at parse time and errors at runtime.

Mitigation: when modifying any of `saveCurrentQuote`, `calculate`, or any
sizer pricing function, **manually verify every identifier is declared**.
Better: add ESLint with `no-undef` as a pre-commit hook.

### 2. Address matching is fragile

Google Places returns canonical addresses like `"123 Main St, Spokane, WA
99208"`. Borrowers typing manually may write `"123 Main"` or `"123 Main
Street"`. Any code that matches addresses across records must normalize
generously OR (preferably) match by stored ID instead.

### 3. The pac-container (autocomplete dropdown) bug

Google's autocomplete dropdown will linger after a user picks an option in
some edge cases. The fix in `sla-forms.js` requires **all three** layers:
the `place_changed` handler firing `change` (not `input`), the `bindRoot`
sweep, and the document-level capture-phase click-outside listener. Don't
simplify it.

### 4. Cross-LO admin saves need explicit `owner` parameter

When an admin opens a loan owned by another LO (URL has `?owner=other@lo.com`),
the sizer must pass `ownerOverride` through to `updateLoanDirect` / `upsert`.
The backend then attaches `_owner` to route the write to the right owner key.
If the override is dropped, the save lands on the admin's own account as a
duplicate. The relevant variable is `window._ownerOverride`, set during the
URL-param load phase.

### 5. Quote panel vs. Loan Details are different stores

The "Saved Quotes" panel inside the sizer reads from the `quotes` blob store.
Loan Details reads from the `clients` blob store. A save writes to BOTH. A
quote saved without `borrowerEmail` only writes to `quotes` — Loan Details
won't see it. The save flow now explicitly warns about this case with a
"quote saved locally only" toast.

### 6. Date-effective rate sheets

DSCR pricing constants live in `dscr-sizer.html` as the `DIYA` object. RTL
pricing lives in the same file. Whenever the user provides a new rate sheet
XLSX, we update the constants + the `effectiveDate` string in the same edit.
History: Deploy 191 (5/20/26), Deploy 178 (5/13/26), etc.

### 7. Status flow

`active` → `on_hold` (LO can toggle freely) → `submitted` (via Submit Loan
button on Loan Details) → `approved` / `denied` (admin via decisions.html).
Once `submitted` or beyond, the loan is **terminal** and the sizer save
must not demote the status. The `loan-update-from-sizer.mjs` endpoint
enforces this.

---

## Deploy workflow

Once on Claude Code with git + Netlify continuous deploy:

1. Make changes locally; Claude Code edits files in place.
2. Run `netlify dev` to test against a local copy of the serverless functions
   pointed at the production blob stores (or staging if you set one up).
3. `git commit -m "Deploy 195: <description>"`
4. `git push` — Netlify builds and deploys automatically.
5. Verify on the live site.

If something breaks: `git revert HEAD && git push`. The previous deploy is
live again within ~60s.

Pre-Claude-Code workflow (legacy, currently in use): I generated zip files
under `/mnt/user-data/outputs/SLA_Capital_Deploy_<N>.zip` and you deployed
them manually. The zip files for deploys 185–194 are archived; nothing else
relies on this flow.

---

## Code style preferences

- **Comments**: liberal. Explain WHY the code is the way it is, especially
  when it works around a quirk. The `// Deploy NNN (label): <rationale>`
  comment pattern is great for archaeology — keep it.
- **Function length**: long is fine when it tells a story. Splitting into
  micro-functions makes this codebase harder to read, not easier.
- **var, not let/const**: existing code uses `var`. Stay consistent so a
  search-and-replace doesn't have to fight scoping rules later.
- **No arrow functions in inline `<script>` blocks** unless already used in
  that file. Older browsers in field offices have been an issue.
- **Inline event handlers** (`onclick="foo()"`) are fine and used throughout.
  Don't refactor to addEventListener unless there's a specific reason.
- **Toast errors over alerts**. `showToast()` is defined per-page; prefer it.
- **Diagnostic logs** with `[SLA] <component>:` prefix. Remove once the bug
  they were chasing is fixed (see Deploy 194 cleanup).

---

## Things to be careful with

- **Don't break public URLs**. `apply.html?lo=<email>`, signing links
  (`/sign?token=<X>`), and similar are shared in emails to borrowers. Any
  routing change must preserve these.
- **Don't mass-modify pricing constants** without explicit user confirmation
  and a rate sheet to verify against.
- **Don't introduce a build step**. Keep the no-bundler property. It's a
  feature, not technical debt.
- **Don't touch `pandadoc-*` endpoints/code**. Read-only legacy.
- **PDF generation is jsPDF + pdf-lib**. Term sheets use jsPDF (in the
  sizers); signature stamping uses pdf-lib (in `_shared/native-esign.mjs`).
  They are different libraries with different APIs. Don't mix them up.

---

## Quick reference: where to find things

| I want to... | Look in |
|---|---|
| Add a new API endpoint | `netlify/functions/<name>.mjs` + redirect in `netlify.toml` + helper in `sla-api.js` |
| Change pricing | `dscr-sizer.html` (DIYA const) or `rtl-sizer.html` (BASE_RATE/COLCHIS consts) |
| Modify the term sheet PDF | `dscr-sizer.html` or `rtl-sizer.html`, search for `jsPDF` |
| Touch eSign | `netlify/functions/_shared/native-esign.mjs` + the `envelopes-*.mjs` family |
| Update borrower long-app form | `borrower-info.html` (questionnaire) + `borrower-info-sign.mjs` + `borrower2-auth-sign.mjs` |
| Change pipeline columns/cards | `pipeline.html` |
| Add admin UI | Usually `profile.html` (admin tab) or a dedicated page |
| Debug auth | `netlify/functions/_shared/auth.mjs` |

---

## Environment variables

Set on Netlify dashboard (Site → Settings → Environment variables):

- `RESEND_API_KEY` — transactional email
- `GOOGLE_MAPS_API_KEY` — Places autocomplete (also injected client-side via
  `inject-env.js` at build time as `GOOGLE_MAPS_API_KEY_PUBLIC`)
- `SSN_ENCRYPTION_KEY` — used in `_shared/crypto.mjs` for SSN at rest
- `ESIGN_SEAL_SECRET` — HMAC for native eSign signer tokens
- `BREVO_API_KEY` — marketing list sync
- `SLACK_WEBHOOK_URL` — admin-managed via Settings, not env

---

## Deploy history bookmarks

The numbered deploys that matter for context:

- **185**: PandaDoc replaced with native eSign + signature-line stamping
- **190**: Unassigned-prospect admin reassign + apply.html address validation
- **191**: DIYA 5/20/26 rate sheet + hide line-item adjustments from term sheet
- **192**: `loan-update-from-sizer` direct ID endpoint (sizer save reliability)
- **193**: Fixed the `rateEl is not defined` bug that broke ALL RTL saves
- **194**: Static asset caching + stale-while-revalidate for loan-details + clients

Everything before 185 is in conversational history; if you need detail on an
earlier deploy, ask.
