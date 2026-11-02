<script lang="ts">
  type Name = 'wind' | 'storm' | 'history' | 'fire' | 'quake' | 'event' | 'search' | 'play' | 'pause' | 'close' | 'user' | 'locate' | 'layers' | 'pin' | 'bell' | 'chevron' | 'help' | 'arrows' | 'step-back' | 'step-fwd' | 'link' | 'bolt' | 'chart' | 'speaker' | 'speaker-off' | 'cloud';
  let { name, size = 18 }: { name: Name; size?: number } = $props();
  const P: Record<Name, string> = {
    wind: 'M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h8',
    storm: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M12 3c5 0 8 4 7 8M12 21c-5 0-8-4-7-8M3.5 9.5C5 5.5 9 4 12 5M20.5 14.5C19 18.5 15 20 12 19',
    history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
    fire: 'M12 3c1 4 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3-1-6 1-10z',
    quake: 'M2 12h4l2-6 3 12 3-9 2 3h6',
    event: 'M12 3l9 16H3L12 3zM12 10v4M12 17h.01',
    search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M21 21l-5-5',
    play: 'M7 4l13 8-13 8z',
    pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
    close: 'M5 5l14 14M19 5L5 19',
    user: 'M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21c0-4 4-6 8-6s8 2 8 6',
    locate: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v4M12 18v4M2 12h4M18 12h4',
    layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
    pin: 'M12 22s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12zM12 10m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0',
    bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2zM10 21h4',
    chevron: 'M6 9l6 6 6-6',
    cloud: 'M7 18a4 4 0 0 1-.6-7.96A5.5 5.5 0 0 1 17 9a4.5 4.5 0 0 1 .5 9H7z',
    help: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01',
    arrows: 'M12 4v16M12 4l-4 4M12 4l4 4M4 12h16',
    'step-back': 'M6 5v14M19 5L9 12l10 7z',
    'step-fwd': 'M18 5v14M5 5l10 7-10 7z',
    bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
    speaker: 'M4 9v6h4l5 4V5L8 9H4zM16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12',
    'speaker-off': 'M4 9v6h4l5 4V5L8 9H4zM17 9.5l5 5M22 9.5l-5 5',
    chart: 'M4 19V5M4 19h16M8 15l3-4 3 2 5-6',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'
  };
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={P[name]} fill={name === 'play' || name === 'pause' ? 'currentColor' : 'none'} /></svg>
