// Thin wrapper around the When I Work (WIW) REST API, using a single
// long-lived admin API token (see WHENIWORK_API_TOKEN in .env — obtained
// from a WIW account admin, not an OAuth2 flow). Modeled on
// services/messagingService.ts: raw fetch, env-var credential, small
// exported functions, no business logic.
//
// IMPORTANT: every endpoint path, header name, and payload shape below is a
// placeholder — it has NOT been verified against When I Work's real API
// reference. Confirm each one against the current WIW docs before trusting
// this in production (see Phase 8 of the integration plan). Keeping all WIW
// HTTP calls in this one file means a field-name correction only touches
// this module, not every caller.

const WHENIWORK_API_TOKEN = process.env.WHENIWORK_API_TOKEN || '';
const WHENIWORK_API_BASE_URL = process.env.WHENIWORK_API_BASE_URL || '';

function assertConfigured() {
  if (!WHENIWORK_API_TOKEN || !WHENIWORK_API_BASE_URL) {
    throw new Error('When I Work is not configured — set WHENIWORK_API_TOKEN and WHENIWORK_API_BASE_URL');
  }
}

async function wiwFetch(path: string, init: RequestInit = {}) {
  assertConfigured();

  const res = await fetch(`${WHENIWORK_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // TODO(verify against WIW docs): confirm the expected auth header name
      // and scheme for an admin API token (this assumes a bearer token).
      Authorization: `Bearer ${WHENIWORK_API_TOKEN}`,
      ...(init.headers || {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error: any = new Error(`When I Work API request failed: ${res.status}`);
    error.statusCode = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

// Assigns an open shift to a WIW user — the actual "pick up this shift" call
// pushed to WIW after the local claim commits (see services/wheniworkService.ts
// pickUpShift). TODO(verify against WIW docs): confirm endpoint + payload
// shape for assigning/claiming a shift (e.g. PATCH /shifts/{id} vs a
// dedicated assign endpoint).
async function assignShiftToUser(wheniworkShiftId: string, wheniworkUserId: string) {
  return wiwFetch(`/shifts/${wheniworkShiftId}/assign`, {
    method: 'POST',
    body: JSON.stringify({ user_id: wheniworkUserId }),
  });
}

// TODO(verify against WIW docs): confirm path/response shape.
async function getShift(wheniworkShiftId: string) {
  return wiwFetch(`/shifts/${wheniworkShiftId}`);
}

// Used only by the one-time backfill script (scripts/linkAndBackfillWheniwork.ts)
// to pull everything already open in WIW at cutover, since webhooks only
// cover future changes. TODO(verify against WIW docs): confirm the open-shift
// list endpoint, pagination, and any date-range params.
async function listOpenShifts(sinceISO?: string) {
  const query = sinceISO ? `?since=${encodeURIComponent(sinceISO)}` : '';
  return wiwFetch(`/shifts/open${query}`);
}

// Used only by the backfill script to link existing Inservice employees to
// their WIW user by email. TODO(verify against WIW docs): confirm the user
// lookup-by-email endpoint (WIW may require listing users and filtering
// client-side instead of a direct query param).
async function getUserByEmail(email: string) {
  return wiwFetch(`/users?email=${encodeURIComponent(email)}`);
}

export { assignShiftToUser, getShift, listOpenShifts, getUserByEmail };
