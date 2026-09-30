const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { guildData, save } = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard');
const PLUGINS = ['moderation', 'welcomer', 'reactionRoles', 'customCommands', 'logging', 'tickets'];
const SESSION_COOKIE = 'hectee_dashboard';
const sessions = new Map();
const oauthStates = new Map();

function json(response, status, value, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(value));
}

function redirect(response, location, headers = {}) {
  response.writeHead(302, { Location: location, ...headers });
  response.end();
}

function cookieMap(request) {
  return Object.fromEntries((request.headers.cookie || '').split(';').map((part) => {
    const separator = part.indexOf('=');
    return separator < 0 ? [] : [part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())];
  }).filter((part) => part.length === 2));
}

function sign(value) {
  return crypto.createHmac('sha256', process.env.DISCORD_TOKEN).update(value).digest('base64url');
}

function getSession(request) {
  const cookie = cookieMap(request)[SESSION_COOKIE];
  if (!cookie) return null;
  const [id, signature] = cookie.split('.');
  if (!id || !signature) return null;
  const expected = sign(id);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  const session = sessions.get(id);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  return session;
}

function sessionCookie(id) {
  const secure = process.env.DASHBOARD_REDIRECT_URI?.startsWith('https://');
  return `${SESSION_COOKIE}=${encodeURIComponent(`${id}.${sign(id)}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure ? '; Secure' : ''}`;
}

function canManageGuild(guild) {
  try {
    const permissions = BigInt(guild.permissions);
    return (permissions & PermissionFlagsBits.Administrator) !== 0n
      || (permissions & PermissionFlagsBits.ManageGuild) !== 0n;
  } catch {
    return false;
  }
}

function allowedGuild(session, guildId) {
  return session.guilds.find((guild) => guild.id === guildId && (guild.owner || canManageGuild(guild)));
}

function manageableGuilds(session, client) {
  return session.guilds.filter((guild) => guild.owner || canManageGuild(guild)).map((guild) => ({
    id: guild.id,
    name: guild.name,
    icon: guild.icon
      ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=128`
      : null,
    botInstalled: client.guilds.cache.has(guild.id),
  }));
}

function readBody(request, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('Request body is too large.'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    request.on('error', reject);
  });
}

function cleanText(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function normalizeWelcomeMessage(value) {
  if (!value || typeof value !== 'object') return {};
  const validUrl = (input) => {
    if (!input) return '';
    try {
      const url = new URL(input);
      return ['https:', 'http:'].includes(url.protocol) ? url.toString() : '';
    } catch {
      return '';
    }
  };
  const fields = Array.isArray(value.fields) ? value.fields.slice(0, 25).map((field) => ({
    name: cleanText(field.name, 256),
    value: cleanText(field.value, 1024),
    inline: Boolean(field.inline),
  })).filter((field) => field.name && field.value) : [];
  const components = Array.isArray(value.components) ? value.components.slice(0, 5).map((item) => {
    if (item.type === 'button') return { type: 'button', label: cleanText(item.label, 80), url: validUrl(item.url) };
    if (item.type === 'select') return {
      type: 'select',
      label: cleanText(item.label, 80),
      options: Array.isArray(item.options) ? item.options.slice(0, 25).map((option) => cleanText(option, 100)).filter(Boolean) : [],
    };
    return null;
  }).filter((item) => item && item.label) : [];

  const message = {
    content: cleanText(value.content, 2000),
    color: /^#[0-9a-f]{6}$/i.test(value.color || '') ? value.color : '#5865f2',
    author: cleanText(value.author, 256),
    authorIcon: validUrl(value.authorIcon),
    title: cleanText(value.title, 256),
    description: cleanText(value.description, 4000),
    thumbnail: validUrl(value.thumbnail),
    image: validUrl(value.image),
    footer: cleanText(value.footer, 2048),
    fields,
    components,
  };
  const embedCharacterCount = [message.author, message.title, message.description, message.footer,
    ...fields.flatMap((field) => [field.name, field.value])].reduce((total, text) => total + text.length, 0);
  if (embedCharacterCount > 6000) throw new Error('Discord embeds can contain at most 6,000 characters in total.');
  return message;
}

function staticFile(response, filename, contentType) {
  const filePath = path.join(PUBLIC_DIR, filename);
  try {
    const content = fs.readFileSync(filePath);
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    response.end(content);
  } catch {
    json(response, 404, { error: 'Dashboard asset not found.' });
  }
}

async function startOAuth(request, response) {
  const clientId = process.env.OAUTH_CLIENT_ID || process.env.CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.DASHBOARD_REDIRECT_URI || 'http://localhost:3000/auth/callback';
  if (!clientId || !clientSecret) {
    json(response, 503, { error: 'Set OAUTH_CLIENT_SECRET and CLIENT_ID to enable dashboard sign-in.' });
    return;
  }
  const state = crypto.randomBytes(24).toString('hex');
  oauthStates.set(state, Date.now() + 10 * 60_000);
  const authorize = new URL('https://discord.com/oauth2/authorize');
  authorize.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'identify guilds',
    state,
  }).toString();
  redirect(response, authorize.toString());
}

