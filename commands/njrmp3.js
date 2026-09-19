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
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── yt-dlp authentication ─────────────────────────────────────────────────────
// YOUTUBE_COOKIE (already used for play-dl's search) is a raw "name=value;
// name2=value2" header. yt-dlp needs a Netscape-format cookies.txt instead —
// convert it once and cache the path. Without this, every yt-dlp request is
// anonymous, which YouTube throttles hard after a few rapid successive calls
// (exactly what happens once the queue starts advancing track to track).

let ytDlpCookiesFile;

function getYtDlpCookiesFile() {
  if (ytDlpCookiesFile !== undefined) return ytDlpCookiesFile;

  const raw = process.env.YOUTUBE_COOKIE;
  if (!raw) {
    ytDlpCookiesFile = null;
    return null;
  }

  const expiry = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const pair of raw.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    lines.push(['.youtube.com', 'TRUE', '/', 'TRUE', String(expiry), name, value].join('\t'));
  }

  const file = join(tmpdir(), `njrmp3-yt-cookies-${process.pid}.txt`);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  ytDlpCookiesFile = file;
  return file;
}

function ytCookieFlags() {
  const file = getYtDlpCookiesFile();
  return file ? { cookies: file } : {};
}

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

// Set LOW_PRIORITY_HOSTING=true on the host's dashboard (e.g. Render free
// tier) to disclose that this is running on shared, resource-limited hosting.
// Leave unset locally so dev runs stay clean.
const LOW_PRIORITY_NOTE = '  ·  🐢 free-tier server — thanks for your patience';

function footerText(username) {
  const base = `✦ NJR  ·  ${username}`;
  return process.env.LOW_PRIORITY_HOSTING === 'true' ? `${base}${LOW_PRIORITY_NOTE}` : base;
}

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
      text: footerText(current.requester.username),
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

function clearGuildState(client, guildId) {
  const state = client.players.get(guildId);
  if (!state) return;

  try { state.player?.stop(true); } catch {}
  try { state.connection?.destroy(); } catch {}
  try { state.playlistProc?.kill(); } catch {}
  client.players.delete(guildId);
}

// ── Playlist/mix streaming ────────────────────────────────────────────────────
// Large YouTube Mixes can take many minutes to fully paginate, so we don't wait
// for the whole listing: --lazy-playlist lets yt-dlp print each entry as it's
// found, so we can start playback after the first one and load the rest in the
// background instead of blocking the command on the entire playlist.

function entryToTrack(line, requester) {
  const entry = JSON.parse(line);
  const url = /^https?:\/\//.test(entry.url ?? '')
    ? entry.url
    : `https://www.youtube.com/watch?v=${entry.id}`;
  return { url, title: entry.title ?? 'Unknown Track', thumbnail: entry.thumbnail ?? null, requester };
}

function streamPlaylist(query) {
  const proc = ytDlp.exec(query, {
    flatPlaylist: true,
    lazyPlaylist: true,
    dumpJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    ...ytCookieFlags(),
  });
  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  return { proc, rl, iterator: rl[Symbol.asyncIterator]() };
}

async function loadRemainingPlaylistTracks(guildId, client, playlist, requester, targetState) {
  const { proc, rl, iterator } = playlist;
  let appended = 0;
  try {
    while (true) {
      const { value: line, done } = await iterator.next();
      if (done) break;
      if (!line.trim()) continue;

      const liveState = client.players.get(guildId);
      if (liveState !== targetState) break; // session ended/replaced — stop loading

      let track;
      try { track = entryToTrack(line, requester); } catch { continue; }
      liveState.queue.push(track);
      appended += 1;

      if (appended % 10 === 0 && liveState.nowPlayingMessage) {
        try {
          await liveState.nowPlayingMessage.edit({
            embeds: [buildEmbed(liveState)],
            components: [buildRow(liveState.queue.length)],
          });
        } catch {}
      }
    }
  } catch (err) {
    console.error(`[PLAYLIST] ${guildId} background load error:`, err);
  } finally {
    try { rl.close(); } catch {}
    try { proc.kill(); } catch {}
    const liveState = client.players.get(guildId);
    if (liveState === targetState) {
      if (liveState.playlistProc === proc) liveState.playlistProc = null;
      if (liveState.nowPlayingMessage) {
        try {
          await liveState.nowPlayingMessage.edit({
            embeds: [buildEmbed(liveState)],
            components: [buildRow(liveState.queue.length)],
          });
        } catch {}
      }
    }
  }
}

