import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Collection, MessageFlags } from 'discord.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import play from 'play-dl';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Allow play-dl to resolve YouTube stream URLs for more videos.
// Obtain your cookie from Chrome DevTools → Application → Cookies → youtube.com
// then set YOUTUBE_COOKIE in your .env file.
if (process.env.YOUTUBE_COOKIE) {
  await play.setToken({ youtube: { cookie: process.env.YOUTUBE_COOKIE } });
  console.log('✅ YouTube cookie loaded');
}

// play-dl requires a SoundCloud client ID before so_validate / play.stream will work.
// getFreeClientID() scrapes a working one from soundcloud.com — no account needed.
const scClientId = await play.getFreeClientID();
await play.setToken({ soundcloud: { client_id: scClientId } });
console.log('✅ SoundCloud client ID fetched');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

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

client.once(Events.ClientReady, (c) => console.log(`✅ Logged in as ${c.user.tag}`));

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

client.login(process.env.DISCORD_TOKEN);