async function completeOAuth(request, response, requestUrl, client) {
  const state = requestUrl.searchParams.get('state');
  const expiry = state && oauthStates.get(state);
  if (!expiry || expiry < Date.now()) {
    if (state) oauthStates.delete(state);
    redirect(response, '/?auth=expired');
    return;
  }
  oauthStates.delete(state);

  const clientId = process.env.OAUTH_CLIENT_ID || process.env.CLIENT_ID;
  const redirectUri = process.env.DASHBOARD_REDIRECT_URI || 'http://localhost:3000/auth/callback';
  const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: process.env.OAUTH_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: requestUrl.searchParams.get('code') || '',
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) throw new Error('Discord sign-in could not be completed.');
  const token = await tokenResponse.json();
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const [userResponse, guildResponse] = await Promise.all([
    fetch('https://discord.com/api/users/@me', { headers }),
    fetch('https://discord.com/api/users/@me/guilds', { headers }),
  ]);
  if (!userResponse.ok || !guildResponse.ok) throw new Error('Discord did not return your account and server list.');
  const [user, guilds] = await Promise.all([userResponse.json(), guildResponse.json()]);
  const sessionId = crypto.randomBytes(32).toString('hex');
  sessions.set(sessionId, {
    user: { id: user.id, username: user.global_name || user.username, avatar: user.avatar },
    guilds,
    expiresAt: Date.now() + 8 * 60 * 60_000,
  });
  const cookie = sessionCookie(sessionId);
  redirect(response, '/', { 'Set-Cookie': cookie });
  console.log(`Dashboard sign-in completed for ${user.username}; bot serves ${client.guilds.cache.size} guild(s).`);
}

function guildDetails(client, guildId, session) {
  if (!allowedGuild(session, guildId)) return { status: 403, body: { error: 'You need Manage Server permission for this server.' } };
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { status: 409, body: { error: 'The bot is not installed in this server yet.', botInstalled: false } };
  const data = guildData(guildId);
  const channels = guild.channels.cache.filter((channel) => channel.isTextBased() && !channel.isThread()).map((channel) => ({
    id: channel.id,
    name: channel.name,
    type: channel.type,
  }));
  const roles = guild.roles.cache.filter((role) => role.id !== guild.id && !role.managed).map((role) => ({
    id: role.id,
    name: role.name,
    color: role.hexColor,
    position: role.position,
  })).sort((first, second) => second.position - first.position);
  return {
    status: 200,
    body: {
      server: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128 }) },
      plugins: data.plugins,
      settings: data.settings,
      welcomeMessage: data.settings.welcome_message || {},
      tags: data.tags,
      channels,
      roles,
    },
  };
}

