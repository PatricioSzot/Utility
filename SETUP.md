# 2026 Family photo shoot sign-up: Vercel setup

Files
  index.html      the page
  api/slots.js    the sign-up backend (Vercel serverless function)

1. Put index.html and the api/ folder at the root of your GitHub repo (or in a folder, and set that
   folder as the Vercel project's Root Directory). Commit and push. Vercel deploys on push.
2. In Vercel: your project > Storage > add an Upstash Redis (Marketplace) database and connect it to
   the project. This adds the env vars automatically (KV_REST_API_URL / KV_REST_API_TOKEN, or UPSTASH_REDIS_REST_*).
3. In Vercel: project > Settings > Environment Variables > add ADMIN_KEY with a long random value
   (this is your private key). Apply to Production.
4. Redeploy (Deployments > ... > Redeploy) so the new variables are picked up.
5. Share your Vercel URL with friends. No Claude account needed.
   Your admin view (backup log, CSV downloads, release any slot):
   https://YOUR-SITE.vercel.app/?admin=YOUR_ADMIN_KEY   (keep this link private)

Until step 2-4 are done, the page shows "Sign-up isn't switched on yet".
If the project has Vercel Deployment Protection on, turn it off for Production so friends can open it.
