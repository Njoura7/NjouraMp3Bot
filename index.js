import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Collection, MessageFlags, ActivityType } from 'discord.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import play from 'play-dl';
import ytDlp from 'yt-dlp-exec';
import { startHealthServer } from './health.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Bind the health-check port immediately, before any of the slower startup
// steps below — a host like Render expects the port open quickly or it
// considers the deploy failed.
const healthServer = startHealthServer(client);

// YouTube changes its anti-bot measures often enough that a yt-dlp binary a
// few months old starts failing downloads with plain HTTP 403s. Self-update
// on every boot so this doesn't silently regress between deploys.
try {
  const result = await ytDlp(undefined, { update: true });
  console.log(`✅ yt-dlp: ${result.trim().split('\n').pop()}`);
} catch (err) {
  // yt-dlp exits 100 specifically after it *successfully* replaces its own
  // binary on disk, as a "restart to pick up the new build" signal — not a
  // real failure. Since every actual download spawns a brand-new process,
  // the replaced binary is already in effect for the very next yt-dlp call.
  if (err.exitCode === 100) {
    const line = (err.stdout || '').trim().split('\n').pop();
    console.log(`✅ yt-dlp: ${line || 'updated to latest'}`);
  } else {
    console.warn('⚠️  yt-dlp self-update check failed (continuing with current version):', err.shortMessage || err.message);
  }
}

// Allow play-dl to resolve YouTube stream URLs for more videos.
// Obtain your cookie from Chrome DevTools → Application → Cookies → youtube.com
// then set YOUTUBE_COOKIE in your .env file.
if (process.env.YOUTUBE_COOKIE) {
  await play.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIE } });
  console.log('✅ YouTube cookie loaded');
}

// play-dl requires a SoundCloud client ID before so_validate / play.stream will work.
// getFreeClientID() scrapes a working one from soundcloud.com — no account needed.
// This is a network call to a third-party site and can fail transiently
// (e.g. ECONNRESET); don't let that take down YouTube playback too.
try {
  const scClientId = await play.getFreeClientID();
  await play.setToken({ soundcloud: { client_id: scClientId } });
  console.log('✅ SoundCloud client ID fetched');
} catch (err) {
  console.warn('⚠️  Failed to fetch SoundCloud client ID (SoundCloud links will fail until next restart):', err.message);
}

client.commands = new Collection();
// Per-guild audio state: guildId → { player, connection, trackTitle, trackUrl }
client.players = new Collection();

const commandsPath = join(__dirname, 'commands');
for (const file of readdirSync(commandsPath).filter((f) => f.endsWith('.js'))) {
  const command = await import(pathToFileURL(join(commandsPath, file)).href);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`[WARN] ${file} is missing "data" or "execute" export.`);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);

  // Set via the host's dashboard (e.g. Render env vars) — leave unset locally.
  if (process.env.LOW_PRIORITY_HOSTING === 'true') {
    c.user.setActivity('⚡ free-tier server — may lag', { type: ActivityType.Watching });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;

      // deferReply can fail with 10062 (Unknown Interaction) if the bot restarted
      // and Discord re-delivered a stale token whose 3-second window already passed.
      // Silently drop those — there is nothing meaningful we can do with them.
      try {
        await interaction.deferReply();
      } catch (err) {
        if (err.code === 10062) return;
        throw err;
      }

      await command.execute(interaction, client);

    } else if (interaction.isButton()) {
      const { handle } = await import('./handlers/buttons.js');
      await handle(interaction, client);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: '❌ Something went wrong.', flags: MessageFlags.Ephemeral };
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    } catch { /* interaction may have already expired */ }
  }
});

process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

async function shutdownBot(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}. Cleaning up voice connections...`);

  for (const state of client.players.values()) {
    try { state.player?.stop(true); } catch {}
    try { state.connection?.destroy(); } catch {}
  }

  client.players.clear();

  try { healthServer.close(); } catch {}

  try {
    await client.destroy();
  } catch (err) {
    console.error('[SHUTDOWN] Failed to destroy client cleanly:', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => shutdownBot('SIGINT'));
process.on('SIGTERM', () => shutdownBot('SIGTERM'));

client.login(process.env.DISCORD_TOKEN);
