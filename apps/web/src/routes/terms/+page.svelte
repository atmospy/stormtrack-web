<script lang="ts">
  import LegalPage from '#lib/components/LegalPage.svelte';
  import { CONTACT_EMAIL } from '#lib/config';
</script>

<LegalPage title="Terms of use" updated="2 November 2026">
  <p>
    StormTrack is a free, early-preview map of weather, storms and natural hazards, run by AtmosPy (Hamid Ali Syed). By using it, or by
    creating an account, you agree to these terms and to the <a href="/privacy">privacy policy</a>.
  </p>

  <h2>Do not rely on it for safety</h2>
  <p>
    <b>StormTrack is not a warning service.</b> It shows model output, agency analyses and third-party feeds, which can be late,
    incomplete or wrong. Forecast cones and tracks are uncertain, and some shapes on the map are our own estimates and are labelled as
    such. For decisions that affect life or property, follow the official warnings of your national weather service and local
    authorities, such as the India Meteorological Department, the National Hurricane Center or the Joint Typhoon Warning Center.
  </p>

  <h2>Data and sources</h2>
  <p>
    The map combines data from NOAA, NASA, USGS, the India Meteorological Department, IBTrACS, OpenStreetMap contributors (through
    OpenFreeMap) and others. Each source keeps its own copyright and terms, and the site lists them in its Data and sources panel.
    Weather values are model output on a coarse grid, not measurements at a point.
  </p>

  <h2>Your account</h2>
  <p>
    Keep your sign-in secure. You are responsible for what happens under your account. You can stop using the service, and ask us to
    delete your data, at any time.
  </p>

  <h2>Acceptable use</h2>
  <ul>
    <li>Do not try to break, overload or gain unauthorised access to the service or its data.</li>
    <li>Do not scrape it at a rate that harms other users, or use it to build something that endangers people.</li>
    <li>Do not use it unlawfully.</li>
  </ul>
  <p>We may limit or suspend access if the service or other people are put at risk.</p>

  <h2>No warranty, limited liability</h2>
  <p>
    The service is provided as it is and as available, without promises about accuracy, availability or fitness for any purpose. To
    the extent the law allows, we are not liable for losses that come from using it or from being unable to use it. Nothing here limits
    rights you have that cannot be limited by law.
  </p>

  <h2>Changes and contact</h2>
  <p>
    The service and these terms may change. If a change matters, we will update the date above. Questions:
    {#if CONTACT_EMAIL}<a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.{:else}use the issue tracker on <a href="https://github.com/atmospy/stormtrack-web/issues" rel="noopener">GitHub</a>.{/if}
  </p>
</LegalPage>