function validateSettings(input, guild) {
  const settings = {};
  const channelIds = new Set(guild.channels.cache.filter((channel) => channel.isTextBased() && !channel.isThread()).map((channel) => channel.id));
  const roleIds = new Set(guild.roles.cache.filter((role) => !role.managed && role.id !== guild.id).keys());
  const channelKey = (key) => {
    if (input[key] === null || input[key] === '') settings[key] = null;
    else if (channelIds.has(input[key])) settings[key] = input[key];
    else throw new Error(`Choose a valid text channel for ${key}.`);
  };

  for (const key of ['logs', 'welcome', 'rules']) if (Object.hasOwn(input, key)) channelKey(key);
  if (Object.hasOwn(input, 'member_role')) {
    if (input.member_role === null || input.member_role === '') settings.member_role = null;
    else if (roleIds.has(input.member_role)) settings.member_role = input.member_role;
    else throw new Error('Choose a valid member role.');
  }
  if (Object.hasOwn(input, 'staff_roles')) {
    if (!Array.isArray(input.staff_roles) || input.staff_roles.some((id) => !roleIds.has(id))) throw new Error('Choose valid staff roles.');
    settings.staff_roles = [...new Set(input.staff_roles)];
  }
  if (Object.hasOwn(input, 'join_mode')) {
    if (!['verify', 'instant'].includes(input.join_mode)) throw new Error('Choose a valid join mode.');
    settings.join_mode = input.join_mode;
  }
  if (Object.hasOwn(input, 'welcome_text')) settings.welcome_text = cleanText(input.welcome_text, 1000);
  for (const key of ['blocked_words', 'blocked_domains']) {
    if (Object.hasOwn(input, key)) {
      if (!Array.isArray(input[key])) throw new Error(`Choose a list for ${key}.`);
      settings[key] = [...new Set(input[key].map((item) => cleanText(item, 100).trim().toLowerCase()).filter(Boolean))].slice(0, 100);
    }
  }
  if (Object.hasOwn(input, 'mention_limit')) {
    const limit = Number(input.mention_limit);
    if (!Number.isInteger(limit) || limit < 2 || limit > 50) throw new Error('Mention limit must be between 2 and 50.');
    settings.mention_limit = limit;
  }
  if (Object.hasOwn(input, 'log_channels')) {
    if (!input.log_channels || typeof input.log_channels !== 'object' || Array.isArray(input.log_channels)) throw new Error('Log channel selections are invalid.');
    const selected = {};
    const allowedKeys = new Set(['message_delete', 'message_edit', 'member_join', 'member_leave', 'nickname_change', 'moderation', 'tickets']);
    for (const [key, id] of Object.entries(input.log_channels)) {
      if (!allowedKeys.has(key)) throw new Error('Unknown log event type.');
      if (id === null || id === '') selected[key] = null;
      else if (channelIds.has(id)) selected[key] = id;
      else throw new Error(`Choose a valid channel for ${key}.`);
    }
    settings.log_channels = selected;
  }
  if (Object.hasOwn(input, 'welcome_message')) settings.welcome_message = normalizeWelcomeMessage(input.welcome_message);
  return settings;
}

