import 'dotenv/config';
import { Client, GatewayIntentBits, Events, Collection } from 'discord.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Slash commands registry
client.commands = new Collection();
// Per-guild audio player state: guildId -> { player, connection, trackTitle }
client.players = new Collection();

// Load all command modules from /commands
const commandsPath = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const command = await import(pathToFileURL(filePath).href);
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`[WARN] Command ${file} is missing "data" or "execute" export.`);
  }
}

client.once(Events.ClientReady, (c) => {
  console.log(`✅ Logged in as ${c.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction, client);
    } else if (interaction.isButton()) {
      const { handle } = await import('./handlers/buttons.js');
      await handle(interaction, client);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: '❌ Something went wrong.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(payload).catch(() => {});
    } else {
      await interaction.reply(payload).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
