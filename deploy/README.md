# Deploy (foreign VPS, no VPN)

Fully automated. On push to `main` (or manual dispatch) GitHub Actions:
builds & tests → builds the Docker image and pushes it to **GHCR** → SSHes into
the VPS and sets everything up itself (writes the compose file and `.env`, logs
into GHCR, pulls, and starts).

**No manual work on the server.** You set GitHub secrets once (in the repo UI).
The VPS just needs SSH access — the deploy installs Docker automatically if it's
missing. Pick a host **outside Russia** so the bot can reach Telegram and
Anthropic directly (Anthropic geo-blocks RU IPs with a 403).

## Architecture

- `bot` = `ghcr.io/shvedoff/secretary`, a single container. It reaches Telegram
  and Anthropic directly over the VPS's own network — no VPN sidecar. The bot
  exposes no ports (long-polling), so no reverse proxy is needed.

The deploy lives in its own compose project at `~/secretary` (the deploy user's
home) on the box.

## Set these once in GitHub (Settings → Secrets and variables → Actions)

**Secrets:**

| Secret | Value |
|---|---|
| `SSH_HOST`, `SSH_USER`, `SSH_KEY` | The foreign VPS (host/IP, user, private key) |
| `SSH_PORT` | SSH port (optional — defaults to `22`) |
| `BOT_TOKEN` | Telegram bot token (@BotFather) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ADMIN_TELEGRAM_ID` | Your numeric Telegram id |

**Variables (optional):** `ANTHROPIC_MODEL` (default `claude-opus-4-8`),
`DEFAULT_CURRENCY` (default `EUR`).

`GITHUB_TOKEN` is automatic — used to push to and pull from GHCR (the box logs
in with it during deploy, so the package can stay private).

## Ship it

After setting the secrets above, deploy with one click — no server access:
**Actions → build & deploy → Run workflow** (pick the current branch). This
builds, pushes the image, and provisions the box end-to-end.

Auto-deploy runs on pushes to `main`; feature-branch pushes never deploy by
themselves (use the manual dispatch). When you're ready for push-to-deploy,
merge this branch into `main`.

## Verify

The deploy job probes Anthropic from inside the bot container at the end — it
should print `anthropic reachable, status 200` (or `401`/`400`), **not** `403`.
A 403 means the VPS IP is geo-blocked (i.e. it's in Russia) — move to a host
elsewhere. To check anytime, run `Actions → diagnose → Run workflow`, or:

```bash
docker compose -f ~/secretary/docker-compose.yml exec -T bot \
  node -e "fetch('https://api.anthropic.com/v1/models',{headers:{'x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'}}).then(r=>console.log(r.status))"
```

Then in Telegram: `/start` → `/request` → approve from the admin account →
`/group <splid-invite-code>` → `/members` → `/link`.

## Notes

- Data (SQLite) persists in `~/secretary/data` across redeploys.
- `deploy/docker-compose.yml` is the single source of truth — the workflow
  base64-encodes it to the box each deploy.
