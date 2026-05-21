import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import play from 'play-dl';
import ytDlp from 'yt-dlp-exec';

export const data = new SlashCommandBuilder()
  .setName('njrmp3')
  .setDescription('Play audio in your voice channel')
  .addStringOption((opt) =>
    opt
      .setName('query')
      .setDescription('YouTube/SoundCloud URL, or a search term')
      .setRequired(true),
  );

export async function execute(interaction, client) {
  const query = interaction.options.getString('query');
  const member = interaction.member;
  const voiceChannel = member?.voice?.channel;

  if (!voiceChannel) {
    return interaction.editReply('🎤 You need to be in a voice channel first.');
  }

  const me = interaction.guild.members.me;
  if (me) {
    const perms = voiceChannel.permissionsFor(me);
    const missing = [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak]
      .filter((p) => !perms?.has(p));
    if (missing.length) {
      return interaction.editReply('❌ I need **Connect** and **Speak** permissions in that voice channel.');
    }
  }

  // --- Resolve input: search YouTube if not a raw URL ---
  const isRawURL = /^https?:\/\//.test(query);
  let url = query;
  let trackTitle = 'Unknown Track';
  let thumbnail = null;

  if (!isRawURL) {
    try {
      const [hit] = await play.search(query, { source: { youtube: 'video' }, limit: 1 });
      if (!hit) return interaction.editReply(`❌ No results found for **${query}**.`);
      url = hit.url;
      trackTitle = hit.title ?? query;
      thumbnail = hit.thumbnails?.[0]?.url ?? null;
    } catch (err) {
      console.error('Search error:', err);
      return interaction.editReply('❌ YouTube search failed. Try pasting a direct URL instead.');
    }
  }

  // --- Determine platform from URL hostname ---
  let parsedURL;
  try {
    parsedURL = new URL(url);
  } catch {
    return interaction.editReply("❌ That doesn't look like a valid URL.");
  }
  const hostname = parsedURL.hostname.replace(/^www\./, '');
  const isYT = hostname === 'youtube.com' || hostname === 'youtu.be' || hostname === 'music.youtube.com';
  const isSC = hostname === 'soundcloud.com';

  // Strip playlist params from YouTube sidebar URLs that also carry a video ID
  if (isYT && parsedURL.searchParams.has('list') && parsedURL.searchParams.has('v')) {
    parsedURL.searchParams.delete('list');
    parsedURL.searchParams.delete('index');
    url = parsedURL.toString();
  }

  // Validate: reject pure YouTube playlists (no video ID)
  if (isYT && play.yt_validate(url) === 'playlist') {
    return interaction.editReply('❌ YouTube playlists are not supported. Provide a single video URL.');
  }

  // Validate SoundCloud (so_validate is async)
  if (isSC) {
    const scStatus = await play.so_validate(url);
    if (scStatus !== 'track') {
      return interaction.editReply('❌ SoundCloud playlists/albums are not supported. Provide a track URL.');
    }
  }

  // --- Create audio resource ---
  let resource;
  try {
    if (isYT) {
      // yt-dlp: the only tool that reliably handles YouTube's bot detection.
      // Prefer webm/opus so @discordjs/voice can use it without ffmpeg transcoding.
      const info = await ytDlp(url, {
        dumpSingleJson: true,
        noWarnings: true,
        noCheckCertificates: true,
        noPlaylist: true,
        format: 'bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio',
      });

      // Always use yt-dlp's own metadata — more accurate than search snippets
      trackTitle = info.title ?? trackTitle;
      thumbnail = info.thumbnail ?? thumbnail;

      // webm/opus can be sent to Discord as-is (no CPU-heavy ffmpeg re-encode)
      const isNativeOpus = info.ext === 'webm' && info.acodec === 'opus';
      resource = createAudioResource(info.url, {
        inputType: isNativeOpus ? StreamType.WebmOpus : StreamType.Arbitrary,
      });

    } else if (isSC) {
      // SoundCloud via play-dl (still works reliably)
      try {
        const scInfo = await play.soundcloud(url);
        trackTitle = scInfo.name ?? trackTitle;
        thumbnail = scInfo.thumbnail ?? null;
      } catch { /* metadata is optional */ }

      const stream = await play.stream(url);
      resource = createAudioResource(stream.stream, { inputType: stream.type });

    } else {
      // Direct audio URL (mp3, ogg, m4a, …)
      trackTitle = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'Direct Stream');
      resource = createAudioResource(url);
    }
  } catch (err) {
    console.error('Stream error:', err);
    return interaction.editReply(`❌ Failed to load audio: \`${err.message}\``);
  }

  // --- Tear down any existing session for this guild ---
  const existing = client.players.get(interaction.guildId);
  if (existing) {
    try { existing.player?.stop(true); } catch {}
    try { existing.connection?.destroy(); } catch {}
    client.players.delete(interaction.guildId);
  }

  // --- Join voice channel ---
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('stateChange', (old, next) =>
    console.log(`[VOICE] ${interaction.guildId} ${old.status} -> ${next.status}`),
  );
  connection.on('error', (err) =>
    console.error(`[VOICE] ${interaction.guildId} error:`, err),
  );

  // Register immediately — if a second /play fires while we're waiting for Ready,
  // the cleanup block above will find this entry and destroy it cleanly instead of
  // creating a second competing connection (which causes signalling → destroyed).
  client.players.set(interaction.guildId, { player: null, connection, trackTitle, trackUrl: url });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  } catch (err) {
    connection.destroy();
    client.players.delete(interaction.guildId);
    return interaction.editReply(
      `❌ Failed to connect to voice channel.${err?.message ? ` Reason: ${err.message}` : ''}\n` +
      `💡 If this keeps happening: make sure only one bot instance is running, and allow **Node.js** through Windows Firewall (UDP in + out).`,
    );
  }

  // --- Start playback ---
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });

  connection.subscribe(player);
  player.play(resource);

  client.players.set(interaction.guildId, { player, connection, trackTitle, trackUrl: url });

  player.once(AudioPlayerStatus.Idle, () => {
    console.log(`[PLAYER] ${interaction.guildId} track ended (Idle)`);
    try { connection.destroy(); } catch {}
    client.players.delete(interaction.guildId);
  });

  player.on('error', (err) => {
    console.error(`[PLAYER] ${interaction.guildId} error:`, err);
    try { connection.destroy(); } catch {}
    client.players.delete(interaction.guildId);
  });

  // --- Now Playing embed ---
  const validUrl = /^https?:\/\//.test(url) ? url : null;

  const embed = new EmbedBuilder()
    .setColor(0x7C3AED)
    .setAuthor({ name: '◈  njrMP3' })
    .setTitle(trackTitle)
    .setURL(validUrl)
    .setDescription(
      `**▶  Now Streaming**\n` +
      `╰  \`${voiceChannel.name}\`\n\n` +
      `\`▬▬▬◉─────────────────────\``,
    )
    .setFooter({
      text: `✦ NJR  ·  ${member.user.username}`,
      iconURL: member.user.displayAvatarURL(),
    })
    .setTimestamp();

  if (thumbnail) embed.setImage(thumbnail);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setLabel('Pause').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('resume').setEmoji('▶️').setLabel('Resume').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}
