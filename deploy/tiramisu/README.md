# The relay on tiramisu — https://shell.gakoy.com

A self-hosted shell.online relay. The CLI is pointed at it with `--server`, and
nothing in the terminal path touches shell.online:

```sh
shell --server https://shell.gakoy.com claude
# or, to stop repeating it:
export SHELL_ONLINE_SERVER=https://shell.gakoy.com
```

The relay is the same Cloudflare Worker `wrangler.example.jsonc` describes,
running on tiramisu under `workerd` instead of on Cloudflare. It serves the
site, the session pages, and the encrypted websocket.

The accounts app (`app/`) is the second service, at
**https://app.shell.gakoy.com** — accounts, linked machines, the session list,
and the new-session form that can start an agent on any linked machine. That
form is the only place the fork's agentknit support is reachable from a
browser. The CLI does not need it; without it, sessions are simply anonymous.
See [The accounts app](#the-accounts-app) below.

## What is where

| Thing | Path |
|---|---|
| Checkout | `/opt/shell-online/repo` (github.com/monperrus/shell.online, `main`) |
| Durable Object state | `/opt/shell-online/state` |
| The service's own `$HOME` | `/opt/shell-online/home` |
| Worker configuration | `repo/wrangler.tiramisu.jsonc` |
| systemd unit | `/etc/systemd/system/shell-online-relay.service` |
| nginx vhost | `/etc/nginx/sites-available/shell.gakoy.com.conf` |
| Certificate | `/etc/letsencrypt/live/shell.gakoy.com/` |
| Accounts app | `/opt/shell-online/repo/app`, `docker compose` |
| Accounts app config | `repo/app/.env` (not committed) |
| Accounts app vhost | `/etc/nginx/sites-available/app.shell.gakoy.com.conf` |
| Keycloak | same compose stack, realm `shell` |
| Keycloak vhost | `/etc/nginx/sites-available/auth.gakoy.com.conf` |

The unit, the vhost and the worker configuration are committed here. The copies
on the machine are copies; edit them here and reinstall, so the machine can be
rebuilt from the repository.

## How it fits together

```
browser ──443── nginx (TLS, shell.gakoy.com) ──► 127.0.0.1:8788 ──► workerd
   │                                                                   │
   └──────────────── encrypted terminal frames ────────────────────────┘
CLI ────────────────────────────────────────────────────────────────────┘

and, for accounts:

browser ──443── nginx ─┬─ app.shell.gakoy.com ──► :8083  app ──┐
                       │                                       ├─► postgres
                       └─ auth.gakoy.com ───────► :8084  keycloak ┘
```

The worker listens on loopback only. Everything public goes through nginx,
which is also what terminates TLS — and TLS is not optional here: the session
page derives its key with `crypto.subtle`, which browsers refuse to expose on
a remote `http://` origin. A plain-HTTP relay would serve a page that cannot
decrypt anything.

## Build from scratch

Assumes a machine with node 22, nginx on 80/443, and certbot already renewing
by webroot.

### 1. DNS

An A record in the `gakoy.com` zone, at OVH:

| Field | Value |
|---|---|
| Subdomain | `shell` |
| Type | `A` |
| Target | `130.237.224.95` (tiramisu) |
| TTL | 300 |
| Record id | `5434315394` |

Created through the OVH API with the service account described in
`rootmab/README.md` (§ OVH API), via the `agent-ovh` venv:

```sh
cd ~/workspace/prototypes/agent-ovh
uv run python3 -c "
import keyring, ovh
c = ovh.Client('ovh-eu',
    client_id=keyring.get_password('OVH','OVH_CLIENT_ID'),
    client_secret=keyring.get_password('OVH','OVH_CLIENT_SECRET'))
c.post('/domain/zone/gakoy.com/record',
       fieldType='A', subDomain='shell', target='130.237.224.95', ttl=300)
c.post('/domain/zone/gakoy.com/refresh')
"
```

The `refresh` is not optional: OVH stages record writes and only pushes them to
the authoritative nameservers when the zone is refreshed.

### 2. Checkout and build

```sh
sudo mkdir -p /opt/shell-online && sudo chown "$USER" /opt/shell-online
git clone https://github.com/monperrus/shell.online.git /opt/shell-online/repo
mkdir -p /opt/shell-online/state /opt/shell-online/home
cd /opt/shell-online/repo
npm ci
npm run build:web          # produces dist/, which the ASSETS binding serves
```

`npm run build:web` is enough. The full `npm run build` also cross-compiles the
CLI for every platform so that `/install` and `/downloads` can serve binaries;
this deployment does not serve its own downloads.

### 3. Certificate

The vhost has to answer on port 80 before a certificate exists, so issue with a
challenge-only vhost first:

```sh
sudo tee /etc/nginx/sites-available/shell.gakoy.com.conf >/dev/null <<'EOF'
server {
    listen 80;
    server_name shell.gakoy.com;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/shell.gakoy.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo certbot certonly --webroot -w /var/www/certbot -d shell.gakoy.com \
  --non-interactive --agree-tos --register-unsafely-without-email
```

Renewal needs nothing further: certbot writes its own renewal configuration and
the existing `certbot.timer` picks it up, exactly as for the mail hosts.

### 4. nginx and the service

```sh
cd /opt/shell-online/repo
sudo cp deploy/tiramisu/nginx-shell.gakoy.com.conf \
        /etc/nginx/sites-available/shell.gakoy.com.conf
sudo nginx -t && sudo systemctl reload nginx

sudo cp deploy/tiramisu/shell-online-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shell-online-relay
```

### 5. Check it

```sh
curl -sI https://shell.gakoy.com/ | head -1
shell --server https://shell.gakoy.com --auto-close 10m -- bash -c 'echo hello; exec cat'
```

Open the printed link, enter the printed password, type something: it should
come back echoed, and the header should say end-to-end encrypted.

## Updating

```sh
cd /opt/shell-online/repo
git pull
npm ci && npm run build:web
sudo systemctl restart shell-online-relay
```

Restarting drops every live session's websocket. The CLI reconnects, but a
browser tab has to be reloaded.

## Operating it

```sh
systemctl status shell-online-relay
journalctl -u shell-online-relay -f      # one line per request
sudo systemctl restart shell-online-relay
```

Session state lives in `/opt/shell-online/state` and survives restarts. Deleting
it ends every persistent session; ordinary sessions are ephemeral anyway.

## The accounts app

Three containers on the same machine: Keycloak, which holds the accounts; the
React client and its API; and the PostgreSQL both of them store into, in two
separate databases. nginx terminates TLS on two hostnames,
`auth.gakoy.com` for Keycloak and `app.shell.gakoy.com` for the app, and the
app proxies `/relay/*` on to the relay.

Nothing here depends on an account with anyone. Sign-in is Authorization Code
with PKCE against Keycloak (Apache-2.0), which is one OpenID Connect provider
among others: the app verifies ID tokens against whatever JWKS the configured
issuer publishes, so swapping Keycloak for Authelia, Zitadel or Dex is two
environment variables and no code.

The app holds no passwords and has no screens for them. Setting one, changing
one, resetting one and verifying an email address all happen on Keycloak's
pages, which is why the sign-in screen is one button.

### 1. DNS, certificates and vhosts

Two A records in the `gakoy.com` zone, both pointing at `130.237.224.95` —
`app.shell` for the accounts app and `auth` for Keycloak — then a certificate
for each, then the two vhosts. One script does all of it, from the workstation
that holds the OVH credentials:

```sh
sh deploy/tiramisu/bootstrap-accounts-dns-tls.sh
```

It is the only part of this deployment that changes anything outside the
machine, which is why it is separate and why it is safe to run twice: records
that exist are left alone, and a certificate that is still valid is kept.

### 2. Configure

```sh
cd /opt/shell-online/repo/app
cp ../deploy/tiramisu/app.env.example .env
ln -sf ../deploy/tiramisu/docker-compose.override.yml docker-compose.override.yml
```

Two secrets to fill in, and nothing else is secret:

```sh
openssl rand -base64 24    # POSTGRES_PASSWORD
openssl rand -base64 24    # KEYCLOAK_ADMIN_PASSWORD
```

`PORT=127.0.0.1:8083` in `.env` is not a typo: the whole value is interpolated
into the compose port spec, which is how the published port ends up bound to
loopback without needing to override a ports list across compose files.

### 3. Start

```sh
docker compose up --build -d
docker compose logs -f keycloak app
```

`keycloak-realm.json` carries no comments, and must not: Keycloak deserializes
it into a `RealmRepresentation` that rejects any field it does not know, so a
`_comment` key fails the whole import with "Unrecognized field". The reasoning
that would have been in it is here instead.

Keycloak imports `keycloak-realm.json` on its first start: realm `shell`, with
the public PKCE client `shell-online-app` already registered against
`https://app.shell.gakoy.com/auth/callback`. Import happens **only** when the
realm does not exist — a realm that is already there is left alone, so console
edits survive restarts and the file is a starting point rather than the
running truth.

```sh
sudo cp ../deploy/tiramisu/nginx-app.shell.gakoy.com.conf \
        /etc/nginx/sites-available/app.shell.gakoy.com.conf
sudo cp ../deploy/tiramisu/nginx-auth.gakoy.com.conf \
        /etc/nginx/sites-available/auth.gakoy.com.conf
sudo ln -sf /etc/nginx/sites-available/app.shell.gakoy.com.conf /etc/nginx/sites-enabled/
sudo ln -sf /etc/nginx/sites-available/auth.gakoy.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The app's own migrations run on boot, so there is no separate database step.

### 4. Create the people

Registration is off: a realm on the public internet that lets anyone sign
themselves up will have strangers in it. Accounts are made in the admin
console at `https://auth.gakoy.com/admin`, signing in with `KEYCLOAK_ADMIN`
and its password, under realm **shell** → Users → Add user. Give each one an
email, then Credentials → Set password, temporary, so they choose their own on
first sign-in.

To let people register themselves instead: Realm settings → Login →
User registration. Keycloak then shows a Register link on its own sign-in
page, and the app needs no change for it.

Checking it worked, before opening a browser:

```sh
curl -s https://auth.gakoy.com/realms/shell/.well-known/openid-configuration | head -c 200
```

### 5. Point the CLI at it

```sh
export SHELL_ONLINE_SERVER=https://shell.gakoy.com
export SHELL_ONLINE_ACCOUNTS=https://app.shell.gakoy.com
export SHELL_ONLINE_WEB=https://app.shell.gakoy.com
shell login
```

All three matter: each address defaults to production independently, so
setting only some of them aims the rest at the real service. `shell login`
prints which services it is using whenever they are not the production ones —
read that line, it is the check that this worked.

Say yes when it asks whether the browser may start sessions on this machine
(or pass `--allow-remote-start`). That is what puts the machine in the web
app's machine list, and it is a real capability: while it is on, anyone signed
in to the account can run processes on that machine as you.

### 6. Use agentknit from the browser

In the app: **New session → agentknit**, pick the machine, fill in the model
(the one required field) and optionally a task, endpoint, spec file, session to
resume, or output cap. The form only offers agentknit on machines whose daemon
reported finding it on `PATH`.

### Updating it

```sh
cd /opt/shell-online/repo && git pull
cd app && docker compose up --build -d
```

`--build` rather than `restart`: the provider's address and the relay URL are
compiled into the client, so a rebuild is what picks up a changed `.env`.

### When sign-in does not work

- **`invalid_redirect_uri` on Keycloak's page.** The client's redirect URI has
  to match `https://app.shell.gakoy.com/auth/callback` exactly. Admin console →
  Clients → shell-online-app → Valid redirect URIs.
- **Signed in, then every API call is refused.** The `aud` of the token is the
  client id, and the app checks it: `OIDC_AUDIENCE` must equal
  `VITE_OIDC_CLIENT_ID`. Both come from `.env`, so this means they were edited
  apart.
- **Signed in, then signed out again an hour later.** Silent renewal loads the
  callback in a hidden iframe, which the browser blocks unless Keycloak allows
  the app's origin: Clients → shell-online-app → Web origins must list
  `https://app.shell.gakoy.com`.
- **Keycloak serves only a "HTTPS required" page.** It is not seeing
  `X-Forwarded-Proto`. `KC_PROXY_HEADERS=xforwarded` and the nginx vhost here
  set that between them.
- **Keycloak will not start, complaining about the database.** Its database is
  created by an init script that the postgres image runs only on an empty data
  directory. On a volume that already holds the app's database:
  `docker compose exec postgres createdb -U postgres keycloak`.

## Things worth knowing

**It runs under `wrangler dev`.** That is the only supported way to run a
Worker off Cloudflare, and it drives the same `workerd` runtime the platform
does, with Durable Objects, the rate limiters and Analytics Engine all
simulated locally. It is still a development server: it watches files and
rebuilds, it has no supervision of its own beyond systemd's `Restart=always`,
and Cloudflare does not promise its behaviour matches production. It has been
stable here, but it is the part of this deployment that is off the beaten path.

**Analytics go nowhere.** The `ANALYTICS` binding is simulated, so the stats
pages have only what this instance has seen since it started.

**Rate limits are per process, not per edge.** The limiters in the
configuration (10 session creations/minute, 120 connections/minute) apply to
this one worker. That is the whole relay here, so they are if anything tighter
than on Cloudflare.

**node is a snap.** `/snap/bin/node` is a launcher that wants a home of its own
and refuses one outside `/home`, which the unit's sandboxing does not give it.
The unit therefore names `/snap/node/current/bin/node`, the ordinary ELF binary
inside the snap. A major-version snap refresh is a thing to check after.

**The certbot on this machine is fine.** `certbot --version` fails when run as
`martin` because `~/.local/lib/python3.10/site-packages` has a pip
`cryptography` 50 that the apt `pyOpenSSL` 21 cannot import. Root does not see
that directory, so certbot and the renewal timer work normally. It is a shell
environment artifact, not a broken installation.

**The realm is a starting point, not the running truth.** Import happens only
when the realm is absent, so anything changed in the admin console afterwards
stays changed and this file stops describing it. Two decisions worth knowing
are baked into it: registration is off, because a realm on the public internet
that lets anyone sign up will have strangers in it, and the client is public
and PKCE-S256, because a browser cannot keep a secret and a client that may
fall back to `plain` gains nothing from PKCE.

**This fork adds agentknit, and replaces Firebase.** See the repository
CHANGELOG. The relay serves this fork, so it carries both; the accounts app is
where either of them is visible.
