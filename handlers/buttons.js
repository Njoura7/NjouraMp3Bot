import { MessageFlags } from 'discord.js';

export async function handle(interaction, client) {
  const state = client.players.get(interaction.guildId);

  if (!state) {
    return interaction.reply({
      content: '❌ Nothing is playing right now.',
      flags: MessageFlags.Ephemeral,
    });
  }

  switch (interaction.customId) {
    case 'pause': {
      const ok = state.player.pause(true);
      await interaction.reply({
        content: ok ? '⏸️ Paused.' : '⚠️ Already paused.',
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
    case 'resume': {
      const ok = state.player.unpause();
      await interaction.reply({
        content: ok ? '▶️ Resumed.' : '⚠️ Already playing.',
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
    case 'skip': {
      // Stopping the player fires AudioPlayerStatus.Idle, which triggers playNext
      state.player.stop();
      await interaction.reply({
        content: '⏭️ Skipped.',
        flags: MessageFlags.Ephemeral,
      });
      break;
    }
    case 'stop': {
      try { state.player.stop(true); } catch {}
      try { state.connection.destroy(); } catch {}
      try { state.playlistProc?.kill(); } catch {}
      client.players.delete(interaction.guildId);
      await interaction.update({ content: '⏹️ Stopped.', embeds: [], components: [] });
      break;
    }
    default:
      await interaction.reply({
        content: '❓ Unknown action.',
        flags: MessageFlags.Ephemeral,
      });
  }
}
