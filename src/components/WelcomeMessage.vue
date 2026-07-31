<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { actions } from 'astro:actions';

const props = defineProps<{ team: 'echo' | 'foxes' }>();

const state = ref<'loading' | 'loaded' | 'error'>('loading');
const title = ref('');
const message = ref('');

onMounted(async () => {
  try {
    // The first name is passed from the form via the query string so the
    // message can greet the new member personally. Optional — the page still
    // works if it's absent.
    const params = new URLSearchParams(window.location.search);
    const firstName = params.get('firstName') ?? undefined;

    const { data, error } = await actions.welcomeMessage({ team: props.team, firstName });
    if (error || !data) {
      state.value = 'error';
      return;
    }
    title.value = data.title;
    message.value = data.message;
    state.value = 'loaded';
  } catch (e) {
    console.error(e);
    state.value = 'error';
  }
});
</script>

<template>
  <div>
    <p v-if="state === 'loading'" class="text-text-light text-[.95rem]">Loading your welcome message…</p>

    <div v-else-if="state === 'loaded'">
      <h3 class="font-heading text-2xl text-primary mb-3">{{ title }}</h3>
      <p class="text-text leading-relaxed whitespace-pre-line">{{ message }}</p>
    </div>

    <p v-else class="text-text-light text-[.95rem]">
      Thanks for registering &mdash; we&rsquo;ll be in touch by email with the next steps.
    </p>
  </div>
</template>