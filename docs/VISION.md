# StormTrack — the vision

**The atmosphere as a live instrument you can play, question and trust.**
Windy shows you the weather. StormTrack lets you *understand storms*: where they came from, what
history says they will do, how sure the models are, and what it means for the place you care about.
It is fast, beautiful, a little alive, and honest about what it knows.

## Why it wins (what Windy and others don't do)
1. **Storm science, not just storm pictures.** Our engine already unifies IMD, IBTrACS, NHC and JTWC best tracks and can verify forecasts.
   Nobody shows *"storms like this one, historically"*, *"IMD vs JTWC disagree here"*, or *"how wrong have forecasts like this been?"*
2. **India and the Indian Ocean first-class**, not an afterthought: IMD grades, Bay of Bengal / Arabian Sea climatology, cyclone seasons.
3. **Alive.** Lightning that flashes and *sounds*; wind that flows; a storm you can scrub through time. It should feel like touching the planet.
4. **Honest.** Every layer shows source, run time, licence, and uncertainty. We cite papers. We say "unofficial", "sampled", "approximate".
5. **Instant.** Static data on a CDN, GPU rendering, everything cached: first wind in ~2 s, then no spinners.

## Signature experiences

| # | Experience | What it is | Data status |
|---|---|---|---|
| 1 | **Living globe** | Wind particles, clouds-style fields, storms, fires, quakes, **live lightning with synthesised thunder**, day/night terminator, calm dark design | wind, storms, hazards, GLM lightning: built/verified. India lightning: unofficial prototype |
| 2 | **Storm Studio** | Click a storm → cinematic fly-in and a story panel: track so far, forecast cone, **ensemble "spaghetti" of the possible tracks**, intensity timeline, landfall countdown, who agrees (IMD / JTWC / NHC), and **historical analogues** ("5 storms with a similar track: Amphan 2020 …") | tracks/forecast: verified; analogues: computable from IBTrACS now; spaghetti: NHC a-decks hold the GEFS members (verified for the Atlantic); Indian Ocean via ECMWF ensemble tracks needs a spike |
| 3 | **Time machine** | One slider from −10 days to +10 days; past = analysis/observations, future = models, with a clear seam; loop, speed, export as a video/GIF | GFS/ECMWF/AIFS forecast frames: in progress; the past needs archived analyses (spike) |
| 4 | **Model duel** | Swipe split-screen: GFS vs ECMWF vs **AIFS (AI model)**; a "where do they disagree?" map as a first-class layer | all three open: in progress |
| 5 | **Click-anywhere meteogram** | Tap a point → instant wind / pressure / temperature / rain timeline, drawn from frames already in memory | in progress |
| 6 | **Ask anything** | ⌘K in plain language: *"will it rain in Pune on Friday?"*, *"show storms like Fani"*, *"where is the jet stream strongest?"* → sets the view. An optional **AI storm brief** (plain-language, every number cited from our data, with the uncertainty stated) | needs an LLM API and a key; design as a thin layer over data we already hold |
| 7 | **Your places, your alerts** | Saved places; "a cyclone is within 500 km", "lightning within 20 km of home" (with a sound), by push notification / PWA; a shareable card per storm | auth and tables: built (Supabase); push is new |
| 8 | **Soundscape mode** | Sonified weather for ambience and accessibility: wind as a soft bed, lightning as thunder, storm intensity as a tone | builds on the lightning audio engine |
| 9 | **Scientist mode** | Raw numbers on hover, contour intervals, levels (850…250 hPa), export PNG / GeoTIFF / CSV, citations ("how this was computed") | levels/fields: in progress |
| 10 | **Embeddable + API** | A storm widget for newsrooms and schools; a read-only data API | later |

## Look and feel
- **Quiet UI, loud data.** The planet is the interface; panels are dark glass that get out of the way. One accent family (cyan → violet), colour carries meaning (intensity category), never decoration.
- **Motion with physics.** Fly-tos ease like a camera on a rig; particles never stutter (they degrade, not drop frames); time scrubbing is inertial.
- **Typography:** tabular numerals for every measurement; short labels; plain-language units alongside (kt, km/h, Beaufort).
- **Sound is a feature, never a surprise:** off until you ask, always one click to mute, never louder than a whisper by default.
- **Safe by default:** no full-screen flashing, reduced-motion honoured, WCAG contrast, keyboard everything, screen-reader summaries ("2 active cyclones: …").
- **Private:** your location stays on your device unless you save a place; no ad trackers.

## Build order (each step shippable)
1. **Now:** models + levels + scalar layers/isobars + meteogram + all-basin history + lightning data (in flight).
2. **Live lightning** (animated, with sound): the first thing that makes people say "wow".
3. **Storm Studio:** analogues + multi-agency + cone/ensemble: our moat.
4. **Model duel + time machine.**
5. **Alerts / PWA / share cards,** then **Ask anything + AI brief.**
6. Scientist mode, embeds, API.

## Open decisions for the owner
- **Name (decided 2026-11-02: working name "StormTrack", AtmosPy as the org/maker).** Risk found the same day: *StormTrack* is already
  used for weather products: **StormTrack 5** (Sinclair Broadcast Group's US TV-station weather app), **StormTrack** by Tempest/WeatherFlow
  (a professional storm-monitoring tool), an iOS app named StormTrack, and the stormtrack.org severe-weather community (since 1977).
  Not a legal opinion; before launching publicly or publishing mobile apps, run a proper trademark search (USPTO and the Indian Trademarks Registry)
  and consider a more distinctive consumer name (keeping `stormtrack` for the open-source library). Domains: stormtrack.io/.org/.net/.ai/.live
  are registered; .com/.app/.dev/.in/.earth had no DNS records on 2026-11-02 (not proof they are available: check a registrar).
- Domain: where it will live (the owner proposed stormtrack.labshope.com first).
- Permission route for India lightning (IITM) and for any global lightning licence.
- Whether AI features should exist at launch, and the budget for their API calls.
- Free vs paid: what stays free forever (the globe) and what could be an account feature (alerts, exports).
