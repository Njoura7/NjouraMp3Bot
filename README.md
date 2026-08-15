# Discord Music Bot

A lightweight Discord bot that plays audio from a URL (YouTube, SoundCloud, or any direct `.mp3`/`.ogg` link) , supports queueing, and exposes a clean embed + button player UI ((⏸️ ▶️ ⏹️)) inside Discord. It is built for local development first, but it is also easy to containerize and deploy to a free-tier host.

## Project structure

```text
discord/
├── index.js                 # Bot bootstrap, command loader, and lifecycle hooks
├── deploy-commands.js       # Registers slash commands with Discord
├── commands/
│   └── njrmp3.js            # /njrmp3 command and voice/player logic
├── handlers/
│   └── buttons.js           # Pause, resume, skip, and stop button actions
├── package.json             # Node version and dependencies
├── Dockerfile               # Container runtime for Node 24
├── .env.example             # Example env file (if you keep one locally)
├── README.md                # Project docs
└── .gitignore
```

## Core features

- Play audio from YouTube, SoundCloud, or direct media URLs
- Join a voice channel and keep a per-guild player state
- Show a live embed with now-playing details
- Support pause, resume, skip, and stop controls via Discord buttons
- Clean up stale voice state when a connection is destroyed
- Works well with Docker for consistent deployments

## Local setup

Requirements:

- Node.js 24.x
- npm
- a Discord bot token
- a Discord server where you can add the bot

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file:

```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id
GUILD_ID=your_server_id_optional
```

3. Register commands:

```bash
npm run deploy
```

4. Start the bot:

```bash
npm start
```

## Docker

The project includes a Dockerfile that uses the Node 24 Alpine base image.

Build:

```bash
docker build -t discord-music-bot .
```

Run:

```bash
docker run --env-file .env -d --name discord-music-bot discord-music-bot
```

This is useful if you want the bot to be easier to move between machines or run in a hosted container.

## Graceful shutdown behavior

The bot now listens for `SIGINT` and `SIGTERM` and cleans up active voice connections before exiting. This prevents stale voice sessions from hanging around when the process is stopped or restarted.

## Deployment and hosting

A Discord bot is a long-running background process, not a typical web app. The best hosts are ones that can run a Node process continuously and let you set environment variables.

### Free/low-cost options

| Platform | Best for | Why it works | Notes |
| --- | --- | --- | --- |
| Railway | Fastest setup | Easy Node deployment, simple env vars | Very friendly for Discord bots |
| Render | Simple hosting | Good for Node services and Docker | Great if you want a clean dashboard |
| Fly.io | Docker users | Runs containers well and supports small free workloads | Good for Docker-first setups |
| VPS (Hetzner / DigitalOcean) | Lowest long-term cost | Full control and predictable runtime | Best if you want maximum control |

### Example deployment flow

1. Push the project to GitHub.
2. Connect it to your host.
3. Add these environment variables:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - `GUILD_ID` (optional for dev, useful when testing in one server)
4. Set the start command to:

```bash
npm start
```

5. Run the deploy command after each release:

```bash
npm run deploy
```

### Docker deployment example

```bash
docker build -t discord-music-bot .
docker run --env-file .env -d --name discord-music-bot discord-music-bot
```

### Self-hosted VPS example

```bash
npm install --omit=dev
npm run deploy
npm i -g pm2
pm2 start index.js --name discord-music-bot
pm2 save
```

This keeps the bot alive after restarts and helps avoid manual restarts when the machine reboots.

## Important notes

- Keep only one bot instance per Discord server when playing audio.
- If you run multiple copies, voice connections can conflict and create the “ready → destroyed” pattern.
- If YouTube blocks playback from a host, moving the bot to a different network or using a different extraction method may help.
- For a production bot, keep secrets in the host environment or a secret manager, not inside source code.

## Best next upgrades

| Upgrade | Why it helps | Typical change |
| --- | --- | --- |
| Queue management | Lets one bot handle multiple tracks cleanly | Expand the guild state object and add a queue controller |
| `/skip`, `/queue`, `/nowplaying` | Makes the bot easier to control | New files under `commands/` |
| Persistent state | Keeps track across crashes/restarts | Add Redis or SQLite |
| Better logging | Easier debugging and support | Centralize bot logs and error tracking |
| Reconnect handling | Reduces downtime when the session drops | Watch connection lifecycle and cleanup state |

### Growth ideas

- Add a real queue with track titles and durations.
- Add skip/now-playing commands with plain Discord slash commands.
- Add volume and shuffle controls.
- Keep a persistent queue in a lightweight database.
- Add connection recovery so playback resumes after short Discord disconnects.

This bot is intentionally small, but it is structured in a way that makes these upgrades straightforward.
