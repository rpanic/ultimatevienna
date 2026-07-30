import type { APIRoute } from 'astro';

export const prerender = false;

// TODO(later): look up the member row in the Google Sheet (via the Rust/Axum
// backend) and email the membership status to the address owner.
//
// IMPORTANT (GDPR): this endpoint must NOT reveal whether an email exists in
// the sheet. It always returns the same response shape. The actual status is
// delivered out-of-band by email, never in the response body.

interface StatusBody {
  email?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export const POST: APIRoute = async ({ request }) => {
  let body: StatusBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isString(body.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
    return new Response(JSON.stringify({ error: 'Invalid email' }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Stub: in production this would trigger the email delivery.
  console.log('[status] status request for:', body.email);

  return new Response(JSON.stringify({ sent: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};