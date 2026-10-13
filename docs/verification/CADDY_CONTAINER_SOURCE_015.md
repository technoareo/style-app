# Caddy container source check — no execution

The official current 2.11 Alpine Dockerfile was inspected through the web tool:
https://raw.githubusercontent.com/caddyserver/caddy-docker/master/2.11/alpine/Dockerfile

It uses Alpine 3.23, identifies Caddy v2.11.7 and declares a CMD running `caddy run --config /etc/caddy/Caddyfile --adapter caddyfile`. It declares no ENTRYPOINT in that file. The authored proxy startup guard preserves that Caddy invocation after its missing-domain check. Compatibility with an Alpine shell is consistent with the base image; no container was started and no shell availability or guard behavior was observed at runtime. The mutable `caddy:2` registry tag has not been resolved to an immutable tested image digest.

The current account usage tool reports ordinary usage allowed. That does not establish availability of the separate automatic approval reviewer that previously failed on a usage limit. The blocked proxy action has not been retried through an alternate execution path; deployment, proxy and runtime checks remain pending.
