# Deploy Free Cloud (iPhone Ready)

This app can run fully in the cloud for free using:
- Render (free web service)
- Neon (free Postgres database)

## 1) Create Free Neon DB
1. Open https://neon.tech and create a free account.
2. Create a new project.
3. Copy the connection string (`postgresql://...`).

## 2) Deploy to Render from GitHub
1. Open https://render.com and sign in with GitHub.
2. Click New + -> Blueprint.
3. Select this repository (`BYDM-UTIL/Fitness`).
4. Render will detect `render.yaml` automatically.
5. In Environment Variables, set `DATABASE_URL` to your Neon URL.
6. Deploy.

## 3) Open on iPhone
1. Open the Render URL in Safari (`https://...onrender.com`).
2. Tap Share -> Add to Home Screen.
3. Open from the home screen icon.

## Notes
- Data is stored in Neon (cloud), not only on device.
- Render free plan may sleep when idle, so first open can take a few seconds.
- Local fallback still exists (`localStorage`) in case of temporary network issues.
