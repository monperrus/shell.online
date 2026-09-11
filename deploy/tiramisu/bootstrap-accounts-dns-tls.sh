#!/bin/sh
# DNS records, certificates and nginx vhosts for the accounts app and Keycloak.
#
# Split into its own script because it is the part that changes things outside
# this machine: it writes two records into the gakoy.com zone at OVH and asks
# Let's Encrypt for two certificates. Everything else in this deployment is
# `docker compose up`.
#
# Run it from a machine that has the OVH credentials in its keyring (the
# workstation, not tiramisu) and can ssh to tiramisu:
#
#   sh deploy/tiramisu/bootstrap-accounts-dns-tls.sh
#
# It is safe to run twice: records that exist are left alone, and certbot is
# asked to keep a certificate that is still valid.
set -eu

ZONE=gakoy.com
TARGET=130.237.224.95
HOST=tiramisu
AGENT_OVH="$HOME/workspace/prototypes/agent-ovh"
APP_FQDN=app.shell.$ZONE
AUTH_FQDN=auth.$ZONE

echo "==> DNS: A app.shell.$ZONE and auth.$ZONE -> $TARGET"
cd "$AGENT_OVH"
uv run python3 - "$ZONE" "$TARGET" <<'PY'
import sys, keyring, ovh
zone, target = sys.argv[1], sys.argv[2]
client = ovh.Client(
    "ovh-eu",
    client_id=keyring.get_password("OVH", "OVH_CLIENT_ID"),
    client_secret=keyring.get_password("OVH", "OVH_CLIENT_SECRET"),
)
changed = False
for sub in ("app.shell", "auth"):
    if client.get(f"/domain/zone/{zone}/record", fieldType="A", subDomain=sub):
        print(f"    {sub}.{zone}: already there")
        continue
    record = client.post(
        f"/domain/zone/{zone}/record",
        fieldType="A", subDomain=sub, target=target, ttl=300,
    )
    print(f"    {sub}.{zone}: created, id {record['id']}")
    changed = True
# OVH stages record writes; nothing reaches the nameservers without this.
if changed:
    client.post(f"/domain/zone/{zone}/refresh")
    print("    zone refreshed")
PY

echo "==> Waiting for both names to resolve"
for fqdn in "$APP_FQDN" "$AUTH_FQDN"; do
    n=0
    while [ "$(dig +short "$fqdn" | tail -1)" != "$TARGET" ]; do
        n=$((n + 1))
        if [ "$n" -ge 60 ]; then
            echo "    $fqdn did not resolve to $TARGET; stopping" >&2
            exit 1
        fi
        sleep 5
    done
    echo "    $fqdn ok"
done

echo "==> Certificates"
# A challenge-only vhost first: the real one names certificate files that do
# not exist yet, and nginx refuses to load a configuration that points at a
# missing file.
ssh "$HOST" "sudo -n tee /etc/nginx/sites-available/acme-bootstrap.conf >/dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name $APP_FQDN $AUTH_FQDN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 404; }
}
EOF
sudo -n ln -sf /etc/nginx/sites-available/acme-bootstrap.conf /etc/nginx/sites-enabled/acme-bootstrap.conf
sudo -n nginx -t && sudo -n systemctl reload nginx
for d in $APP_FQDN $AUTH_FQDN; do
    sudo -n certbot certonly --webroot -w /var/www/certbot -d \$d \
        --non-interactive --agree-tos --register-unsafely-without-email \
        --keep-until-expiring
done
sudo -n rm -f /etc/nginx/sites-enabled/acme-bootstrap.conf /etc/nginx/sites-available/acme-bootstrap.conf"

echo "==> nginx vhosts"
ssh "$HOST" "set -e
cd /opt/shell-online/repo
sudo -n cp deploy/tiramisu/nginx-app.shell.gakoy.com.conf /etc/nginx/sites-available/$APP_FQDN.conf
sudo -n cp deploy/tiramisu/nginx-auth.gakoy.com.conf      /etc/nginx/sites-available/$AUTH_FQDN.conf
sudo -n ln -sf /etc/nginx/sites-available/$APP_FQDN.conf  /etc/nginx/sites-enabled/$APP_FQDN.conf
sudo -n ln -sf /etc/nginx/sites-available/$AUTH_FQDN.conf /etc/nginx/sites-enabled/$AUTH_FQDN.conf
sudo -n nginx -t && sudo -n systemctl reload nginx"

echo "==> Check"
# Verifying the certificate and not only the status code. A vhost whose
# configuration is on disk but which nginx has not loaded still answers on 443
# --- from the default server, with another host's certificate --- so a plain
# request succeeds while the name is in fact not served. Asking whether the
# certificate matches the name is what tells the two apart, and a reload is
# what fixes it.
for fqdn in "$AUTH_FQDN" "$APP_FQDN"; do
    if ! curl -sS -o /dev/null "https://$fqdn/" 2>/dev/null; then
        echo "    $fqdn: wrong certificate, reloading nginx"
        ssh "$HOST" "sudo -n nginx -t && sudo -n systemctl reload nginx"
        break
    fi
done

status=0
curl -sS -o /dev/null -w "    https://$AUTH_FQDN/realms/shell/.well-known/openid-configuration -> %{http_code}\n" \
    "https://$AUTH_FQDN/realms/shell/.well-known/openid-configuration" || status=1
curl -sS -o /dev/null -w "    https://$APP_FQDN/ -> %{http_code}\n" "https://$APP_FQDN/" || status=1
[ "$status" -eq 0 ] || { echo "    one of them is not answering over TLS" >&2; exit 1; }
echo "done."
