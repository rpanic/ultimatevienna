import { defineMiddleware } from 'astro:middleware';
import { timingSafeEqual } from 'node:crypto';
import { rateLimitCheck } from './lib/rateLimit';
import { env } from './lib/email';

// Two concerns, gated by path:
//  1. /reimburse/admin* — HTTP Basic auth (ADMIN_USER / ADMIN_PASS). The admin
//     page can approve expenses (which move money), so it must be protected. The
//     site has no other auth today. Admin requests are NOT subject to the
//     public rate limit below — the vorstand is a single authenticated user, and
//     the 2-per-10-min cap would otherwise block normal approve/pay work.
//     When the credentials are unset the admin area is denied with a 503 — it is
//     never left open. Basic auth must be used over HTTPS in production
//     (credentials travel in cleartext otherwise) — noted in .env.example.
//  2. all other POSTs — per-IP rate limit to protect the email-sending public
//     endpoints (onboarding / status / reimbursement submit) from abuse. GETs
//     and static assets are unaffected.

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function unauthorized(): Response {
  return new Response('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="UVie admin", charset="UTF-8"' },
  });
}

function isAdmin(pathname: string): boolean {
  return pathname === '/reimburse/admin' || pathname.startsWith('/reimburse/admin/');
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (isAdmin(pathname)) {
    const user = env('ADMIN_USER');
    const pass = env('ADMIN_PASS');
    if (!user || !pass) {
      console.error('[auth] ADMIN_USER/ADMIN_PASS not set — admin access denied.');
      return new Response('Admin not configured.', { status: 503 });
    }
    const header = context.request.headers.get('authorization');
    if (!header || !header.toLowerCase().startsWith('basic ')) return unauthorized();
    const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx < 0) return unauthorized();
    if (!safeEqual(decoded.slice(0, idx), user) || !safeEqual(decoded.slice(idx + 1), pass)) {
      return unauthorized();
    }
    return next();
  }

  if (context.request.method !== 'POST') return next();

  // Behind a proxy/load balancer the socket address is the proxy, so prefer
  // X-Forwarded-For (set by Docker's bridge / your reverse proxy); fall back to
  // the adapter's clientAddress, then 'unknown' as a last resort.
  const xff = context.request.headers.get('x-forwarded-for');
  const ip = (xff ? xff.split(',')[0]!.trim() : context.clientAddress) ?? 'unknown';

  const { allowed, retryAfterMs } = rateLimitCheck(ip);
  if (!allowed) {
    return new Response(
      JSON.stringify({ message: 'Too many submissions. Please try again later.' }),
      {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': String(Math.ceil(retryAfterMs / 1000)),
        },
      },
    );
  }

  return next();
});