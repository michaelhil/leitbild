# Shared Caddy host

`Caddyfile` is the stable host entry point, installed at `/etc/caddy/Caddyfile`.
It imports `/etc/caddy/sites-enabled/*.caddy`. Leitbild owns only
`sites/leitbild.caddy`, installed at `/etc/caddy/sites-enabled/leitbild.caddy`.
Other products own their own site files.

Provision this layout explicitly before the first deployment, preserving the
existing host configuration and all active sites. Validate the complete root with
`caddy validate --config /etc/caddy/Caddyfile` before reloading Caddy. A routine
deploy, including `--install`, refuses a host without this layout rather than
replacing its root configuration.

Every product deployment must take `/run/lock/caddy-config.lock` while updating,
validating, reloading and checking its site. Leitbild validates the full shared
configuration and restores only its own snippet on validation, reload or public
health failure. The shared root and other products' snippets remain untouched.

Critical backups include the root and site directory. See
[backup recovery notes](backup/README.md) before restoring shared configuration.
