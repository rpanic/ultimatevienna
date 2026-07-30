import type { APIRoute } from 'astro';

export const prerender = false;

// TODO(later): append a row to the Members Google Sheet via the Rust/Axum
// backend (or replace this endpoint with that service). The request/response
// shape below is the contract the backend must implement.

interface OnboardingBody {
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  birthDate?: unknown;
  phone?: unknown;
  address?: unknown;
  otherClubs?: unknown;
  payNationalFee?: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export const POST: APIRoute = async ({ request }) => {
  let body: OnboardingBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const missing: string[] = [];
  if (!isString(body.firstName) || !body.firstName.trim()) missing.push('firstName');
  if (!isString(body.lastName) || !body.lastName.trim()) missing.push('lastName');
  if (!isString(body.email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()))
    missing.push('email');
  if (!isString(body.birthDate) || !body.birthDate) missing.push('birthDate');

  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: 'Missing or invalid fields', fields: missing }), {
      status: 422,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Stub: log so the submission is observable during development.
  console.log('[onboarding] received registration:', {
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    birthDate: body.birthDate,
    phone: body.phone,
    address: body.address,
    otherClubs: body.otherClubs,
    payNationalFee: body.payNationalFee,
  });

  return new Response(JSON.stringify({ ok: true }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
};