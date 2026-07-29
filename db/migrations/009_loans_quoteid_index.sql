-- 009_loans_quoteid_index.sql
-- Fixes the 504 "Inactivity Timeout" on bulk On Hold / Decline / Cancel from
-- the Leads pipeline.
--
-- Post-D2, pipeline tiles are loan-backed. When an LO bulk-decides them,
-- quotes-decide.mjs (and quotes-close.mjs) resolve the tile's id to a loan via
-- the loan's folded quote-id back-reference:
--
--     select ... from loans where extra->>'_quoteId' = '<id>'
--
-- `extra` is a JSONB column with NO index on that expression, so every one of
-- those lookups is a SEQUENTIAL SCAN of the whole loans table. A single
-- decide was tolerable; a bulk action fires many concurrently (Promise.all),
-- the scans pile up, and the gateway kills the request at the inactivity
-- timeout (504) before it can respond. LOs saw "Server returned non-JSON
-- response (HTTP 504) — Inactivity Timeout".
--
-- This expression index turns that scan into an index lookup, so each decide
-- resolves in milliseconds and the bulk action completes well under the
-- timeout. Also speeds quotes-close.mjs / quotes-delete.mjs, which do the same
-- back-reference lookup.
--
-- Run once in the Supabase SQL Editor. Idempotent (IF NOT EXISTS).

create index if not exists loans_extra_quoteid_idx
  on public.loans ((extra->>'_quoteId'));
