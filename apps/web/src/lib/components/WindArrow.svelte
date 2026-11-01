<script lang="ts">
  /** Arrow showing where the wind blows TO, given the meteorological FROM direction. */
  let { deg, size = 28 }: { deg: number; size?: number } = $props();
</script>
<svg width={size} height={size} viewBox="0 0 24 24" style="transform: rotate({deg + 180}deg); transition: transform .3s" aria-hidden="true"><path d="M12 2l6 14-6-3-6 3z" fill="var(--accent)" opacity=".9" /></svg>
