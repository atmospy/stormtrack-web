<script lang="ts">
  import LegalPage from '#lib/components/LegalPage.svelte';
  import { CONTACT_EMAIL } from '#lib/config';
</script>

<LegalPage title="Privacy policy" updated="2 November 2026">
  <p>
    StormTrack is a free, early-preview weather and storm map run by AtmosPy (Hamid Ali Syed). This page says what the site
    stores, who else sees it, and how to have it removed. It is written to be read, not to hide anything. If something here is
    unclear, ask.
  </p>

  <h2>Using the map without an account</h2>
  <p>You do not need an account to use the map. We do not run advertising, analytics or tracking scripts, and we do not set cookies.</p>
  <p>Your browser keeps a few things on your own device so the site works well:</p>
  <ul>
    <li>your sound and volume choice for lightning, your choice of globe or flat map, and when you last dismissed the sign-up prompt;</li>
    <li>cached copies of the app and of weather and storm data files, so the map loads quickly (a service worker does this);</li>
    <li>if you are signed in, your sign-in session.</li>
  </ul>
  <p>
    If you press the locate button, your browser asks for permission and your position is used on your device to centre the map and
    read the weather there. It is not sent to us. It is stored only if you choose to save a place.
  </p>

  <h2>If you create an account</h2>
  <p>You can sign in with an email link, Google or GitHub. There are no passwords. We store:</p>
  <ul>
    <li>your email address, which sign-in provider you used, and the identifier that provider gives us;</li>
    <li>your name and profile picture address, if Google or GitHub supply them;</li>
    <li>only the things you choose to save: places, saved map views, storms you follow, a home location and unit preferences.</li>
  </ul>
  <p>
    Database rules allow only your own account to read or change your saved items. We do not sell your data and we do not use it for
    advertising.
  </p>

  <h2>Who else handles data</h2>
  <p>These services see some information because the site depends on them:</p>
  <ul>
    <li><b>Supabase</b> runs sign-in and stores account data.</li>
    <li><b>Resend</b> sends the sign-in emails.</li>
    <li><b>Google</b> and <b>GitHub</b> handle sign-in if you choose them. They tell us your email, name and picture, and we tell them nothing else.</li>
    <li><b>Cloudflare</b> hosts the site and delivers its data files. Like any host, it sees your IP address and which files you request.</li>
    <li><b>OpenFreeMap</b> supplies the basemap tiles. Your browser requests them directly, so it sees your IP address and roughly which area you are viewing.</li>
    <li><b>OpenStreetMap (Nominatim)</b> receives what you type in place search, and your IP address, when you search.</li>
  </ul>
  <p>Each of these has its own privacy policy, and we do not control them.</p>

  <h2>Keeping and deleting your data</h2>
  <p>
    We keep account data until you ask us to delete it. Deleting an account removes everything saved under it. Copies may remain in
    backups for a limited time.
  </p>
  <p>
    You can ask to see, correct or delete your data at any time.
    {#if CONTACT_EMAIL}Write to <a href="mailto:{CONTACT_EMAIL}">{CONTACT_EMAIL}</a>.{:else}A contact address has not been set for this deployment yet; until it is, use the issue tracker on <a href="https://github.com/atmospy/stormtrack-web/issues" rel="noopener">GitHub</a> and do not include personal details.{/if}
  </p>

  <h2>Children</h2>
  <p>StormTrack is not aimed at children under 13, and we do not knowingly collect their data.</p>

  <h2>Changes</h2>
  <p>If this policy changes in a way that matters, we will update the date above and say what changed.</p>
</LegalPage>
