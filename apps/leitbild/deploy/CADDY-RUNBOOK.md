# Caddy Operator Runbook

If public `/health` returns 404 while `curl -fsS http://127.0.0.1:4177/health` succeeds on the server:

1. Compare `/etc/caddy/Caddyfile` against `deploy/Caddyfile.leitbild` in the repo.
2. Manually edit `/etc/caddy/Caddyfile` if it has drifted.
3. Run `caddy validate --config /etc/caddy/Caddyfile`.
4. Run `systemctl reload caddy`.
5. Re-verify with `curl -fsS https://leitbild.samsinn.app/health`.