async function handleApi(request, response, requestUrl, client) {
  const session = getSession(request);
  if (requestUrl.pathname === '/api/session' && request.method === 'GET') {
    json(response, 200, {
      loggedIn: Boolean(session),
      user: session?.user || null,
      setupRequired: !process.env.OAUTH_CLIENT_SECRET,
    });
    return;
  }
  if (!session) {
    json(response, 401, { error: 'Sign in with Discord to continue.' });
    return;
  }
  if (request.method !== 'GET') {
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) {
      json(response, 403, { error: 'Cross-origin dashboard requests are not allowed.' });
      return;
    }
  }
  if (requestUrl.pathname === '/api/guilds' && request.method === 'GET') {
    json(response, 200, { guilds: manageableGuilds(session, client) });
    return;
  }
  const tagsMatch = requestUrl.pathname.match(/^\/api\/guilds\/(\d+)\/tags(?:\/([^/]+))?$/);
  if (tagsMatch) {
    const [, tagGuildId, encodedName] = tagsMatch;
    if (!allowedGuild(session, tagGuildId)) {
      json(response, 403, { error: 'You need Manage Server permission for this server.' });
      return;
    }
    if (!client.guilds.cache.has(tagGuildId)) {
      json(response, 409, { error: 'The bot is not installed in this server yet.' });
      return;
    }
    const data = guildData(tagGuildId);
    if (request.method === 'PUT' && !encodedName) {
      try {
        const body = await readBody(request);
        const name = cleanText(body.name, 32).trim().toLowerCase();
        const text = cleanText(body.response, 1800).trim();
        if (!/^[a-z0-9_-]{1,32}$/.test(name) || ['__proto__', 'prototype', 'constructor'].includes(name) || !text) {
          throw new Error('Enter a valid tag name and a response.');
        }
        data.tags[name] = text;
        save();
        json(response, 200, { tags: data.tags });
      } catch (error) {
        json(response, 400, { error: error.message || 'Could not save the tag.' });
      }
      return;
    }
    if (request.method === 'DELETE' && encodedName) {
      delete data.tags[decodeURIComponent(encodedName)];
      save();
      json(response, 200, { tags: data.tags });
      return;
    }
    json(response, 405, { error: 'Method not allowed.' });
    return;
  }
  const guildMatch = requestUrl.pathname.match(/^\/api\/guilds\/(\d+)(?:\/(invite))?$/);
  if (!guildMatch) {
    json(response, 404, { error: 'Dashboard API route not found.' });
    return;
  }
  const [, guildId, invite] = guildMatch;
  if (!allowedGuild(session, guildId)) {
    json(response, 403, { error: 'You need Manage Server permission for this server.' });
    return;
  }
  if (invite && request.method === 'GET') {
    const clientId = process.env.OAUTH_CLIENT_ID || process.env.CLIENT_ID;
    const permissions = [
      PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.BanMembers, PermissionFlagsBits.KickMembers, PermissionFlagsBits.ModerateMembers,
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.ReadMessageHistory,
    ].reduce((value, permission) => value | permission, 0n);
    const inviteUrl = new URL('https://discord.com/oauth2/authorize');
    inviteUrl.search = new URLSearchParams({
      client_id: clientId,
      permissions: permissions.toString(),
      scope: 'bot applications.commands',
      guild_id: guildId,
      disable_guild_select: 'true',
    }).toString();
    json(response, 200, { url: inviteUrl.toString() });
    return;
  }

  const detail = guildDetails(client, guildId, session);
  if (detail.status !== 200) {
    json(response, detail.status, detail.body);
    return;
  }
  if (request.method === 'GET') {
    json(response, 200, detail.body);
    return;
  }
  if (request.method !== 'PUT') {
    json(response, 405, { error: 'Method not allowed.' });
    return;
  }

  try {
    const body = await readBody(request);
    const data = guildData(guildId);
    if (body.plugins && typeof body.plugins === 'object') {
      for (const [name, enabled] of Object.entries(body.plugins)) {
        if (!PLUGINS.includes(name) || typeof enabled !== 'boolean') throw new Error('Plugin settings are invalid.');
        data.plugins[name] = enabled;
      }
    }
    if (body.settings) Object.assign(data.settings, validateSettings(body.settings, client.guilds.cache.get(guildId)));
    save();
    json(response, 200, { saved: true, plugins: data.plugins, settings: data.settings, welcomeMessage: data.settings.welcome_message || {} });
  } catch (error) {
    json(response, 400, { error: error.message || 'Could not save these settings.' });
  }
}

function startDashboard(client) {
  if (!process.env.OAUTH_CLIENT_SECRET) {
    console.warn('Dashboard disabled: set OAUTH_CLIENT_SECRET to enable Discord sign-in.');
    return null;
  }
  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    try {
      if (requestUrl.pathname === '/auth/login' && request.method === 'GET') return await startOAuth(request, response);
      if (requestUrl.pathname === '/auth/callback' && request.method === 'GET') return await completeOAuth(request, response, requestUrl, client);
      if (requestUrl.pathname === '/auth/logout' && request.method === 'POST') {
        const session = getSession(request);
        const cookie = cookieMap(request)[SESSION_COOKIE];
        const id = cookie?.split('.')[0];
        if (id) sessions.delete(id);
        return json(response, 200, { loggedOut: true }, { 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
      if (requestUrl.pathname.startsWith('/api/')) return await handleApi(request, response, requestUrl, client);
      if (requestUrl.pathname === '/') return staticFile(response, 'index.html', 'text/html; charset=utf-8');
      if (requestUrl.pathname === '/styles.css') return staticFile(response, 'styles.css', 'text/css; charset=utf-8');
      if (requestUrl.pathname === '/app.js') return staticFile(response, 'app.js', 'text/javascript; charset=utf-8');
      json(response, 404, { error: 'Not found.' });
    } catch (error) {
      console.error('Dashboard request failed:', error);
      if (!response.headersSent) json(response, 500, { error: error.message || 'Dashboard request failed.' });
      else response.end();
    }
  });
  const port = Number(process.env.DASHBOARD_PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Dashboard listening on port ${port}.`));
  return server;
}

module.exports = startDashboard;
