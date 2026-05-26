export async function handle(interaction, client) {
  const state = client.players.get(interaction.guildId);

  if (!state) {
    return interaction.reply({ content: '❌ Nothing is playing right now.', ephemeral: true });
  }

  switch (interaction.customId) {
    case 'pause': {
      const ok = state.player.pause(true);
      await interaction.reply({ content: ok ? '⏸️ Paused.' : '⚠️ Already paused.', ephemeral: true });
      break;
    }
    case 'resume': {
      const ok = state.player.unpause();
      await interaction.reply({ content: ok ? '▶️ Resumed.' : '⚠️ Already playing.', ephemeral: true });
      break;
    }
    case 'skip': {
      // Stopping the player fires AudioPlayerStatus.Idle, which triggers playNext
      state.player.stop();
      await interaction.reply({ content: '⏭️ Skipped.', ephemeral: true });
      break;
    }
    case 'stop': {
      try { state.player.stop(true); } catch {}
      try { state.connection.destroy(); } catch {}
      client.players.delete(interaction.guildId);
      await interaction.update({ content: '⏹️ Stopped.', embeds: [], components: [] });
      break;
    }
    default:
      await interaction.reply({ content: '❓ Unknown action.', ephemeral: true });
  }
}
