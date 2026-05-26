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
      .setDescription('YouTube/SoundCloud URL, search term, or YouTube playlist/mix URL')
      .setRequired(true),
  );

// ── Embed & button builders ───────────────────────────────────────────────────

function buildEmbed(state) {
  const { current, queue, voiceChannelName } = state;
  const validUrl = /^https?:\/\//.test(current.url) ? current.url : null;

  let queueLines = '';
  if (queue.length > 0) {
    queueLines += `\n⏭  **Next:** ${queue[0].title}`;
    if (queue.length > 1) {
      queueLines += `\n📋  **${queue.length - 1}** more track${queue.length - 1 !== 1 ? 's' : ''} in queue`;
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0x7C3AED)
    .setAuthor({ name: '◈  njrMP3' })
    .setTitle(current.title)
    .setURL(validUrl)
    .setDescription(
      `**▶  Now Streaming**\n` +
      `╰  \`${voiceChannelName}\`` +
      queueLines + `\n\n` +
      `\`▬▬▬◉─────────────────────\``,
    )
    .setFooter({
      text: `✦ NJR  ·  ${current.requester.username}`,
      iconURL: current.requester.avatarURL,
    })
    .setTimestamp();

  if (current.thumbnail) embed.setImage(current.thumbnail);
  return embed;
}

function buildRow(queueSize) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('pause').setEmoji('⏸️').setLabel('Pause').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('resume').setEmoji('▶️').setLabel('Resume').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('skip').setEmoji('⏭️').setLabel('Skip').setStyle(ButtonStyle.Primary).setDisabled(queueSize === 0),
    new ButtonBuilder().setCustomId('stop').setEmoji('⏹️').setLabel('Stop').setStyle(ButtonStyle.Danger),
  );
}

// ── Audio resource factory ────────────────────────────────────────────────────

async function createResource(track) {
  const { url } = track;
  const hostname = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  })();
  const isYT = hostname === 'youtube.com' || hostname === 'youtu.be' || hostname === 'music.youtube.com';
  const isSC = hostname === 'soundcloud.com';

  if (isYT) {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      noPlaylist: true,
      format: 'bestaudio[ext=webm][acodec=opus]/bestaudio[ext=webm]/bestaudio',
    });
    if (!track.title || track.title === 'Unknown Track') track.title = info.title ?? track.title;
    if (!track.thumbnail) track.thumbnail = info.thumbnail ?? null;

    const isNativeOpus = info.ext === 'webm' && info.acodec === 'opus';
    const proc = ytDlp.exec(url, {
      output: '-',
      format: info.format_id,
      noPlaylist: true,
      noWarnings: true,
      noCheckCertificates: true,
    });
    return createAudioResource(proc.stdout, {
      inputType: isNativeOpus ? StreamType.WebmOpus : StreamType.Arbitrary,
    });
  }

  if (isSC) {
    const info = await ytDlp(url, {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      format: 'bestaudio',
    });
    if (!track.title || track.title === 'Unknown Track') track.title = info.title ?? track.title;
    if (!track.thumbnail) track.thumbnail = info.thumbnail ?? null;

    const proc = ytDlp.exec(url, {
      output: '-',
      format: info.format_id,
      noWarnings: true,
      noCheckCertificates: true,
    });
    return createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary });
  }

  // Direct audio URL
  if (!track.title || track.title === 'Unknown Track') {
    track.title = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'Direct Stream');
  }
  return createAudioResource(url);
}

// ── Queue advance ─────────────────────────────────────────────────────────────

async function playNext(guildId, client) {
  const state = client.players.get(guildId);
  if (!state) return;

  const next = state.queue.shift();

  if (!next) {
    // Queue exhausted — leave channel and mark embed as finished
    try { state.connection.destroy(); } catch {}
    client.players.delete(guildId);
    if (state.nowPlayingMessage) {
      try {
        await state.nowPlayingMessage.edit({
          embeds: [
            new EmbedBuilder()
              .setColor(0x7C3AED)
              .setAuthor({ name: '◈  njrMP3' })
              .setDescription('✅  Queue finished.')
              .setTimestamp(),
          ],
          components: [],
        });
      } catch {}
    }
    return;
  }

  state.current = next;

  let resource;
  try {
    resource = await createResource(next);
  } catch (err) {
    console.error(`[PLAYER] ${guildId} failed to load "${next.title}":`, err);
    return playNext(guildId, client); // skip broken track, try next
  }

  state.player.play(resource);

  // Register the next advance before editing the message so there is no gap
  state.player.once(AudioPlayerStatus.Idle, () => {
    playNext(guildId, client).catch(console.error);
  });

  if (state.nowPlayingMessage) {
    try {
      await state.nowPlayingMessage.edit({
        embeds: [buildEmbed(state)],
        components: [buildRow(state.queue.length)],
      });
    } catch {}
  }
}

