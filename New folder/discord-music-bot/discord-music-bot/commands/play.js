import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import play from 'play-dl';

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play audio from a URL in your voice channel')
  .addStringOption((opt) =>
    opt
      .setName('url')
      .setDescription('YouTube/SoundCloud URL or direct audio URL (mp3, ogg, etc.)')
      .setRequired(true),
  );

export async function execute(interaction, client) {
  const url = interaction.options.getString('url');
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.reply({
      content: '🎤 You need to be in a voice channel first.',
      ephemeral: true,
    });
  }

  await interaction.deferReply();

  // Tear down any existing player in this guild before starting a new one
  const existing = client.players.get(interaction.guildId);
  if (existing) {
    try { existing.player.stop(true); } catch {}
    try { existing.connection.destroy(); } catch {}
    client.players.delete(interaction.guildId);
  }

  let resource;
  let trackTitle = 'Audio Track';
  let thumbnail = null;
  let trackUrl = url;

  try {
    const isYT = play.yt_validate(url) === 'video';
    const isSC = play.so_validate(url) === 'track';

    if (isYT) {
      const info = await play.video_info(url);
      trackTitle = info.video_details.title;
      thumbnail = info.video_details.thumbnails?.[0]?.url ?? null;
      const stream = await play.stream_from_info(info, { quality: 2 });
      resource = createAudioResource(stream.stream, { inputType: stream.type });
    } else if (isSC) {
      const scInfo = await play.soundcloud(url);
      trackTitle = scInfo.name;
      thumbnail = scInfo.thumbnail ?? null;
      const stream = await play.stream(url);
      resource = createAudioResource(stream.stream, { inputType: stream.type });
    } else {
      // Treat as a direct audio URL (mp3, ogg, m4a, etc.)
      resource = createAudioResource(url);
      trackTitle = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'Direct stream');
    }
  } catch (err) {
    console.error('Resource error:', err);
    return interaction.editReply({
      content: `❌ Couldn't load that URL: \`${err.message}\``,
    });
  }

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (err) {
    connection.destroy();
    return interaction.editReply({ content: '❌ Failed to connect to voice channel.' });
  }

  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  connection.subscribe(player);
  player.play(resource);

  client.players.set(interaction.guildId, { player, connection, trackTitle, trackUrl });

  // Cleanup when track ends
  player.on(AudioPlayerStatus.Idle, () => {
    try { connection.destroy(); } catch {}
    client.players.delete(interaction.guildId);
  });

  player.on('error', (err) => {
    console.error('Player error:', err);
    try { connection.destroy(); } catch {}
    client.players.delete(interaction.guildId);
  });

  // 🎨 Creative-minimal UI: embed + 3 control buttons
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setAuthor({ name: '🎶  Now Playing' })
    .setTitle(trackTitle)
    .setURL(/^https?:\/\//.test(trackUrl) ? trackUrl : null)
    .setDescription(`Channel · **${voiceChannel.name}**`)
    .setFooter({
      text: `Requested by ${member.user.username}`,
      iconURL: member.user.displayAvatarURL(),
    })
    .setTimestamp();

  if (thumbnail) embed.setThumbnail(thumbnail);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('resume').setEmoji('▶️').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