// ── Audio resource factory ────────────────────────────────────────────────────

// yt-dlp's download process is piped straight into createAudioResource and its
// stderr/exit code were never inspected, so failures (e.g. an HTTP 403 from
// YouTube) surfaced only as a silent, unexplained Idle a couple seconds later.
// Capture stderr and log the real reason instead of dropping it.
function logDownloadFailure(track, proc) {
  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr += d; });
  proc.catch((err) => {
    const reason = stderr.trim().split('\n').filter(Boolean).pop() || err.shortMessage || err.message;
    console.error(`[YT-DLP] download failed for "${track.title}": ${reason}`);
  });
}

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
      ...ytCookieFlags(),
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
      ...ytCookieFlags(),
    });
    logDownloadFailure(track, proc);
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
    logDownloadFailure(track, proc);
    return createAudioResource(proc.stdout, { inputType: StreamType.Arbitrary });
  }

  // Direct audio URL
  if (!track.title || track.title === 'Unknown Track') {
    track.title = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'Direct Stream');
  }
  return createAudioResource(url);
}

// ── Queue advance ─────────────────────────────────────────────────────────────

// @discordjs/voice silently drops the player to Idle (no 'error' event) when a
// resource's stream ends/closes before ever becoming readable. YouTube's CDN
// token checks are flaky enough that the very same track can 403 and then
// succeed moments later, so a short-lived playback gets a few retries before
// we give up and move on to the next track.
const SHORT_PLAYBACK_MS = 5000;
const MAX_TRACK_RETRIES = 2;
const TRACK_RETRY_DELAY_MS = 1500;

function handleTrackEnd(guildId, client, track, startedAt, retriesLeft) {
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs >= SHORT_PLAYBACK_MS) {
    playNext(guildId, client).catch(console.error);
    return;
  }

  if (retriesLeft > 0) {
    console.warn(`[PLAYER] ${guildId} "${track.title}" stopped after only ${elapsedMs}ms — retrying (${retriesLeft} attempt${retriesLeft === 1 ? '' : 's'} left).`);
    setTimeout(() => {
      playNext(guildId, client, track, retriesLeft - 1).catch(console.error);
    }, TRACK_RETRY_DELAY_MS);
    return;
  }

  console.warn(`[PLAYER] ${guildId} "${track.title}" stopped after only ${elapsedMs}ms — giving up after retries, skipping to next track.`);
  playNext(guildId, client).catch(console.error);
}

