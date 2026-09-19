<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { splitByWeights, type SplitEntry } from '../lib/reimbursePure';

// Member-facing reimbursement request form. Posts multipart/form-data (the
// receipt is a file, so this can't use Astro Actions which are JSON) to
// /reimburse/submit, which files the receipt in Drive, appends a "submitted"
// row to the Reimbursements sheet, emails vorstand + the submitter, and returns
// a token; the browser is then sent to /reimburse/done?t=<token>.

const MAX_FILE_MB = 100;

const form = reactive({
  firstName: '',
  lastName: '',
  email: '',
  expenseDate: '',
  description: '',
  total: '', // raw string; parsed for the preview, server parses authoritatively
  files: [] as File[],
  consent: false,
  // Attestations about the receipt — client-side gates (like consent) that make
  // the member confirm the document is usable before submitting, so vorstand
  // gets fewer bad submissions to reject.
  receiptToUvie: false,
  isReceipt: false,
  // Honeypot: hidden from humans; bots that autofill all fields trip it.
  website: '',
});

// The weighted split between people. Each entry is { name, weight }; the share
// amount is derived live from the parsed total (preview only — the server
// re-computes authoritatively on submit).
const split = reactive<SplitEntry[]>([{ name: '', weight: 1 }]);

const status = ref<'idle' | 'loading' | 'error'>('idle');
const errorMessage = ref('');

// Parse a German- or plain-formatted amount for the live preview only. The
// server re-parses with parseAmount (sheets.ts) authoritatively, so this just
// needs to be close enough for the preview.
function parseEuro(raw: string): number {
  const s = raw.trim().replace(/[^0-9,.\-]/g, '');
  if (!s) return 0;
  let norm = s;
  if (norm.includes(',') && norm.includes('.')) {
    norm = norm.replace(/\./g, '').replace(',', '.'); // dot=thousands, comma=decimal
  } else if (norm.includes(',')) {
    norm = norm.replace(',', '.'); // comma is the decimal separator
  }
  const n = parseFloat(norm);
  return Number.isFinite(n) ? n : 0;
}

const parsedTotal = computed(() => parseEuro(form.total));

const shares = computed(() => {
  const entries = split.filter((e) => e.name.trim() && e.weight > 0);
  return splitByWeights(parsedTotal.value, entries);
});

const sharesSum = computed(() =>
  shares.value.reduce((s, e) => s + e.amount, 0),
);

function addPerson() {
  split.push({ name: '', weight: 1 });
}

function removePerson(i: number) {
  if (split.length > 1) split.splice(i, 1);
}

function validate(): string | null {
  if (!form.firstName.trim()) return 'Please enter your first name.';
  if (!form.lastName.trim()) return 'Please enter your last name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) return 'Please enter a valid email address.';
  if (!form.expenseDate) return 'Please enter the date of the expense.';
  if (!form.description.trim()) return 'Please describe the expense.';
  if (parsedTotal.value <= 0) return 'Please enter the receipt total (must be greater than 0).';
  const people = split.filter((e) => e.name.trim());
  if (people.length === 0) return 'Add at least one person to split the expense with.';
  if (people.some((e) => !(e.weight > 0))) return 'Every person needs a weight greater than 0.';
  if (form.files.length === 0) return 'Please attach at least one receipt.';
  for (const f of form.files) {
    if (f.size > MAX_FILE_MB * 1024 * 1024) return `"${f.name}" is too large (max ${MAX_FILE_MB} MB).`;
    if (!f.type.startsWith('image/') && f.type !== 'application/pdf') return `"${f.name}" is not an image or PDF.`;
  }
  if (!form.receiptToUvie) return 'Please confirm the receipt is made out to Ultimate Vienna.';
  if (!form.isReceipt) return 'Please confirm the document is a receipt (not a payment confirmation).';
  if (!form.consent) return 'Please accept the privacy policy to continue.';
  return null;
}

