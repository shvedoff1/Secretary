# Deploy (same box as `blog`, full VLESS tunnel)

Mirrors `blog`'s pipeline: CI builds a Docker image, pushes it to **GHCR**, then
SSHes into the box and `docker compose pull && up`. Secretary runs as its own
compose project in `/srv/secretary` (no Caddy — the bot has no inbound ports).
All of the bot's runtime traffic (Telegram, Anthropic, Splid, DNS) is forced
through a **VLESS VPN** via a sing-box sidecar.

Image pulls reach GHCR fine from the box (that's how the site deploys); only the
bot's *runtime* traffic is blocked, which is exactly what the VPN handles. No
bootstrap problem.

## Architecture

- `vpn` = **sing-box**, VLESS client with a TUN interface (one process: TCP/UDP/DNS).
- `bot` = `ghcr.io/shvedoff1/secretary`, started with `network_mode: "service:vpn"`
  — no own network, rides the vpn container's stack. Everything tunnels; nothing
  leaks. The bot exposes no ports, so it needs no reverse proxy.

## One-time setup on the box

```bash
sudo mkdir -p /srv/secretary/singbox && cd /srv/secretary

# 1. Compose file + VPN config template (copy from the repo's deploy/ dir)
#    docker-compose.yml  and  singbox/config.example.json

# 2. Bot secrets
cat > .env <<'EOF'
BOT_TOKEN=...
ANTHROPIC_API_KEY=...
ADMIN_TELEGRAM_ID=...
# optional: ANTHROPIC_MODEL, DEFAULT_CURRENCY, ENABLE_WEB_SEARCH, ...
EOF

# 3. VPN config (your real vless config — NOT in git)
cp singbox/config.example.json singbox/config.json
#   (already filled for the handyhost VLESS link; see note below)

# 4. GHCR access: the box must be able to pull the Secretary image.
#    Either make the GHCR package public, or (same as the site) ensure the box
#    is logged in:  echo $GHCR_PAT | docker login ghcr.io -u shvedoff1 --password-stdin

# 5. First start
docker compose up -d
docker compose ps
```

### Verify the tunnel (do this first)

```bash
docker compose exec -T bot node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```

Must print **5.101.0.199** (the VLESS exit), not the server's IP. If it prints the
server IP or errors, traffic isn't tunneling — fix before relying on it. Then
`docker compose logs -f bot` should show `bot started (long polling)`.

## CI/CD

`.github/workflows/deploy.yml` runs on push to `main` (and manual dispatch):

1. **ci** — `npm ci`, `npm run typecheck`, `npm test`, `npm run build`.
2. **image** — build + push `ghcr.io/shvedoff1/secretary:latest` and
   `:sha-<short>` (image path is lowercased — the repo name has a capital S).
3. **deploy** — SSH to the box, `cd /srv/secretary`, set `BOT_IMAGE` to the new
   tag, `docker compose pull && up -d`, and print the egress IP.

### Required GitHub secrets (on the Secretary repo)

Same values as `blog` (same box): `SSH_HOST`, `SSH_USER`, `SSH_KEY`.
`GITHUB_TOKEN` is automatic and is used to push to GHCR.

> The bot currently lives on `claude/telegram-expense-chatbot-mciloy`. The deploy
> job only fires on `main`, so merge there when you're ready to ship (or trigger
> it manually via *workflow_dispatch* after adjusting the branch filter).

## VPN config note

`singbox/config.json` is already generated from your link
(`vless://…@5.101.0.199:443` REALITY / xtls-rprx-vision, SNI `www.ya.ru`). It is
**gitignored** — copy it to the box manually; it never enters git.

`SINGBOX_VERSION` defaults to `v1.11.15`. If that tag doesn't exist / fails to
pull, set it in `.env` to a current `ghcr.io/sagernet/sing-box` tag. The config
uses the 1.11 schema (`inet4_address`); on 1.12+ it still works but logs a
deprecation warning.

## Updating

Push to `main` → CI redeploys automatically. Manual:

```bash
cd /srv/secretary && docker compose pull && docker compose up -d
```

SQLite data persists in `/srv/secretary/data` across redeploys.
