require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');
const crypto = require('crypto');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const app = express();
app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;
const UNIVERSE_ID = process.env.UNIVERSE_ID;
const DATASTORE_NAME = 'PlayerData';
const BASE_URL = `https://apis.roblox.com/datastores/v1/universes/${UNIVERSE_ID}/standard-datastores/datastore/entries/entry`;

// ==========================================
// Konversi Rupiah → Coins
// Ubah sesuai keinginan kamu!
// ==========================================
const COIN_PACKAGES = [
  { minRp: 100000, coins: 5000,  label: '5.000 Coins' },
  { minRp: 50000,  coins: 2000,  label: '2.000 Coins' },
  { minRp: 20000,  coins: 750,   label: '750 Coins'   },
  { minRp: 10000,  coins: 300,   label: '300 Coins'   },
  { minRp: 1000,   coins: 100,   label: '100 Coins'   },
];

function getCoinsFromRp(amount) {
  for (const pkg of COIN_PACKAGES) {
    if (amount >= pkg.minRp) return pkg;
  }
  return null;
}

// ==========================================
// Helper: Get & Set DataStore
// ==========================================
async function getPlayerData(robloxUserId) {
  try {
    const res = await axios.get(BASE_URL, {
      params: { datastoreName: DATASTORE_NAME, entryKey: `player_${robloxUserId}` },
      headers: { 'x-api-key': ROBLOX_API_KEY }
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }
}

async function setPlayerData(robloxUserId, data) {
  await axios.post(BASE_URL, JSON.stringify(data), {
    params: { datastoreName: DATASTORE_NAME, entryKey: `player_${robloxUserId}` },
    headers: { 'x-api-key': ROBLOX_API_KEY, 'content-type': 'application/json' }
  });
}

// ==========================================
// Parse pesan donasi Sociabuzz
// Format pesan donor: "RobloxID:12345 Discord:username"
// ==========================================
function parseDonasiMessage(message) {
  if (!message) return null;
  const robloxMatch  = message.match(/robloxid[:\s]+(\d+)/i);
  const discordMatch = message.match(/discord[:\s]+([^\s]+)/i);
  return {
    robloxId:        robloxMatch  ? robloxMatch[1]  : null,
    discordUsername: discordMatch ? discordMatch[1] : null
  };
}

// ==========================================
// Sociabuzz Webhook
// ==========================================
app.post('/webhook/sociabuzz', async (req, res) => {
  try {
    // Verifikasi signature (jika Sociabuzz mengirimkan)
    const signature = req.headers['x-sociabuzz-signature'];
    if (process.env.SOCIABUZZ_SECRET && signature) {
      const expected = crypto
        .createHmac('sha256', process.env.SOCIABUZZ_SECRET)
        .update(JSON.stringify(req.body))
        .digest('hex');
      if (signature !== expected) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    const payload   = req.body;
    const amount    = payload.amount || payload.price || 0;
    const message   = payload.message || payload.support_message || '';
    const donorName = payload.from || payload.supporter_name || 'Anonymous';
    const trxId     = payload.transaction_id || payload.id || Date.now().toString();

    console.log(`📩 Donasi masuk: Rp${amount} dari ${donorName} | Pesan: ${message}`);

    const parsed     = parseDonasiMessage(message);
    const logChannel = client.channels.cache.get(process.env.LOG_CHANNEL_ID);

    // Tidak ada Roblox ID
    if (!parsed?.robloxId) {
      if (logChannel) {
        await logChannel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFF9900)
            .setTitle('⚠️ Donasi Masuk - ID Tidak Ditemukan')
            .addFields(
              { name: 'Dari',    value: donorName, inline: true },
              { name: 'Nominal', value: `Rp ${amount.toLocaleString('id-ID')}`, inline: true },
              { name: 'Pesan',   value: message || '(kosong)' },
              { name: '📌 Info', value: 'Format pesan harus:\n`RobloxID:123456 Discord:username`' }
            ).setTimestamp()
          ]
        });
      }
      return res.status(200).json({ status: 'ok', note: 'no roblox id' });
    }

    // Nominal terlalu kecil
    const pkg = getCoinsFromRp(amount);
    if (!pkg) {
      if (logChannel) {
        await logChannel.send({
          embeds: [new EmbedBuilder()
            .setColor(0xFF0000)
            .setTitle('❌ Nominal Terlalu Kecil')
            .addFields(
              { name: 'Dari',      value: donorName, inline: true },
              { name: 'Nominal',   value: `Rp ${amount.toLocaleString('id-ID')}`, inline: true },
              { name: 'Roblox ID', value: parsed.robloxId, inline: true },
              { name: 'Minimum',   value: 'Rp 5.000' }
            ).setTimestamp()
          ]
        });
      }
      return res.status(200).json({ status: 'ok', note: 'amount too small' });
    }

    // Update DataStore
    let data = await getPlayerData(parsed.robloxId);
    if (!data) data = { Coins: 0, Stats: {} };
    const coinsBefore = data.Coins || 0;
    data.Coins = coinsBefore + pkg.coins;
    data.LastDonation = { amount, trxId, timestamp: Date.now() };
    await setPlayerData(parsed.robloxId, data);

    console.log(`✅ +${pkg.coins} coins → Roblox ID ${parsed.robloxId}`);

    if (logChannel) {
      await logChannel.send({
        embeds: [new EmbedBuilder()
          .setColor(0x00FF88)
          .setTitle('💰 Donasi Berhasil!')
          .addFields(
            { name: 'Dari',         value: donorName, inline: true },
            { name: 'Nominal',      value: `Rp ${amount.toLocaleString('id-ID')}`, inline: true },
            { name: 'Roblox ID',    value: `\`${parsed.robloxId}\``, inline: true },
            { name: 'Discord',      value: parsed.discordUsername || '-', inline: true },
            { name: 'Coins Didapat',value: `+${pkg.coins.toLocaleString()} (${pkg.label})`, inline: true },
            { name: 'Total Coins',  value: `${data.Coins.toLocaleString()}`, inline: true },
            { name: 'Pesan',        value: message || '-' }
          )
          .setFooter({ text: `TRX: ${trxId}` })
          .setTimestamp()
        ]
      });
    }

    return res.status(200).json({ status: 'ok', coins_added: pkg.coins });

  } catch (err) {
    console.error('❌ Webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('🤖 Bot is running!'));

// ==========================================
// Slash Commands
// ==========================================
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('addcoins')
      .setDescription('Tambah coins ke player (manual admin)')
      .addStringOption(o => o.setName('roblox_id').setDescription('Roblox User ID').setRequired(true))
      .addIntegerOption(o => o.setName('jumlah').setDescription('Jumlah coins').setRequired(true)),

    new SlashCommandBuilder()
      .setName('setstats')
      .setDescription('Set stats player Roblox')
      .addStringOption(o => o.setName('roblox_id').setDescription('Roblox User ID').setRequired(true))
      .addStringOption(o => o.setName('stat').setDescription('Nama stat (Level, Exp, dll)').setRequired(true))
      .addIntegerOption(o => o.setName('nilai').setDescription('Nilai stat').setRequired(true)),

    new SlashCommandBuilder()
      .setName('cekdata')
      .setDescription('Cek data player Roblox')
      .addStringOption(o => o.setName('roblox_id').setDescription('Roblox User ID').setRequired(true)),

    new SlashCommandBuilder()
      .setName('paket')
      .setDescription('Lihat daftar paket coins donasi'),

  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash commands terdaftar!');
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // /paket bisa dilihat semua orang
  if (interaction.commandName === 'paket') {
    const list = COIN_PACKAGES
      .map(p => `💵 **Rp ${p.minRp.toLocaleString('id-ID')}**+ → 🪙 **${p.coins.toLocaleString()} Coins**`)
      .join('\n');
    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎁 Paket Coins Donasi')
        .setDescription(list)
        .addFields({
          name: '📝 Cara Beli',
          value: 'Donasi via Sociabuzz dan isi pesan dengan format:\n```RobloxID:123456 Discord:username```'
        })
      ]
    });
  }

  // Command lain: cek role admin
  const adminRoleId = process.env.ADMIN_ROLE_ID;
  if (adminRoleId && !interaction.member.roles.cache.has(adminRoleId)) {
    return interaction.reply({ content: '❌ Kamu tidak punya izin!', ephemeral: true });
  }

  await interaction.deferReply();
  const robloxId = interaction.options.getString('roblox_id');

  try {
    if (interaction.commandName === 'addcoins') {
      const jumlah = interaction.options.getInteger('jumlah');
      let data = await getPlayerData(robloxId);
      if (!data) data = { Coins: 0, Stats: {} };
      const before = data.Coins || 0;
      data.Coins = before + jumlah;
      await setPlayerData(robloxId, data);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x00FF88).setTitle('✅ Coins Ditambahkan!')
          .addFields(
            { name: 'Roblox ID', value: `\`${robloxId}\``, inline: true },
            { name: 'Sebelum',   value: `${before}`, inline: true },
            { name: 'Sesudah',   value: `${data.Coins}`, inline: true }
          ).setTimestamp()]
      });
    }

    if (interaction.commandName === 'setstats') {
      const stat  = interaction.options.getString('stat');
      const nilai = interaction.options.getInteger('nilai');
      let data = await getPlayerData(robloxId);
      if (!data) data = { Coins: 0, Stats: {} };
      if (!data.Stats) data.Stats = {};
      const lama = data.Stats[stat] ?? 'belum ada';
      data.Stats[stat] = nilai;
      await setPlayerData(robloxId, data);
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x5865F2).setTitle('✅ Stats Diupdate!')
          .addFields(
            { name: 'Roblox ID',  value: `\`${robloxId}\``, inline: true },
            { name: 'Stat',       value: stat, inline: true },
            { name: 'Nilai Lama', value: `${lama}`, inline: true },
            { name: 'Nilai Baru', value: `${nilai}`, inline: true }
          ).setTimestamp()]
      });
    }

    if (interaction.commandName === 'cekdata') {
      const data = await getPlayerData(robloxId);
      if (!data) return interaction.editReply({ content: `❌ Data Roblox ID \`${robloxId}\` tidak ditemukan.` });
      const statsText = data.Stats && Object.keys(data.Stats).length > 0
        ? Object.entries(data.Stats).map(([k, v]) => `• ${k}: ${v}`).join('\n')
        : 'Belum ada stats';
      await interaction.editReply({
        embeds: [new EmbedBuilder().setColor(0x00BFFF).setTitle(`📊 Data Player ${robloxId}`)
          .addFields(
            { name: '🪙 Coins', value: `${(data.Coins || 0).toLocaleString()}`, inline: true },
            { name: '📈 Stats', value: statsText }
          ).setTimestamp()]
      });
    }

  } catch (err) {
    console.error(err);
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle('❌ Error!')
        .setDescription(`\`\`\`${err.message}\`\`\``)]
    });
  }
});

// ==========================================
// Start
// ==========================================
client.once('ready', async () => {
  console.log(`🤖 Bot online: ${client.user.tag}`);
  await registerCommands();
});

client.login(process.env.DISCORD_TOKEN);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Webhook aktif di port ${PORT}`));