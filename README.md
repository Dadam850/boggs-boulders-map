# Boggs & Boulders trail map

Mobile map for a group riding at Boggs and Boulders off-road park in Andalusia, Alabama. It is an installable app. The satellite map, trail overlay, your GPS dot, and any photo that has not uploaded yet keep working with no cell signal.

Open it once on wifi before you leave the pavement so the phone can save the park tiles.

## Run locally

```bash
npm install
npm run blob
```

In a second terminal:

```bash
cp .env.example .env.local
```

Put the Azurite connection string from `.env.example` into `.env.local` (that key is the public emulator key, not a real Azure secret), then:

```bash
npm run build
npm start
```

The app listens on [http://127.0.0.1:41773](http://127.0.0.1:41773).

`npm run dev` is the same UI without the service worker. Offline tiles and install behavior are what `npm start` serves after a build.

If `AZURE_STORAGE_CONNECTION_STRING` and `AZURE_STORAGE_CONTAINER` are unset, photos and rider pins are written under `data/local-blob`. That is only for a single long-lived Node process. A Railway container will not keep those files across a restart.

## What the phones do

- Login is a name plus an optional group code. There is no password. The phone keeps that session for 72 hours after the app was last opened.
- The default group code is `boggs`. Only phones that typed the same code see each other.
- GPS runs the whole time the map is open. Each fix is stored on the phone. About every 10 seconds, if there is signal, the phone posts its latest point and downloads everyone else.
- Other riders show as a name and “last seen …”. Pins fade as they get older. The server drops a rider pin 48 hours after its last update.
- Each phone keeps a breadcrumb of where that rider has driven. A new point is saved about every 12 meters and stored in Azure Blob until that rider erases it. The live dot still drops off after 48 hours. The path does not.
- **Paths on / Paths off** only hides the lines on this phone. **Recording / Paused** stops new points. **Clear**, then **Erase path?**, deletes your path from blob storage. Friends keep their own paths.
- Center on yourself with **Me**. Fit the whole group with **Everyone**.
- The camera button opens the phone camera (`capture=environment`). The picture is compressed to a JPEG, pinned at the current GPS fix, and written to IndexedDB before any upload is attempted. A reload cannot lose it. When the upload returns OK, the pending copy is cleared and the blob in Azure is the copy the group loads.
- Photos are not expired. Breadcrumb paths are not expired. Rider location dots are. A path stays on the map after that rider's dot ages off, until they erase it.

## Trail overlay

The map is Esri World Imagery (`World_Imagery` tile service). If that host cannot be reached, the tile route falls back to Google satellite so the phone still has imagery. The service worker caches whatever tiles the phone actually received.

The red/black overlay is north-up and locked to the real park: **Boggs & Boulders LLC, 20133 Brooklyn Rd, Andalusia, AL 36421**. Google Places puts the pin on the campground building at 31.2429996, -86.750104 (plus code `863M66VX+5X`, place `ChIJ55wAeMjrkYgROmtzkt_88j4`). The road map labels that same point "Boggs & Boulders" on Brooklyn Road (County Road 42). Phone (251) 578-4333, site http://www.boggsandboulders.com/.

An earlier box near 31.416, -86.572 is about 15 miles northeast. That is a different network of woods roads, not this park. The riding ground is the sand at the Brooklyn Road entrance: camp pads, the berm bowl, two ponds, and the dirt tracks that run north from the gate.

| Corner | Latitude | Longitude |
| --- | --- | --- |
| Northwest | 31.251774 | -86.751399 |
| Southeast | 31.241622 | -86.744460 |

Little trails are a thin red line, the same ink as the park map. The main sandy road is a thin black line (two pieces, with trees between them). There is no white halo. The strokes are screen pixels, so they stay readable when you zoom out, and the slider fades them. The lines were digitized on the satellite so they sit on the sand, including the berm-bowl rim. `scripts/build-overlay.py` rebuilds `public/trails.json`, `public/trail-map.png`, and `lib/park-bounds.json` from those control points:

```bash
npm run overlay
```

## Azure Blob Storage

Photos and breadcrumb paths are permanent. Rider JSON is only the live location (prefix `riders/`) and expires. All three use the same container via `@azure/storage-blob`.

Create the account:

1. Azure portal → **Storage accounts** → **Create**.
2. Performance **Standard**, redundancy **LRS** (the cheap option). Pick a region near Alabama, such as East US.
3. Open the account → **Containers** → **+ Container**.
4. Name it `trail-map`. Public access level **Private**.
5. **Security + networking** → **Access keys** → show the key → copy the **Connection string**.

The app calls `createIfNotExists()` on startup, so a key that is allowed to create containers can skip step 3. Private access is what you want: browsers never get a public blob URL. The Next.js server streams each JPEG from `/api/photos/[id]`.

### Environment variables

Set these on the server only. Do not use the `NEXT_PUBLIC_` prefix.

| Variable | Example | Purpose |
| --- | --- | --- |
| `AZURE_STORAGE_CONNECTION_STRING` | `DefaultEndpointsProtocol=https;AccountName=...;AccountKey=...;EndpointSuffix=core.windows.net` | Account key the server uses to read and write blobs |
| `AZURE_STORAGE_CONTAINER` | `trail-map` | Private container. Photos: `photos/{group}/{id}.jpg`. Riders: `riders/{group}/{userId}.json`. Paths: `trails/{group}/{userId}.json` |

`/api/health` reports `"store": "azure"` when those variables are set, and `"store": "local"` when they are not.

Blob layout:

- `photos/{group}/{id}.jpg` — compressed JPEG, never deleted by the app
- `photos/{group}/{id}.json` — who, when, lat, lng
- `riders/{group}/{userId}.json` — latest point only, removed 48 hours after `updatedAt`
- `trails/{group}/{userId}.json` — the breadcrumb path, kept until that rider taps Clear. A cleared path stores `clearedAt` so an older upload cannot put those points back

## Deploy to map.brocksautos.com

brocksautos.com already runs on Railway (GitHub user Dadam850). This app is a long-running Next.js server, so it is a **new Railway service**, not a static site. `railway.json` tells Nixpacks to run `npm run build`, then `npm start`. The start script binds `0.0.0.0` and uses Railway's `PORT` (local default `41773`). `/api/health` is the health check. Azure Blob is the durable store; the container disk is not.

### What this environment could not do

There is no Railway CLI and no `RAILWAY_TOKEN` here, and this project is not the GitHub repo Railway already watches. A public URL was not created. Either of these unblocks a deploy:

- Put a Railway account or project token in the environment as `RAILWAY_TOKEN`, then from this repo run `railway link` (or `railway init`) and `railway up` as a new service. Or
- Push this code to a GitHub repository under **Dadam850**, then in the Railway dashboard for the brocksautos account: **New Project** → **Deploy from GitHub repo** → pick that repo. Railway reads `railway.json` (Nixpacks, `npm run build`, `npm start`).

After the service exists, set the two Azure variables on it (service → **Variables**):

- `AZURE_STORAGE_CONNECTION_STRING` — the storage account connection string
- `AZURE_STORAGE_CONTAINER` — `trail-map`

Redeploy if the first boot happened before those variables existed. Open `/api/health` and confirm `"store": "azure"`.

### Public URL, then the custom domain

1. Service → **Settings** → **Networking** → **Generate Domain**. That creates the `https://<name>.up.railway.app` address friends can open immediately. One Railway domain per service.
2. On the same Networking panel, **+ Custom Domain** and enter `map.brocksautos.com`.
3. Railway returns two DNS records. Copy both. The CNAME target is unique to this service — do not reuse another host's target, and do not guess it.
4. At the DNS host for `brocksautos.com` (the same place the apex already points at Railway), add:

   | Type | Name | Value |
   | --- | --- | --- |
   | CNAME | `map` | the target Railway printed (a `*.up.railway.app` hostname) |
   | TXT | `_railway-verify.map` | the verification value Railway printed |

   If the DNS form appends `.brocksautos.com` for you, the TXT name is `_railway-verify.map`, not `_railway-verify.map.brocksautos.com.brocksautos.com`.
5. Until the TXT record verifies, `https://map.brocksautos.com` can return **404** even when the CNAME is correct. DNS can take up to 72 hours. In the dashboard, or with `railway domain status map.brocksautos.com`, wait until the domain is verified and the certificate is issued.
6. If `brocksautos.com` DNS is on Cloudflare, set the CNAME to **DNS only** (grey cloud). An orange-cloud proxy stops Railway from issuing the certificate.
7. On each phone, open `https://map.brocksautos.com` on wifi, let the status line say the map is saved, then Add to Home Screen. GPS and the install prompt need the `https://` URL.

Tiles are cached on each phone by the service worker, not in Azure. The first online visit at the park (or at home, before you drive out) is what fills that cache. Zooms 14–17 cover the trail box with a little padding.

## Offline check

1. Load the site and wait until it says the map is saved.
2. In browser devtools, switch the network to **Offline**.
3. Reload. The satellite tiles, trail lines, and your GPS dot should still be there. A photo taken offline stays on the map and uploads after the network is back.
