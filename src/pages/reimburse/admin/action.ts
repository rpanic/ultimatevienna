import type { APIRoute } from 'astro';
import { sendEmail } from '../../../lib/email';
import {
  listReimbursements,
  appendApprovedExpenseToDebtSheet,
  updateReimburseStatus,
} from '../../../lib/reimbursement/reimburse';

// On-demand: reads the form body + writes to the Reimbursements / debt sheet at
// request time. Basic auth is enforced by the middleware.
export const prerender = false;

// Vorstand actions on a reimbursement request. Basic auth is enforced by the
// middleware (this route lives under /reimburse/admin). The browser re-sends the
// Basic-auth header automatically, so plain form POSTs + a redirect back to the
// list just work. Input is form-encoded: id + action (approve | pay | reject).

function errorPage(title: string, detail: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>` +
      `<style>body{font-family:Inter,system-ui,sans-serif;max-width:560px;margin:3rem auto;padding:0 1.5rem;color:#1a1a1a}` +
      `h1{color:#b91c1c;font-size:1.4rem}a{color:#c2410c}</style></head>` +
      `<body><h1>${title}</h1><p>${detail}</p>` +
      `<p><a href="/reimburse/admin">&larr; Back to reimbursements</a></p></body></html>`,
    { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

export const POST: APIRoute = async ({ request, redirect }) => {
  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return errorPage('Invalid request', 'The form data could not be read.');
  }
  const id = String(fd.get('id') ?? '').trim();
  const action = String(fd.get('action') ?? '').trim();

  if (!id) return errorPage('Missing request', 'No reimbursement ID was provided.');

  const record = (await listReimbursements()).find((r) => r.id === id);
  if (!record) return errorPage('Not found', `Reimbursement ${id} was not found.`);

  try {
    if (action === 'approve') {
      if (record.status !== 'submitted') {
        return errorPage('Cannot approve', `Reimbursement ${id} is already ${record.status}.`);
      }
      // Write the split into the debt sheet first. If any split name doesn't
      // resolve to a member column, block — never write a partial row.
      const write = await appendApprovedExpenseToDebtSheet({
        id,
        expenseDate: record.expenseDate,
        description: record.description,
        split: record.split,
      });
      if (write.unresolved.length > 0) {
        const names = write.unresolved.map((n) => `"${n}"`).join(', ');
        return errorPage(
          'Could not approve',
          `These split names didn't match a column in the Guthaben list: ${names}. ` +
            `Correct the names (use them as they appear in the list) and try again. ` +
            (write.dryRun ? '(Debt sheet not configured — dry run.' : '(Nothing was written to the debt sheet.'),
        );
      }
      await updateReimburseStatus(id, { status: 'approved', approvedAt: new Date().toISOString() });
      await sendEmail(
        record.submitterEmail,
        { text: `Your reimbursement request ${id} (${record.total.toLocaleString('de-DE')} € for "${record.description}") was approved and added to the Guthaben list. You'll be reimbursed once it's paid — we'll email you again then.` },
        'Ultimate Vienna — reimbursement approved',
      );
    } else if (action === 'pay') {
      if (record.status !== 'approved') {
        return errorPage('Cannot pay', `Reimbursement ${id} must be approved first (it is ${record.status}).`);
      }
      await updateReimburseStatus(id, { status: 'paid', paidAt: new Date().toISOString() });
      const paidLine = record.payoutMethod === 'credit'
        ? 'has been added as credit to your Guthaben account'
        : 'has been paid to your bank account';
      await sendEmail(
        record.submitterEmail,
        { text: `Your reimbursement request ${id} (${record.total.toLocaleString('de-DE')} € for "${record.description}") ${paidLine}. Thank you!` },
        'Ultimate Vienna — reimbursement paid',
      );
    } else if (action === 'reject') {
      if (record.status !== 'submitted') {
        return errorPage('Cannot reject', `Reimbursement ${id} is already ${record.status}.`);
      }
      await updateReimburseStatus(id, { status: 'rejected' });
      await sendEmail(
        record.submitterEmail,
        { text: `Your reimbursement request ${id} (${record.total.toLocaleString('de-DE')} € for "${record.description}") could not be approved. Please contact vorstand@ultimatevienna.net for details.` },
        'Ultimate Vienna — reimbursement update',
      );
    } else {
      return errorPage('Unknown action', `The action "${action}" is not recognised.`);
    }
  } catch (err) {
    console.error('[reimburse:admin/action] failed:', err);
    return errorPage('Something went wrong', 'The action could not be completed. Please try again.');
  }

  return redirect('/reimburse/admin', 302);
};