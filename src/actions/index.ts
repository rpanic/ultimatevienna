import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro/zod';
import { appendMember, findMemberByEmail } from '../lib/sheets';
import { sendEmail } from '../lib/email';

// Astro Actions are the backend. These are the real implementation backed by
// the Google Sheets client in src/lib/sheets.ts.

const emailSchema = z.string().email().trim().toLowerCase();
const teamSchema = z.enum(['echo', 'foxes']);

// Builds the per-team welcome message shown on the post-onboarding page.
// `firstName` (from the just-submitted registration, passed via query string)
// personalizes the greeting; it is optional so the page still works if someone
// lands on it without coming through the form. Edit these strings to change
// what new members see after registering.
type Team = 'echo' | 'foxes';

function generateWelcomeMessage(team: Team, firstName?: string): { title: string; message: string } {
  const name = firstName?.trim();
  const greeting = name ? `Hi ${name}! ` : '';

  switch (team) {
    case 'echo':
      return {
        title: 'Welcome to Echo / Rumble',
        message:
          `${greeting}Thanks for registering! We’ll be in touch by email with the next steps. Your first practice is Monday 20:00 at KSV Rustenschacher Allee — just bring cleats and water. If you have questions before then, reach out to vorstand@ultimatevienna.net.`,
      };
    case 'foxes':
      return {
        title: 'Welcome to the Foxes',
        message:
          `${greeting}Thanks for registering! We’ll email you the next steps shortly. Foxes practice Wednesday 16:00–18:00 at the Trendsportzentrum Meiereistraße. Parents/guardians are welcome at the first session — bring cleats, water, and a good mood.`,
      };
  }
}

export const server = {
  onboarding: defineAction({
    input: z.object({
      team: teamSchema,
      firstName: z.string().trim().min(1),
      lastName: z.string().trim().min(1),
      email: emailSchema,
      birthDate: z.string().min(1),
      phone: z.string().trim().optional(),
      address: z.string().trim().optional(),
      otherClubs: z.string().trim().optional(),
      payNationalFee: z.boolean().default(false),
    }),
    handler: async (input) => {
      try {
        const result = await appendMember({
          team: input.team,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email,
          birthDate: input.birthDate,
          phone: input.phone,
          address: input.address,
          otherClubs: input.otherClubs,
          payNationalFee: input.payNationalFee,
        });



        await sendEmail(input.email, "You are successfully registered as a club member", "Ultimate Vienna Registration")

        return { ok: true };
      } catch (err) {
        console.error('[action:onboarding] failed:', err);
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not submit registration. Please try again later.',
        });
      }
    },
  }),

  welcomeMessage: defineAction({
    input: z.object({
      team: teamSchema,
      firstName: z.string().trim().optional(),
    }),
    handler: async (input) => {
      // Informational only — generated from the team + optional first name.
      // Can't fail (no I/O), so no try/catch needed.
      return generateWelcomeMessage(input.team, input.firstName);
    },
  }),

  status: defineAction({
    input: z.object({
      email: emailSchema,
    }),
    handler: async (input) => {
      try {
        const lookup = await findMemberByEmail(input.email);

        // Build the status message and deliver it by email to the address
        // owner. sendEmail() never throws and handles the dry-run case.
        const message = lookup.found
          ? `Your Ultimate Vienna membership status is: ${lookup.status}.`
          : `We couldn't find a membership for this email address. If you believe this is a mistake, contact vorstand@ultimatevienna.at.`;
        await sendEmail(input.email, message, 'Your Ultimate Vienna membership status');

        // GDPR: always return the same shape regardless of whether the email
        // exists or whether delivery succeeded. The real status is delivered
        // out-of-band by email, never in this response.
        return { sent: true };
      } catch (err) {
        console.error('[action:status] failed:', err);
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not process request. Please try again later.',
        });
      }
    },
  }),
};
