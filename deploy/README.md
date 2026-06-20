# Deploy (same box as `blog`, full VLESS tunnel)

Fully automated, mirroring `blog`'s pipeline. On push to `main` (or manual
dispatch) GitHub Actions: builds & tests → builds the Docker image and pushes it
to **GHCR** → SSHes into the box and sets everything up itself (writes the
compose file, `.env`, and the VPN config, logs into GHCR, pulls, and starts).

**No manual work on the server.** You only set GitHub secrets once (in the repo
UI). The box just needs Docker + Compose (already there — it runs the site) and
`/dev/net/tun` with `NET_ADMIN` (default on most VPS).

## Architecture

- `vpn` = **sing-box**, VLESS client with a TUN interface (one process: TCP/UDP/DNS).
- `bot` = `ghcr.io/shvedoff1/secretary`, started with `network_mode: "service:vpn"`
  — no own network, rides the vpn container's stack. Everything tunnels; nothing
  leaks. The bot exposes no ports, so no reverse proxy is needed.

The deploy lives in its own compose project at `/srv/secretary` on the box
(separate from the site). Image pulls reach GHCR fine (that's how the site
deploys); only the bot's *runtime* traffic is blocked, which the VPN handles.

## Set these once in GitHub (Settings → Secrets and variables → Actions)

**Secrets:**

| Secret | Value |
|---|---|
| `SSH_HOST`, `SSH_USER`, `SSH_KEY` | Same as `blog` (same box) |
| `BOT_TOKEN` | Telegram bot token (@BotFather) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ADMIN_TELEGRAM_ID` | Your numeric Telegram id |
| `SINGBOX_CONFIG_B64` | base64 of the sing-box config (provided to you; = `base64 -w0 deploy/singbox/config.json`) |

**Variables (optional):** `SINGBOX_VERSION` (default `v1.11.15`),
`ANTHROPIC_MODEL` (default `claude-opus-4-8`), `DEFAULT_CURRENCY` (default `EUR`).

`GITHUB_TOKEN` is automatic — used to push to and pull from GHCR (the box logs
in with it during deploy, so the package can stay private).

## Ship it

The deploy job runs only on `main`. Merge the feature branch (a PR is opened for
this) → it deploys automatically. Or run **Actions → build & deploy → Run
workflow** manually.

## Verify the tunnel

The deploy job prints the bot's egress IP at the end. It must be **5.101.0.199**
(the VLESS exit), not the server's IP. To check anytime:

```bash
docker compose -f /srv/secretary/docker-compose.yml exec -T bot \
  node -e "fetch('https://api.ipify.org').then(r=>r.text()).then(console.log)"
```

Then in Telegram: `/start` → `/request` → approve from the admin account →
`/group <splid-invite-code>` → `/members` → `/link`.

## Notes

- The real VPN config (`deploy/singbox/config.json`) is **gitignored**; it never
  enters git. It reaches the box only via the `SINGBOX_CONFIG_B64` secret.
- `SINGBOX_VERSION` defaults to `v1.11.15`. If that tag fails to pull, set the
  `SINGBOX_VERSION` repo variable to a current `ghcr.io/sagernet/sing-box` tag.
  The config uses the 1.11 schema (`inet4_address`); on 1.12+ it still works but
  logs a deprecation warning.
- Data (SQLite) persists in `/srv/secretary/data` across redeploys.
- `deploy/docker-compose.yml` is the single source of truth — the workflow scp's
  it to the box each deploy.
