<script setup lang="ts">
import { reactive, ref } from 'vue';
import { actions } from 'astro:actions';
import { isValidEmail } from '../lib/api';

const props = defineProps<{ team: 'echo' | 'foxes' }>();

const form = reactive({
  firstName: '',
  lastName: '',
  email: '',
  birthDate: '',
  phone: '',
  address: '',
  otherClubs: '',
  payNationalFee: true,
  student: false,
});

const status = ref<'idle' | 'loading' | 'success' | 'error'>('idle');
const errorMessage = ref('');

function validate(): string | null {
  if (!form.firstName.trim()) return 'Please enter your first name.';
  if (!form.lastName.trim()) return 'Please enter your last name.';
  if (!isValidEmail(form.email)) return 'Please enter a valid email address.';
  if (!form.birthDate) return 'Please enter your date of birth.';
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
    const { data, error } = await actions.onboarding({
      team: props.team,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim(),
      birthDate: form.birthDate,
      phone: form.phone.trim() || undefined,
      address: form.address.trim() || undefined,
      otherClubs: form.otherClubs.trim() || undefined,
      payNationalFee: form.payNationalFee,
      // Foxes has no student discount — never send student=true for that team,
      // even if the checkbox somehow held a stale value.
      student: props.team === 'foxes' ? false : form.student,
    });
    if (error || !data) {
      status.value = 'error';
      errorMessage.value = error?.message ?? 'Something went wrong.';
      return;
    }
    // Registration is valid (written to the sheet + email queued). The action
    // returns an opaque token that lets the result page render the same
    // membership summary that was emailed.
    window.location.assign(`/join/${props.team}/done?t=${encodeURIComponent(data.token)}`);
  } catch (e) {
    status.value = 'error';
    errorMessage.value =
      'Something went wrong submitting your registration. Please try again later.';
    console.error(e);
  }
}
</script>

<template>
  <form @submit.prevent="onSubmit" class="space-y-5" novalidate>
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
        <label for="birthDate" class="form-label">Date of birth *</label>
        <input id="birthDate" v-model="form.birthDate" type="date" class="form-input" />
      </div>
    </div>

    <div class="grid grid-cols-1 sm:grid-cols-2 gap-5">
      <div>
        <label for="phone" class="form-label">Phone</label>
        <input id="phone" v-model="form.phone" type="tel" class="form-input" autocomplete="tel" />
      </div>
      <div>
        <label for="address" class="form-label">Address</label>
        <input id="address" v-model="form.address" type="text" class="form-input" autocomplete="street-address" />
      </div>
    </div>

    <div>
      <label for="otherClubs" class="form-label">Other current clubs</label>
      <input id="otherClubs" v-model="form.otherClubs" type="text" class="form-input" placeholder="e.g. none / club name" />
    </div>

    <label class="flex items-start gap-3 cursor-pointer">
      <input v-model="form.payNationalFee" type="checkbox" class="mt-1 h-4 w-4 accent-[var(--color-accent)]"/>
      <span class="text-[.9rem] text-text">Should Ultimate Vienna pay your national club (ÖUV) fee on your behalf? Necessary to play championships. Only necessary to pay once, if other clubs already pay it for you, uncheck this.</span>
    </label>

    <label
      v-if="props.team !== 'foxes'"
      class="flex items-start gap-3 cursor-pointer"
    >
      <input
        v-model="form.student"
        type="checkbox"
        class="mt-1 h-4 w-4 accent-[var(--color-accent)] disabled:opacity-50"
      />
      <span class="text-[.9rem] text-text">
        I am a student (university or high school) and want to use the reduced membership fee (130€).
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
      {{ status === 'loading' ? 'Submitting…' : 'Submit registration' }}
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
