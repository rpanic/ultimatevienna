// Validation helpers shared by the Vue islands.
// Backend calls go through Astro Actions (astro:actions), not fetch.

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}