// ── Slash command ─────────────────────────────────────────────────────────────

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

  // ── Resolve query to an array of track objects ──────────────────────────────
  const isRawURL = /^https?:\/\//.test(query);
  const requester = { username: member.user.username, avatarURL: member.user.displayAvatarURL() };
  let tracks = [];

  if (!isRawURL) {
    // Text search → single YouTube video
    try {
      const [hit] = await play.search(query, { source: { youtube: 'video' }, limit: 1 });
      if (!hit) return interaction.editReply(`❌ No results found for **${query}**.`);
      tracks.push({
        url: hit.url,
        title: hit.title ?? query,
        thumbnail: hit.thumbnails?.[0]?.url ?? null,
        requester,
      });
    } catch (err) {
      console.error('Search error:', err);
      return interaction.editReply('❌ YouTube search failed. Try pasting a direct URL instead.');
    }
  } else {
    let parsedURL;
    try { parsedURL = new URL(query); } catch {
      return interaction.editReply("❌ That doesn't look like a valid URL.");
    }

    const hostname = parsedURL.hostname.replace(/^www\./, '');
    const isYT = hostname === 'youtube.com' || hostname === 'youtu.be' || hostname === 'music.youtube.com';
    const isSC = hostname === 'soundcloud.com';
    const hasList  = parsedURL.searchParams.has('list');
    const hasVideo = parsedURL.searchParams.has('v');
    const listId   = parsedURL.searchParams.get('list') ?? '';
    // Radio/mix lists start with RD, RL, or RDMM
    const isRadioMix = hasList && /^(RD|RL|RDMM)/.test(listId);

    if (isYT && (isRadioMix || (hasList && !hasVideo))) {
      // ── YouTube playlist or radio mix ────────────────────────────────────────
      await interaction.editReply('⏳ Loading playlist…');
      try {
        const info = await ytDlp(query, {
          dumpSingleJson: true,
          flatPlaylist: true,
          noWarnings: true,
          noCheckCertificates: true,
        });
        for (const e of info.entries ?? []) {
          const vUrl = /^https?:\/\//.test(e.url ?? '')
            ? e.url
            : `https://www.youtube.com/watch?v=${e.id}`;
          tracks.push({
            url: vUrl,
            title: e.title ?? 'Unknown Track',
            thumbnail: e.thumbnail ?? null,
            requester,
          });
        }
      } catch (err) {
        console.error('Playlist fetch error:', err);
      }
      if (tracks.length === 0) {
        return interaction.editReply('❌ Playlist is empty or unavailable.');
      }

    } else if (isYT) {
      // ── Single YouTube video (strip any playlist sidebar params) ─────────────
      if (hasList) {
        parsedURL.searchParams.delete('list');
        parsedURL.searchParams.delete('index');
        parsedURL.searchParams.delete('start_radio');
      }
      const singleUrl = parsedURL.toString();
      if (play.yt_validate(singleUrl) === 'playlist') {
        return interaction.editReply('❌ Provide a single video URL, not a bare playlist URL.');
      }
      tracks.push({ url: singleUrl, title: 'Unknown Track', thumbnail: null, requester });

    } else if (isSC) {
      const scStatus = await play.so_validate(query);
      if (scStatus !== 'track') {
        return interaction.editReply('❌ SoundCloud playlists/albums are not supported. Provide a track URL.');
      }
      tracks.push({ url: query, title: 'Unknown Track', thumbnail: null, requester });

    } else {
      // Direct audio URL
      const title = decodeURIComponent(query.split('/').pop()?.split('?')[0] ?? 'Direct Stream');
      tracks.push({ url: query, title, thumbnail: null, requester });
    }
  }

  if (tracks.length === 0) {
    return interaction.editReply('❌ No tracks found.');
  }

  // ── If already playing: append to queue, keep current song running ──────────
  const existing = client.players.get(interaction.guildId);
  if (existing) {
    existing.queue.push(...tracks);

    // Update the live now-playing embed to reflect the updated queue
    if (existing.nowPlayingMessage) {
      try {
        await existing.nowPlayingMessage.edit({
          embeds: [buildEmbed(existing)],
          components: [buildRow(existing.queue.length)],
        });
      } catch {}
    }

    const count = tracks.length;
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x7C3AED)
          .setAuthor({ name: '◈  njrMP3' })
          .setTitle(count === 1 ? tracks[0].title : `${count} tracks added`)
          .setDescription(
            (count === 1
              ? `**📋  Added to Queue**\n╰  Will play after current song`
              : `**📋  Added to Queue**\n╰  ${count} tracks added at the end`) +
            `\n\n▶  Now playing: **${existing.current?.title ?? '…'}**`,
          )
          .setFooter({ text: `✦ NJR  ·  ${member.user.username}`, iconURL: member.user.displayAvatarURL() })
          .setTimestamp(),
      ],
    });
  }

  // ── Nothing playing — start fresh ────────────────────────────────────────────
  const first = tracks.shift(); // first track plays now, rest go to queue

  let resource;
  try {
    resource = await createResource(first);
  } catch (err) {
    console.error('Stream error:', err);
    return interaction.editReply(`❌ Failed to load audio: \`${err.message}\``);
  }

  // Join voice channel
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

  // Register early so a concurrent /njrmp3 can clean up cleanly
  const state = {
    player: null,
    connection,
    queue: tracks,
    current: first,
    voiceChannelName: voiceChannel.name,
    nowPlayingMessage: null,
  };
  client.players.set(interaction.guildId, state);

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

  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  state.player = player;
  connection.subscribe(player);
  player.play(resource);

  // Each track hands off to the next via the Idle event
  player.once(AudioPlayerStatus.Idle, () => {
    playNext(interaction.guildId, client).catch(console.error);
  });

  player.on('error', (err) => {
    console.error(`[PLAYER] ${interaction.guildId} error:`, err);
    // Idle will fire after the error and advance the queue automatically
  });

  // Send now-playing embed and store message reference for future auto-updates
  const embed = buildEmbed(state);
  const row = buildRow(state.queue.length);
  await interaction.editReply({ embeds: [embed], components: [row] });

  try {
    state.nowPlayingMessage = await interaction.fetchReply();
  } catch {}
}
