import { defineMiddleware } from 'astro:middleware';
import { rateLimitCheck } from './lib/rateLimit';

// Rate-limit form submissions (Astro action calls are POSTs) per source IP to
// protect the email-sending endpoints from abuse. Brochure pages (GETs) and
// static assets are unaffected.
export const onRequest = defineMiddleware((context, next) => {
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