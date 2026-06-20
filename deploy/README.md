# Deploy (server + full VLESS tunnel)

Runs the bot on the same box as the `blog` site, with **all** of its traffic
forced through a VLESS VPN (the box is in RU and can't reach Telegram/Anthropic
directly).

> Status: **draft / awaiting two inputs** — see "What I still need" below. The
> VPN sidecar + compose are wired; the VLESS outbound and the integration with
> `blog`'s deploy method need to be filled in.

## How it works

- `vpn` service = **sing-box** with a TUN interface (VLESS client). One process
  handles TCP/UDP/DNS transparently.
- `bot` service = this repo's Docker image, started with
  `network_mode: "service:vpn"` — it has **no own network**, it uses the vpn
  container's stack. So every request (Telegram long-poll, Anthropic API, Splid,
  DNS) goes out through the tunnel. No per-library proxy config, no leaks.

## Prerequisites on the box

- Docker + Docker Compose v2.
- `/dev/net/tun` available and `NET_ADMIN` allowed for containers (default on
  most VPS; fails on some restricted hosts — tell me if so).
- A way to get the two images onto the box (see Bootstrapping).

## Bootstrapping on a blocked box (important)

GitHub/Docker Hub are often unreachable from RU, so pulling
`ghcr.io/sagernet/sing-box` and building/pulling the bot image can fail —
chicken-and-egg (need the VPN to fetch the VPN). Options, depending on how
`blog` already does it:

1. **CI builds, box pulls from a reachable registry.** If `blog` already
   pushes images to a registry the box can reach, do the same for both images
   (mirror sing-box there too). Preferred if that path exists.
2. **Build/pull on a machine with access, `docker save` → `scp` → `docker load`**
   on the box. Works without the box reaching any registry.
3. The box already has some egress (existing proxy/VPN for the site) — then a
   normal `docker compose pull/build` just works.

Which one applies depends on `blog`'s setup — that's one of the inputs I need.

## Steps

```bash
# 1. Secrets for the bot
cp ../.env.example ../.env && $EDITOR ../.env        # BOT_TOKEN, ANTHROPIC_API_KEY, ADMIN_TELEGRAM_ID

# 2. VPN config (real one is gitignored)
cp singbox/config.example.json singbox/config.json
# fill vless-out from your vless:// link (I can generate this exactly — see below)

# 3. Bring it up
docker compose up -d --build

# 4. Verify ALL egress goes through the VPN (should print the VPN exit IP, not the box IP)
docker compose exec bot sh -c 'wget -qO- https://api.ipify.org || true'
docker compose logs -f bot
```

## Verifying the tunnel

- `docker compose exec bot sh -c 'wget -qO- https://api.ipify.org'` must return
  the **VPN's** IP, not the server's. If it returns the server IP or times out,
  traffic isn't going through the tunnel — stop and fix before relying on it.
- Bot log should show `bot started (long polling)`.

## Updating

```bash
git pull
docker compose up -d --build      # or: docker compose pull && up -d, if using a registry
```

Data (SQLite) persists in `../data` (mounted volume) across rebuilds.

## What I still need from you

1. **`blog`'s deploy method** — paste (or grant repo access to) its
   `docker-compose.yml` / Dockerfile / CI workflow (`.github/workflows/*`) /
   nginx or Caddy config / any deploy script, and how images reach the box.
   I'll then make this match (same registry/CI/compose project, reverse proxy if
   relevant — though the bot needs no inbound port).
2. **Your `vless://` link** (or the Xray/sing-box JSON). It encodes everything
   (server, port, uuid, flow, TLS/REALITY/transport). I'll convert it into the
   exact `vless-out` block and verify it against the pinned sing-box version.
   It's a secret — it lives only in `singbox/config.json` (gitignored), not in
   git.