async function playNext(guildId, client, retryTrack = null, retriesLeft = MAX_TRACK_RETRIES) {
  const state = client.players.get(guildId);
  if (!state) return;

  let next = retryTrack ?? state.queue.shift();

  // A background playlist load may still be streaming in more tracks —
  // wait for it instead of declaring the queue empty prematurely.
  while (!next && state.playlistProc) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (client.players.get(guildId) !== state) return; // session ended while waiting
    next = state.queue.shift();
  }

  if (!next) {
    // Queue exhausted — leave channel and mark embed as finished
    clearGuildState(client, guildId);
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
    if (retriesLeft > 0) {
      console.warn(`[PLAYER] ${guildId} failed to load "${next.title}" (${err.message}) — retrying (${retriesLeft} attempt${retriesLeft === 1 ? '' : 's'} left).`);
      setTimeout(() => {
        playNext(guildId, client, next, retriesLeft - 1).catch(console.error);
      }, TRACK_RETRY_DELAY_MS);
      return;
    }
    console.error(`[PLAYER] ${guildId} failed to load "${next.title}" after retries:`, err);
    return playNext(guildId, client); // skip broken track, try next
  }

  state.player.play(resource);
  const startedAt = Date.now();

  // Register the next advance before editing the message so there is no gap
  state.player.once(AudioPlayerStatus.Idle, () => {
    handleTrackEnd(guildId, client, next, startedAt, retriesLeft);
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
  let backgroundPlaylist = null;

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
      // Large mixes can take minutes to fully paginate, so only wait for the
      // first entry here; the rest streams into the queue in the background
      // (see backgroundPlaylist below) once playback has started.
      await interaction.editReply('⏳ Loading playlist…');
      const playlist = streamPlaylist(query);
      let firstTrack = null;
      try {
        while (true) {
          const { value: line, done } = await playlist.iterator.next();
          if (done) break;
          if (!line.trim()) continue;
          try { firstTrack = entryToTrack(line, requester); } catch { continue; }
          break;
        }
      } catch (err) {
        console.error('Playlist fetch error:', err);
      }

      if (!firstTrack) {
        try { playlist.rl.close(); } catch {}
        try { playlist.proc.kill(); } catch {}
        return interaction.editReply('❌ Playlist is empty or unavailable.');
      }

      tracks.push(firstTrack);
      backgroundPlaylist = playlist;

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
  if (existing && existing.connection?.destroyed) {
    clearGuildState(client, interaction.guildId);
  }

  const activeState = client.players.get(interaction.guildId);
  if (activeState) {
    const playAfter = activeState.queue.length > 0
      ? activeState.queue[activeState.queue.length - 1].title
      : activeState.current?.title ?? '…';
    activeState.queue.push(...tracks);

    if (backgroundPlaylist) {
      activeState.playlistProc = backgroundPlaylist.proc;
      loadRemainingPlaylistTracks(interaction.guildId, client, backgroundPlaylist, requester, activeState).catch(console.error);
    }

    // Update the live now-playing embed to reflect the updated queue
    if (activeState.nowPlayingMessage) {
      try {
        await activeState.nowPlayingMessage.edit({
          embeds: [buildEmbed(activeState)],
          components: [buildRow(activeState.queue.length)],
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
              ? `**📋  Added to Queue**\n╰  Will play after **${playAfter}**`
              : `**📋  Added to Queue**\n╰  ${count} tracks will play after **${playAfter}**`) +
            `\n\n▶  Now playing: **${activeState.current?.title ?? '…'}**`,
          )
          .setFooter({ text: footerText(member.user.username), iconURL: member.user.displayAvatarURL() })
          .setTimestamp(),
      ],
    });
  }

  // ── Nothing playing — start fresh ────────────────────────────────────────────
  const first = tracks.shift(); // first track plays now, rest go to queue

  let resource;
  let lastErr;
  for (let attempt = 0; attempt <= MAX_TRACK_RETRIES; attempt++) {
    try {
      resource = await createResource(first);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_TRACK_RETRIES) {
        console.warn(`[PLAYER] ${interaction.guildId} failed to load "${first.title}" (${err.message}) — retrying.`);
        await new Promise((resolve) => setTimeout(resolve, TRACK_RETRY_DELAY_MS));
      }
    }
  }
  if (lastErr) {
    console.error('Stream error:', lastErr);
    return interaction.editReply(`❌ Failed to load audio: \`${lastErr.message}\``);
  }

  // Join voice channel
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guildId,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  connection.on('stateChange', (old, next) => {
    console.log(`[VOICE] ${interaction.guildId} ${old.status} -> ${next.status}`);
    if (next.status === VoiceConnectionStatus.Destroyed) {
      client.players.delete(interaction.guildId);
    }
  });
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
    playlistProc: backgroundPlaylist?.proc ?? null,
  };
  client.players.set(interaction.guildId, state);

  if (backgroundPlaylist) {
    loadRemainingPlaylistTracks(interaction.guildId, client, backgroundPlaylist, requester, state).catch(console.error);
  }

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
  const startedAt = Date.now();

  // Each track hands off to the next via the Idle event
  player.once(AudioPlayerStatus.Idle, () => {
    handleTrackEnd(interaction.guildId, client, first, startedAt, MAX_TRACK_RETRIES);
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
