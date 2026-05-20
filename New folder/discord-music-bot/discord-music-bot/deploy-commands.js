import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('❌ DISCORD_TOKEN and CLIENT_ID are required in .env');
  process.exit(1);
}

const commands = [];
const commandsPath = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsPath).filter((f) => f.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const command = await import(pathToFileURL(filePath).href);
  if ('data' in command) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(DISCORD_TOKEN);

try {
  console.log(`🔄 Refreshing ${commands.length} application (/) command(s)...`);

  // Guild-scoped (instant) if GUILD_ID provided; otherwise global (~1h to propagate)
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  const data = await rest.put(route, { body: commands });
  console.log(`✅ Reloaded ${data.length} command(s) ${GUILD_ID ? 'in test guild' : 'globally'}.`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
