<script lang="ts">
  import { toast } from '#lib/stores/toast.svelte';
</script>
<div class="toasts" role="status" aria-live="polite">
  {#each toast.items as t (t.id)}<div class="t glass" class:warn={t.tone === 'warn'}>{t.text}</div>{/each}
</div>
<style>
  .toasts { position: fixed; top: calc(70px + env(safe-area-inset-top, 0px)); left: 50%; transform: translateX(-50%); display: grid; gap: 8px; z-index: 70; pointer-events: none; }
  .t { padding: 9px 16px; font-size: 13px; animation: in 0.25s ease-out; }
  .warn { border-color: rgba(255, 176, 59, 0.5); color: #ffd9a0; }
  @keyframes in { from { opacity: 0; transform: translateY(-8px); } }
</style>
