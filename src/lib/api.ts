// Thin typed fetch helpers used by the Vue islands.
//
// The islands post same-origin to the Astro API stub endpoints in
// src/pages/api/*. These stubs document the contract the future Rust/Axum
// backend will implement (or that these endpoints will proxy to).

export interface OnboardingPayload {
  firstName: string;
  lastName: string;
  email: string;
  birthDate: string;
  phone?: string;
  address?: string;
  otherClubs?: string;
  payNationalFee: boolean;
}

export interface StatusPayload {
  email: string;
}

async function postJson<T>(url: string, body: T): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function submitOnboarding(payload: OnboardingPayload): Promise<Response> {
  return postJson('/api/onboarding', payload);
}

export function submitStatus(payload: StatusPayload): Promise<Response> {
  return postJson('/api/status', payload);
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}