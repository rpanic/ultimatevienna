<script setup lang="ts">
import { reactive, ref } from 'vue';
import { actions } from 'astro:actions';
import { isValidEmail } from '../lib/api';

const form = reactive({ email: '' });
const status = ref<'idle' | 'loading' | 'done'>('idle');
const invalid = ref(false);

async function onSubmit() {
  invalid.value = false;
  if (!isValidEmail(form.email)) {
    invalid.value = true;
    return;
  }

  status.value = 'loading';
  try {
    // The response is intentionally ignored: the backend emails the result to
    // the address owner and we show the same message regardless of outcome,
    // so the page cannot be used to enumerate who is a member.
    await actions.status({ email: form.email.trim() });
  } catch (e) {
    console.error(e);
  } finally {
    status.value = 'done';
  }
}
</script>

<template>
  <form @submit.prevent="onSubmit" class="space-y-5" novalidate>
    <div>
      <label for="statusEmail" class="form-label">Email</label>
      <input
        id="statusEmail"
        v-model="form.email"
        type="email"
        class="form-input"
        autocomplete="email"
        :disabled="status === 'done'"
      />
      <p v-if="invalid" class="mt-2 text-[.85rem] text-accent">Please enter a valid email address.</p>
    </div>

    <button
      v-if="status !== 'done'"
      type="submit"
      :disabled="status === 'loading'"
      class="inline-flex items-center justify-center px-6 py-[.65rem] rounded-lg font-semibold text-[.9rem] bg-accent text-white hover:bg-accent-light transition-colors duration-250 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {{ status === 'loading' ? 'Sending…' : 'Send my status' }}
    </button>

    <div v-if="status === 'done'" class="rounded-lg bg-surface border-l-4 border-accent px-4 py-4">
      <p class="text-[.95rem] text-text">If your email is on file, we&rsquo;ve sent your membership status to it.</p>
      <p class="text-[.85rem] text-text-light mt-1">Please check your inbox (and spam folder).</p>
    </div>
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
.form-input:disabled {
  opacity: .7;
}
</style>