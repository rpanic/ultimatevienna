import type { APIRoute } from 'astro';
import { isValidEmail } from '../../lib/api';
import { sendEmail, env } from '../../lib/email';
import { parseAmount } from '../../lib/sheets';
import {
  appendReimbursement,
  nextReimburseId,
  renderReimbursementEmail,
  uploadReceiptToDrive,
  splitByWeights,
  type PayoutMethod,
  type ReimburseEmailSummary,
  type SplitEntry,
} from '../../lib/reimbursement/reimburse';
import { storeReimburse } from '../../lib/reimbursement/reimburseStore';

// On-demand: reads the multipart body + contacts Drive/Sheets at request time.
export const prerender = false;

// Member-facing reimbursement submission. Receives multipart/form-data (the
// receipt is a file), files it in Drive, appends a "submitted" row to the
// Reimbursements sheet, emails the submitter + vorstand, and returns a token the
// browser uses to load /reimburse/done. Public rate limiting is handled by the
// middleware (it rate-limits all non-admin POSTs).

const MAX_FILE_MB = 100;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, url }) => {
  let fd: FormData;
  try {
    fd = await request.formData();
  } catch {
    return json({ ok: false, error: 'Invalid form data.' }, 400);
  }

  const get = (k: string) => String(fd.get(k) ?? '').trim();
  // Honeypot tripped → silently appear to succeed with no side effects.
  if (get('website')) return json({ ok: true });

  const firstName = get('firstName');
  const lastName = get('lastName');
  const email = get('email').toLowerCase();
  const expenseDate = get('expenseDate');
  const description = get('description');
  const totalRaw = get('total');
  const payoutMethod = get('payoutMethod');
  const consent = String(fd.get('consent') ?? '');

  if (!firstName || !lastName) return json({ ok: false, error: 'Please enter your name.' }, 400);
  if (!isValidEmail(email)) return json({ ok: false, error: 'Please enter a valid email address.' }, 400);
  if (!expenseDate) return json({ ok: false, error: 'Please enter the date of the expense.' }, 400);
  if (!description) return json({ ok: false, error: 'Please describe the expense.' }, 400);
  const total = parseAmount(totalRaw);
  if (total === null || total <= 0) return json({ ok: false, error: 'Please enter the receipt total (must be greater than 0).' }, 400);
  if (payoutMethod !== 'credit' && payoutMethod !== 'bankTransfer') {
    return json({ ok: false, error: 'Please choose how you would like to be reimbursed.' }, 400);
  }
  if (!consent) return json({ ok: false, error: 'Please accept the privacy policy to continue.' }, 400);

  // Split: splitName / splitWeight are sent as parallel repeated fields.
  const names = fd.getAll('splitName').map((s) => String(s).trim()).filter(Boolean);
  const weightsRaw = fd.getAll('splitWeight');
  if (names.length === 0) return json({ ok: false, error: 'Add at least one person to split the expense with.' }, 400);
  const entries: SplitEntry[] = [];
  for (let i = 0; i < names.length; i++) {
    const w = parseAmount(String(weightsRaw[i] ?? '1')) ?? 1;
    entries.push({ name: names[i], weight: w > 0 ? w : 0 });
  }
  if (entries.some((e) => !(e.weight > 0))) {
    return json({ ok: false, error: 'Every person needs a weight greater than 0.' }, 400);
  }

  // Receipts (server-side type + size validation, not just client). One or more
  // files, sent as repeated "receipt" fields.
  const files = fd.getAll('receipt').filter((f): f is File => f instanceof File);
  if (files.length === 0) return json({ ok: false, error: 'Please attach at least one receipt.' }, 400);
  for (const f of files) {
    if (f.size > MAX_FILE_MB * 1024 * 1024) return json({ ok: false, error: `"${f.name}" is too large (max ${MAX_FILE_MB} MB).` }, 400);
    if (!f.type.startsWith('image/') && f.type !== 'application/pdf') {
      return json({ ok: false, error: `"${f.name}" is not an image or PDF.` }, 400);
    }
  }

  const submitterName = `${firstName} ${lastName}`;
  const shares = splitByWeights(total, entries);
  const id = await nextReimburseId();

  // Upload each file; collect the Drive links (stored as a JSON array).
  const receiptLinks: string[] = [];
  let receiptsUploaded = false;
  for (const f of files) {
    const upload = await uploadReceiptToDrive(
      { name: f.name, type: f.type, buffer: await f.arrayBuffer() },
      { id, submitterName, expenseDate },
    );
    if (!upload.dryRun && upload.link) {
      receiptLinks.push(upload.link);
      receiptsUploaded = true;
    }
  }
  const receiptLink = JSON.stringify(receiptLinks);

  await appendReimbursement({
    id,
    submitterName,
    submitterEmail: email,
    expenseDate,
    description,
    total,
    split: shares,
    receiptLink,
    payoutMethod,
  });

  // Email the submitter a confirmation (rendered HTML summary) and notify the
  // vorstand with the same card (admin variant: with receipt links + review URL).
  const summary: ReimburseEmailSummary = {
    id,
    submitterName,
    submitterEmail: email,
    expenseDate,
    description,
    total,
    split: shares,
    payoutMethod: payoutMethod as PayoutMethod,
    receiptCount: files.length,
    receiptLinks,
    receiptUploaded: receiptsUploaded,
  };
  const adminUrl = `${url.origin}/reimburse/admin`;

  await sendEmail(email, { html: await renderReimbursementEmail(summary, 'member') }, 'Ultimate Vienna — reimbursement received');

  const notif = env('NOTIFICATION_EMAIL');
  if (notif) {
    await sendEmail(notif, { html: await renderReimbursementEmail(summary, 'admin', adminUrl) }, 'New reimbursement request');
  }

  const token = storeReimburse({
    id,
    submitterName,
    submitterEmail: email,
    expenseDate,
    description,
    total,
    split: shares,
    receiptCount: files.length,
    receiptUploaded: receiptsUploaded,
    status: 'submitted',
    payoutMethod,
  });

  return json({ ok: true, token });
};
