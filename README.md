# 🎵 Discord Music Bot — MVP

A minimal Discord bot that plays audio from a URL (YouTube, SoundCloud, or any direct `.mp3`/`.ogg` link) into a voice channel, with a clean embed + button UI (⏸️ ▶️ ⏹️).

```
discord-music-bot/
├── index.js              # Bot entry point — boots client, loads commands
├── deploy-commands.js    # Registers slash commands with Discord
├── commands/
│   └── play.js           # /play <url>
├── handlers/
│   └── buttons.js        # Pause / Resume / Stop button logic
├── package.json
├── Dockerfile
├── .env.example
└── .gitignore
```

---

## 📋 Prerequisites

| Tool        | Version       | Notes                                      |
| ----------- | ------------- | ------------------------------------------ |
| Node.js     | **≥ 18.17**   | `node -v` — needed for top-level `await`   |
| npm         | bundled       | comes with Node                            |
| Git         | any           | only if deploying via GitHub               |
| A Discord account + a server you own (or have *Manage Server* in) |

> **You do NOT need to install ffmpeg manually** — `ffmpeg-static` ships the binary.

---

## 🔧 Step 1 — Create the Discord Application & Bot

1. Go to **<https://discord.com/developers/applications>** → **New Application** → name it (e.g. `MyMusicBot`).
2. In the left sidebar, open **Bot**.
   - Click **Reset Token** → **copy the token**. (This is `DISCORD_TOKEN`.)
   - Scroll down to **Privileged Gateway Intents** — for this MVP you can leave them all **off**. We only use the public `Guilds` and `GuildVoiceStates` intents.
3. Open **General Information** → copy the **Application ID**. (This is `CLIENT_ID`.)
4. Open **OAuth2 → URL Generator**:
   - **Scopes:** check `bot` and `applications.commands`
   - **Bot Permissions:** check `View Channels`, `Send Messages`, `Embed Links`, `Connect`, `Speak`, `Use Slash Commands`
   - Copy the generated URL at the bottom, paste it in your browser, pick your server, **Authorize**.
5. (Optional, recommended for dev) Get your **server ID** = `GUILD_ID`:
   - In Discord: **User Settings → Advanced → Developer Mode = ON**
   - Right-click your server icon → **Copy Server ID**

---

## 💻 Step 2 — Local Setup

```bash
# 1. Drop these files in a folder, then install deps
npm install

# 2. Create your .env from the template
cp .env.example .env
# then edit .env and paste your three values:
#   DISCORD_TOKEN=...
#   CLIENT_ID=...
#   GUILD_ID=...   (optional but recommended during dev)

# 3. Register the /play slash command
npm run deploy
# ✅ Reloaded 1 command(s) in test guild.

# 4. Start the bot
npm start
# ✅ Logged in as MyMusicBot#1234
```

---

## 🧪 Step 3 — Try It

In any text channel of your server, while you're joined to a voice channel:

```
/play url: https://www.youtube.com/watch?v=dQw4w9WgXcQ
/play url: https://file-examples.com/storage/.../file_example_MP3_700KB.mp3
```

You should see an embed appear with three buttons. ⏸️ pauses, ▶️ resumes, ⏹️ stops and disconnects.

---

## 🎨 What the "UI" actually is

Discord doesn't render HTML, so the "UI" is a native **Embed** (purple accent, title = track name, thumbnail when available, footer with requester) plus a single **ActionRow** with three labeled buttons. It looks like a mini player card inside chat. Keeping it to three buttons is the deliberate "minimal yet creative" part — adding more (skip, queue, volume slider modal) is a one-file change in `commands/play.js`.

---

## 🚀 Step 4 — Deployment

A Discord bot is a **long-running background process**, not an HTTP server. So pick a host that runs workers, not just web requests.

### Option A — Railway (easiest)

1. Push your code to a **private GitHub repo** (don't commit `.env`).
2. Go to **<https://railway.app>** → **New Project → Deploy from GitHub repo**.
3. After it detects Node, go to **Variables** and add:
   - `DISCORD_TOKEN`
   - `CLIENT_ID`
   - (omit `GUILD_ID` in prod so commands go global, OR keep it pointed at one server)
4. Under **Settings → Service**, set:
   - **Start Command:** `npm start`
   - **Pre-deploy Command:** `npm run deploy`  *(registers commands on each deploy)*
5. Deploy. Watch logs for `✅ Logged in as ...`.

### Option B — Fly.io (free tier friendly, uses the Dockerfile)

```bash
# install flyctl, then:
fly launch          # answer prompts, decline Postgres/Redis
fly secrets set DISCORD_TOKEN=xxx CLIENT_ID=xxx
fly deploy
fly logs
```

### Option C — Your own VPS (DigitalOcean / Hetzner / etc.)

```bash
# on the server, as your user:
git clone <your-repo> && cd discord-music-bot
npm install --omit=dev
# create .env with the three vars
npm run deploy
# Run under a process manager so it survives reboots:
npm i -g pm2
pm2 start index.js --name music-bot
pm2 save
pm2 startup    # follow the printed command
```

---

## 🐛 Common Pitfalls

| Problem                                                 | Fix                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Used disallowed intents`                               | You enabled a privileged intent in the portal but didn't list it in `index.js`, or vice versa. This MVP needs **none**. |
| Slash command doesn't appear                            | You forgot `npm run deploy`. Or `GUILD_ID` is wrong. Global commands take up to 1 hour.   |
| Bot joins but no sound                                  | Make sure `npm install` finished cleanly and that the bot can load an Opus encoder. This project now uses **`opusscript`** by default so it works without native build tools on Windows. |
| `Error: Sign in to confirm you're not a bot` on YouTube | YouTube blocks some datacenter IPs. Switch hosts, or swap `play-dl` for `@distube/ytdl-core` with a cookie. (One-file change in `commands/play.js`.) |
| `ffmpeg` not found                                      | Shouldn't happen — `ffmpeg-static` is a dependency. Verify `node_modules/ffmpeg-static/` exists after install. |
| Bot is online but ignores commands                      | Check that `npm run deploy` ran *after* you invited the bot with the `applications.commands` scope. |

---

## 🛣️ Where to grow this MVP next

Each of these is a localized change:

- **Queue** — turn `client.players` value into `{ queue: [], current, ... }`; on `Idle`, shift next.
- **`/skip`, `/queue`, `/nowplaying`** — new files in `commands/`, auto-loaded by `index.js`.
- **Volume control** — Discord doesn't expose per-stream gain natively; wrap the resource with `{ inlineVolume: true }` and store the `AudioResource.volume.setVolume()` reference.
- **Spotify links** — `play-dl` returns track metadata, then resolve to a YouTube search and play that.
- **Persist player state across restarts** — Redis or a SQLite table keyed by `guildId`.

Have fun. 🎧
