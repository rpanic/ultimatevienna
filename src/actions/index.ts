import { defineAction, ActionError } from 'astro:actions';
import { z } from 'astro/zod';
import { appendMember, findMemberByEmail } from '../lib/sheets';
import { env, sendEmail } from '../lib/email';
import { getMembershipInfo, renderMembershipEmail } from "../lib/membership.ts";
import { storeResult } from '../lib/resultStore';

// Astro Actions are the backend. These are the real implementation backed by
// the Google Sheets client in src/lib/sheets.ts.

const emailSchema = z.string().email().trim().toLowerCase();
const teamSchema = z.enum(['echo', 'foxes']);

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
      student: z.boolean().default(false),
      // Club the member says they already paid this season's membership fee
      // to ('none' if not). Removes that club's payment from the confirmation.
      alreadyPaidClub: z.enum(['none', 'UVie', 'EÖFC']).default('none'),
      // Echo/rumble only: the member already paid the Symbiosepauschale to the
      // other club too, so that payment is also dropped. Foxes can't set this.
      alreadyPaidSymbiose: z.boolean().default(false),
      // Honeypot: a visually-hidden field humans leave empty. See handler.
      website: z.string().trim().optional(),
    }),
    handler: async (input) => {
      // Honeypot tripped → silently appear to succeed with no side effects
      // (no sheet write, no emails) so bots get no signal and no abuse vector.
      if (input.website) {
        return { ok: true, token: '' };
      }
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
          student: input.student,
          alreadyPaidClub: input.alreadyPaidClub,
          alreadyPaidSymbiose: input.alreadyPaidSymbiose,
        });

        // Build the membership summary once: it drives both the email and the
        // on-screen result page (same data, same component).
        const info = await getMembershipInfo(result);
        const html = await renderMembershipEmail(info);

        await sendEmail(input.email, { html }, 'Ultimate Vienna Registration');

        const notificationEmail = env("NOTIFICATION_EMAIL")
        await sendEmail(notificationEmail!, { text: `New member registered: ${input.firstName} ${input.lastName} (${input.email}).'\nJugend: ${input.student}, ÖUV: ${input.payNationalFee}, Bereits bezahlt: ${input.alreadyPaidClub}, Symbiose bereits bezahlt: ${input.alreadyPaidSymbiose ? 'ja' : 'nein'}` }, "New member registered")

        // Stash the summary under an opaque token so the result page can render
        // it without putting personal data in the URL.
        const token = storeResult(info);

        return { ok: true, token };
      } catch (err) {
        console.error('[action:onboarding] failed:', err);
        throw new ActionError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Could not submit registration. Please try again later.',
        });
      }
    },
  }),

  status: defineAction({
    input: z.object({
      email: emailSchema,
      // Honeypot: a visually-hidden field humans leave empty. See handler.
      website: z.string().trim().optional(),
    }),
    handler: async (input) => {
      // Honeypot tripped → silently appear to succeed (no lookup, no email),
      // matching the action's usual non-leaky "sent: true" shape.
      if (input.website) {
        return { sent: true };
      }
      try {
        const lookup = await findMemberByEmail(input.email);

        // Build the status message and deliver it by email to the address
        // owner. sendEmail() never throws and handles the dry-run case.
        const message = lookup.found
          ? `Your Ultimate Vienna membership status is: ${lookup.status}.`
          : `We couldn't find a membership for this email address. If you believe this is a mistake, contact vorstand@ultimatevienna.net.`;
        await sendEmail(input.email, { text: message }, 'Your Ultimate Vienna membership status');

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
