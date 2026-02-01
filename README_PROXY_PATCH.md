# DIOS ShelbyNet CORS Proxy Patch

This update fixes browser CORS errors when calling ShelbyNet endpoints like:
  https://api.shelbynet.shelby.xyz/v1/transactions/by_hash/<hash>

## What changed
- Added a generic Next.js API proxy:
    pages/api/shelbynet/[...path].js
  You can call any ShelbyNet path through:
    /api/shelbynet/<path>

- Patched pages/_app.js to automatically rewrite any browser fetch() calls
  targeting https://api.shelbynet.shelby.xyz/* to /api/shelbynet/*.
  This also covers calls made inside third-party libraries.

- Updated pages/index.js blob downloads to use /api/shelbynet/...

## Required Vercel env var
In Vercel -> Settings -> Environment Variables add (server-side only):
  SHELBYNET_API_KEY = <your ShelbyNet API key>

Do NOT prefix with NEXT_PUBLIC_.
Redeploy after setting env var.