async function onSubmit() {
  status.value = 'idle';
  errorMessage.value = '';

  const validationError = validate();
  if (validationError) {
    status.value = 'error';
    errorMessage.value = validationError;
    return;
  }

  status.value = 'loading';
  try {
    const fd = new FormData();
    fd.append('firstName', form.firstName.trim());
    fd.append('lastName', form.lastName.trim());
    fd.append('email', form.email.trim());
    fd.append('expenseDate', form.expenseDate);
    fd.append('description', form.description.trim());
    fd.append('total', form.total.trim());
    fd.append('consent', 'on');
    fd.append('website', form.website); // honeypot
    for (const f of form.files) fd.append('receipt', f, f.name);
    for (const e of split) {
      if (!e.name.trim()) continue;
      fd.append('splitName', e.name.trim());
      fd.append('splitWeight', String(e.weight));
    }

    const res = await fetch('/reimburse/submit', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      status.value = 'error';
      errorMessage.value = data.error ?? 'Something went wrong submitting your request.';
      return;
    }
    window.location.assign(`/reimburse/done?t=${encodeURIComponent(data.token)}`);
  } catch (e) {
    status.value = 'error';
    errorMessage.value =
      'Something went wrong submitting your request. Please try again later.';
    console.error(e);
  }
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  for (const f of picked) {
    // Skip duplicates (same name + size) when the picker is opened again.
    if (form.files.some((x) => x.name === f.name && x.size === f.size)) continue;
    form.files.push(f);
  }
  // Reset the input so picking the same file again still fires change.
  input.value = '';
}

function removeFile(i: number) {
  form.files.splice(i, 1);
}

