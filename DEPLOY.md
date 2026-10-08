# Deploying Ludo Party

One Node process serves everything: the static client, the `/shared` engine modules,
`/r/CODE` share links and the WebSocket endpoint `/ws`. Put nginx in front for TLS and
compression, and optionally Cloudflare in front of nginx.

```
browser ──https/wss──> Cloudflare (optional) ──> nginx :443 ──> node server/index.js :8080
```

## Requirements

- Node.js 22 LTS (20+ works for the server; the test script's glob needs 21+).
- Two runtime dependencies: `ws` and `mongodb` (the official driver).
- MongoDB 6 or 7 for accounts, sessions and friends. Without `MONGODB_URI` the server
  keeps them in memory, so everyone is signed out on restart. Guest play needs no database.
- About 60-80 MB of RAM for 50 busy rooms (see the load test below).

## Install

```bash
sudo useradd --system --home /srv/ludo-party --shell /usr/sbin/nologin ludo
sudo mkdir -p /srv/ludo-party && sudo chown ludo:ludo /srv/ludo-party
# copy the project (git clone, rsync, ...) into /srv/ludo-party, then:
cd /srv/ludo-party
sudo -u ludo npm ci --omit=dev
```

## Run with systemd

```bash
sudo cp deploy/ludo-party.service /etc/systemd/system/
sudo nano /etc/systemd/system/ludo-party.service   # set ALLOWED_ORIGINS to your domain
sudo systemctl daemon-reload
sudo systemctl enable --now ludo-party
journalctl -u ludo-party -f
curl -s http://127.0.0.1:8080/healthz
```

### Environment variables

| Variable          | Default        | Purpose                                                          |
|-------------------|----------------|------------------------------------------------------------------|
| `PORT`            | `8080`         | HTTP + WebSocket port                                            |
| `HOST`            | dual-stack     | Bind address; use `127.0.0.1` behind nginx                      |
| `ALLOWED_ORIGINS` | (any)          | Comma-separated origins allowed to open `/ws`, e.g. `https://ludo.example.com` |
| `ANIM_SCALE`      | `1`            | Scales server waits for client animations (testing only)         |
| `TIMER_SCALE`     | `1`            | Scales turn timers (testing only)                                |
| `MIN_HUMANS`      | `2`            | Humans needed to start an online room                            |
| `BUCKET_RATE`     | `10`           | Per-socket messages per second (load testing only)               |
| `PUBLIC_URL`      | `http://<Host header>` | Public site address, e.g. `https://ludo.example.com`. Used for OAuth redirect URIs; `https` here also marks cookies `Secure`. Required in production |
| `MONGODB_URI`     | (none)         | e.g. `mongodb://127.0.0.1:27017`. Unset means in-memory accounts  |
| `MONGODB_DB`      | from URI / `test` | Database name, e.g. `ludo`                                    |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (none) | Enables "Sign in with Google"                       |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`   | (none) | Enables "Sign in with Facebook"                     |
| `DEV_LOGIN`       | (off)          | `1` adds a name-only sign-in for local testing. Ignored when `NODE_ENV=production` |

Always set `ALLOWED_ORIGINS` in production so other sites can't open sockets to your
server from a visitor's browser.

Keep secrets out of the unit file. Put them in `/etc/ludo-party.env`, which the unit loads:

```bash
sudo install -m 600 -o root -g root /dev/null /etc/ludo-party.env
sudo nano /etc/ludo-party.env
```

```ini
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=ludo
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
FACEBOOK_APP_ID=...
FACEBOOK_APP_SECRET=...
```

A sign-in button only appears when its provider's ID and secret are both set, so you can
launch with neither, one or both.

## MongoDB

Install MongoDB Community 7 from the [official packages](https://www.mongodb.com/docs/manual/administration/install-on-linux/)
and keep it bound to `127.0.0.1` (the default). The server creates its collections and
indexes on first start: `users`, `sessions` (expire automatically after 30 days) and
`friendships`. Only a SHA-256 hash of each session token is stored.

For a managed database (MongoDB Atlas), use its `mongodb+srv://` connection string as
`MONGODB_URI` and allow your server's IP in Atlas's network access list.

Back up with `mongodump --db ludo --out /var/backups/ludo-$(date +%F)`.

## Google sign-in

1. Open [Google Cloud Console](https://console.cloud.google.com/) → create a project →
   **APIs & Services → OAuth consent screen**. Choose *External*, fill in the app name,
   support email and your domain, and add the scopes `openid` and `profile`.
   Then publish the app (move it from Testing to In production).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   - Authorized JavaScript origin: `https://ludo.example.com`
   - Authorized redirect URI: `https://ludo.example.com/auth/google/callback`
3. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The server uses the authorization-code flow with PKCE and reads only the account id,
display name and profile photo. It never asks for an email address.

## Facebook sign-in

1. Open [Meta for Developers](https://developers.facebook.com/apps/) → **Create app** →
   use case *Authenticate and request data from users with Facebook Login*.
2. **Facebook Login → Settings**: add the valid OAuth redirect URI
   `https://ludo.example.com/auth/facebook/callback`. Keep *Use Strict Mode for redirect URIs* on.
3. **App settings → Basic**: add your privacy-policy URL, a data-deletion instructions URL,
   the app domain `ludo.example.com` and an app icon. Copy the App ID and App Secret into
   `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.
4. Switch the app to **Live** mode.
5. `public_profile` works right away. **Friend suggestions** need the `user_friends`
   permission, which requires Meta's App Review. Until it is approved, Facebook sign-in
   still works and the suggestions list is simply empty. Facebook only ever returns
   friends who have also signed in to Ludo Party.

## Testing sign-in locally

`npm start` loads a `.env` file from the project folder if there is one (it is git-ignored;
copy `.env.example` to start). Without OAuth apps you can test accounts and friends with
the dev sign-in:

```ini
PUBLIC_URL=http://localhost:8080
MONGODB_URI=mongodb+srv://USER:PASSWORD@CLUSTER.mongodb.net/ludo?retryWrites=true&w=majority
DEV_LOGIN=1
```

The database name can be part of the URI (`/ludo` above) or set with `MONGODB_DB`.

Settings → **Dev sign-in (test only)** asks for a name and creates an account. Use a second browser
profile (or a private window) for a second account to try friend requests and invites.
Google and Facebook both accept `http://localhost:8080/auth/.../callback` as a redirect
URI for testing, so real sign-in also works locally once the apps exist.

## nginx

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/ludo-party
sudo ln -s /etc/nginx/sites-available/ludo-party /etc/nginx/sites-enabled/
# edit server_name and certificate paths, then get a certificate:
sudo certbot certonly --webroot -w /var/www/certbot -d ludo.example.com
sudo nginx -t && sudo systemctl reload nginx
```

What the config does:

- `/ws` is proxied with `Upgrade` / `Connection` headers and 1-hour read/send
  timeouts so long games aren't cut off. Buffering is off.
- Everything else is proxied to Node, which sets `Cache-Control` headers. App code is
  `no-cache`, so updates show up immediately. Fonts and icons are cached for 7 days.
- gzip for JS, CSS and JSON, plus security headers and a strict Content-Security-Policy.
  The app uses no inline scripts.
- `/healthz` can only be reached from localhost.
- `/auth/` (sign-in) is rate limited to 20 requests a minute per IP, with bursts of 20.
- The CSP `img-src` allows Google (`*.googleusercontent.com`) and Facebook
  (`*.fbcdn.net`, `*.fbsbx.com`) profile photos. The server only accepts photo URLs from those hosts.

## Cloudflare (optional)

1. Point the DNS record at the server with the orange cloud (proxied) on.
2. Set SSL/TLS mode to **Full (strict)**, using the Let's Encrypt certificate on nginx.
3. Under Network, make sure **WebSockets** is on (it is by default on all plans).
4. Turn **Rocket Loader off**. It rewrites `<script type="module">` and breaks the app.
   Auto Minify isn't needed; nginx already gzips.
5. Leave caching on the default "Standard" level. HTML and JS are sent with `no-cache`,
   so Cloudflare revalidates them. `/ws` is never cached.
6. Cloudflare closes WebSockets that are idle for 100 seconds. The server pings every
   client every 25 seconds, so this never happens during a game.
7. To log real visitor IPs, uncomment the `set_real_ip_from` / `real_ip_header` block in
   `nginx.conf` and fill in the current list from <https://www.cloudflare.com/ips/>.

## Updating

```bash
cd /srv/ludo-party && git pull && sudo -u ludo npm ci --omit=dev
sudo systemctl restart ludo-party
```

Rooms live in memory, so a restart ends games in progress. Clients reconnect
automatically, and anyone whose room is gone goes back to the Home screen. Restart at a
quiet time. The service worker picks up new client files on the next page load, because
app code is fetched network-first.

## Load test

`scripts/loadtest.js` drives the real server with headless WebSocket players. Each room
gets 4 players who create or join, ready up, and play full games using the medium bot logic.

```bash
node scripts/loadtest.js                           # 50 rooms, accelerated full games
node scripts/loadtest.js --realtime --duration 60  # 50 rooms at normal pacing for 60 s
node scripts/loadtest.js --rooms 100 --players 6   # other sizes
node scripts/loadtest.js --url wss://ludo.example.com/ws --realtime   # against a deployment
```

(`npm run loadtest` works too. In PowerShell, call `node` directly as shown, because
PowerShell drops the `--` that npm needs to pass arguments through.)

Results on the development machine (Windows 11, Node 22, server and all 200 clients on
the same machine):

| Run | Result |
|-----|--------|
| Accelerated: 50 rooms x 4 players, full games | 50/50 games finished in 9.8 s; ~4,900 actions/s; action-to-broadcast p50 5.3 ms, p95 8.2 ms, p99 10.9 ms; server ~1 CPU core; peak RSS 81 MB; 0 errors, 0 resyncs |
| Realtime: 50 rooms x 4 players, 60 s | 3,960 actions (64/s); p50 0.8 ms, p95 1.2 ms, p99 1.5 ms; server CPU avg 3.9%, peak 25% of one core; peak RSS 58 MB; 0 errors, 0 resyncs |

The accelerated run removes animation waits and plays instantly. It drives the server at
roughly 75 times the realtime message rate and still keeps p99 latency around 11 ms. At
realistic pacing, 50 concurrent rooms use about 4% of one core, so a single small VPS
should handle many hundreds of rooms. If you outgrow one process, run several and route
each room code to a fixed process (rooms are independent; no shared state is needed).

## Health and monitoring

`GET /healthz` (localhost only through nginx) returns:

```json
{ "ok": true, "rooms": 12, "conns": 40, "games": { "messages": 51234, "dropped": 0,
  "roomsCreated": 30, "gamesFinished": 18 }, "rssMB": 58, "heapMB": 14, "cpuMs": 5230,
  "uptimeS": 3600 }
```

`dropped` counts messages rejected by the per-socket rate limit. If it keeps rising,
some client is misbehaving.