function fmt(n: number): string {
  return n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
</script>

<template>
  <form @submit.prevent="onSubmit" class="space-y-5" novalidate>
    <!-- Honeypot: visually hidden, unfocusable; bots that autofill all fields trip it. -->
    <input
      v-model="form.website"
      type="text"
      name="website"
      tabindex="-1"
      autocomplete="off"
      aria-hidden="true"
      style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;"
    />

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
      <div>
        <label for="firstName" class="form-label">First name *</label>
        <input id="firstName" v-model="form.firstName" type="text" class="form-input" autocomplete="given-name" />
      </div>
      <div>
        <label for="lastName" class="form-label">Last name *</label>
        <input id="lastName" v-model="form.lastName" type="text" class="form-input" autocomplete="family-name" />
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
      <div>
        <label for="email" class="form-label">Email *</label>
        <input id="email" v-model="form.email" type="email" class="form-input" autocomplete="email" />
      </div>
      <div>
        <label for="expenseDate" class="form-label">Date of expense *</label>
        <input id="expenseDate" v-model="form.expenseDate" type="date" class="form-input" />
      </div>
    </div>

    <div>
      <label for="description" class="form-label">Description *</label>
      <input id="description" v-model="form.description" type="text" class="form-input" placeholder="e.g. Turnier Salzburg — registration" />
    </div>

    <div>
      <label for="total" class="form-label">Receipt total (€) *</label>
      <input id="total" v-model="form.total" type="text" inputmode="decimal" class="form-input" placeholder="e.g. 150,00" />
    </div>

    <div>
      <span class="form-label">Receipt(s) *</span>
      <div class="flex items-center gap-3">
        <label
          for="receipt"
          class="cursor-pointer inline-flex items-center px-4 py-[.55rem] rounded-lg border border-border bg-bg text-text text-[.9rem] font-medium hover:border-text transition-colors duration-250"
        >
          Choose files
        </label>
        <input
          id="receipt"
          type="file"
          multiple
          accept="image/*,application/pdf"
          class="sr-only"
          @change="onFile"
        />
        <span class="text-[.85rem] text-text-light">
          {{ form.files.length === 0 ? 'No files selected' : `${form.files.length} file${form.files.length === 1 ? '' : 's'} selected` }}
        </span>
      </div>

      <ul v-if="form.files.length > 0" class="list-none mt-3 space-y-1">
        <li
          v-for="(f, i) in form.files"
          :key="`${f.name}-${f.size}-${i}`"
          class="flex items-center justify-between gap-3 bg-bg rounded px-3 py-2 border border-border text-[.85rem]"
        >
          <span class="text-text truncate">{{ f.name }} <span class="text-text-light whitespace-nowrap">({{ (f.size / 1024 / 1024).toFixed(1) }} MB)</span></span>
          <button
            type="button"
            class="text-text-light hover:text-text px-1 text-[1.1rem] leading-none"
            aria-label="Remove file"
            @click="removeFile(i)"
          >&times;</button>
        </li>
      </ul>

      <p class="text-[.8rem] text-text-light mt-2">Images or PDFs, max {{ MAX_FILE_MB }} MB each. We file them in the club's Drive folder for the vorstand.</p>
    </div>

    <div>
      <div class="flex items-center justify-between mb-2">
        <span class="form-label !mb-0">Split between people *</span>
        <div class="flex gap-3">
          <button type="button" class="text-[.8rem] font-semibold text-accent hover:text-accent-light transition-colors duration-250" @click="addPerson">+ Add person</button>
        </div>
      </div>
      <p class="text-[.8rem] text-text-light mb-3">Enter each person by name and a weight (e.g. 1 each for an even split, or 1 and 2 for a 1/3 — 2/3 split). Use the names as they appear on the club's Guthaben list.</p>

      <div v-for="(entry, i) in split" :key="i" class="flex items-start gap-2 mb-2">
          <input
              v-model.number="entry.weight"
              type="number"
              min="0"
              step="any"
              placeholder="weight"
              class="form-input max-w-[65px]"
          />
        <input
          v-model="entry.name"
          type="text"
          placeholder="Full name"
          class="form-input flex-1"
        />
        <button
          type="button"
          :disabled="split.length === 1"
          class="px-3 py-[.55rem] rounded-lg border border-border text-text-light hover:text-text disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-250"
          @click="removePerson(i)"
          aria-label="Remove person"
        >&times;</button>
      </div>

      <div v-if="shares.length > 0" class="mt-3 bg-bg rounded-lg p-4 border border-border">
        <p class="text-[.8rem] font-semibold uppercase tracking-wider text-text-light mb-2">Preview</p>
        <ul class="list-none space-y-1 text-[.9rem]">
          <li v-for="s in shares" :key="s.name" class="flex justify-between">
            <span class="text-text">{{ s.name }}</span>
            <span class="text-text font-medium">{{ fmt(s.amount) }} €</span>
          </li>
        </ul>
        <p class="text-[.8rem] text-text-light mt-2 pt-2 border-t border-border">
          Sum: <span class="font-semibold text-text">{{ fmt(sharesSum) }} €</span>
          <span v-if="parsedTotal > 0" class="ml-1">/ receipt total {{ fmt(parsedTotal) }} €</span>
        </p>
      </div>
    </div>

    <label class="flex items-start gap-3 cursor-pointer">
      <input v-model="form.receiptToUvie" type="checkbox" class="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
      <span class="text-[.9rem] text-text">
        The receipt is made out to <strong>Ultimate Vienna</strong> as the recipient (not to me personally or another club).
        <span class="text-primary">*</span>
      </span>
    </label>

    <label class="flex items-start gap-3 cursor-pointer">
      <input v-model="form.isReceipt" type="checkbox" class="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
      <span class="text-[.9rem] text-text">
        This is a receipt (Rechnung/Quittung) &mdash; not a payment confirmation, bank statement, or order confirmation.
        <span class="text-primary">*</span>
      </span>
    </label>

    <label class="flex items-start gap-3 cursor-pointer">
      <input v-model="form.consent" type="checkbox" class="mt-1 h-4 w-4 accent-[var(--color-accent)]" />
      <span class="text-[.9rem] text-text">
        I have read and agree to the
        <a href="/imprint#privacy" @click.stop class="text-accent hover:text-accent-light transition-colors duration-250 underline">privacy policy</a>.
        My request data and receipt are stored to process this reimbursement.
        <span class="text-primary">*</span>
      </span>
    </label>

    <div v-if="status === 'error'" class="rounded-lg bg-accent/10 border border-accent/30 text-accent px-4 py-3 text-[.9rem]">
      {{ errorMessage }}
    </div>

    <button
      type="submit"
      :disabled="status === 'loading'"
      class="inline-flex items-center justify-center px-6 py-[.65rem] rounded-lg font-semibold text-[.9rem] bg-accent text-white hover:bg-accent-light transition-colors duration-250 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {{ status === 'loading' ? 'Submitting…' : 'Submit reimbursement request' }}
    </button>
  </form>
</template>

<style scoped>
.form-label {
  display: block;
  font-size: .8rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .05em;
  color: var(--color-text-light);
  margin-bottom: .35rem;
}
.form-input {
  width: 100%;
  padding: .55rem .75rem;
  border: 1px solid var(--color-border);
  border-radius: .5rem;
  background: var(--color-surface);
  font-size: .95rem;
  color: var(--color-text);
  transition: border-color .2s ease;
}
.form-input:focus {
  outline: none;
  border-color: var(--color-accent);
}
</style>
