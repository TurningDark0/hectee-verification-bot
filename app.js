const PLUGINS = [
  { id: 'moderation', title: 'Moderation', description: 'Keep conversations thoughtful with practical guardrails.', icon: 'shield-check', tone: 'violet', tip: 'Use additional blocked words and domains to tailor Auto-Mod to your community. Message Content Intent is required.' },
  { id: 'welcomer', title: 'Welcomer', description: 'Give every new member a warm, on-brand first hello.', icon: 'hand-heart', tone: 'mint', tip: 'Choose verification mode to keep your current gate, or instant mode to give the Member role at join.' },
  { id: 'reactionRoles', title: 'Reaction Roles', description: 'Let members choose the roles and pings they actually want.', icon: 'tags', tone: 'coral', tip: 'Use /role-panel create and /role-panel add in Discord to publish a working role-button panel.' },
  { id: 'customCommands', title: 'Custom Commands', description: 'Keep helpful answers one tap away with reusable tags.', icon: 'message-square-code', tone: 'amber', tip: 'Create a tag here. Members can call it with !name in any channel where the bot can read and reply.' },
  { id: 'logging', title: 'Logging', description: 'Know what changed without watching every channel.', icon: 'scroll-text', tone: 'blue', tip: 'Create a private #mod-logs channel in Discord with /setup-modules, then choose where each event should appear.' },
  { id: 'tickets', title: 'Tickets', description: 'Give support requests a private place to land.', icon: 'life-buoy', tone: 'lime', tip: 'Add support staff roles here, then use /ticket-panel in Discord to post the Open Ticket button.' },
];
const LOG_TYPES = [
  ['message_delete', 'Deleted messages'], ['message_edit', 'Edited messages'], ['member_join', 'Member joins'],
  ['member_leave', 'Member leaves'], ['nickname_change', 'Nickname changes'], ['moderation', 'Moderation actions'],
  ['tickets', 'Ticket activity'],
];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const safeImage = (value) => /^https?:\/\//i.test(value || '') ? value : '';
const state = {
  user: null,
  guilds: [],
  guild: null,
  guildData: null,
  currentView: 'overview',
  currentPlugin: null,
  fields: [],
  components: [],
  toastTimer: null,
};

function icon(name) {
  return `<i data-lucide="${escapeHtml(name)}"></i>`;
}
function drawIcons() { window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } }); }
function setSaving(status) {
  const element = $('#save-indicator');
  if (!element) return;
  element.innerHTML = `<span class="save-dot"></span> ${status === 'saving' ? 'Saving changes…' : status === 'error' ? 'Save failed' : 'All changes saved'}`;
  element.classList.toggle('save-error', status === 'error');
}
function toast(message, isError = false) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.toggle('error', isError);
  element.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => element.classList.remove('show'), 2800);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function displayAuthError(message) { $('#auth-error').textContent = message || ''; }
function userAvatarUrl(user) {
  return user?.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : '';
}
function setAvatar(element, user, fallback) {
  const url = userAvatarUrl(user);
  if (url) {
    element.style.backgroundImage = `url("${url}")`;
    element.style.backgroundSize = 'cover';
    element.textContent = '';
  } else element.textContent = fallback;
}
function pluginById(id) { return PLUGINS.find((plugin) => plugin.id === id); }
function activeCount() { return Object.values(state.guildData?.plugins || {}).filter(Boolean).length; }
function saveViewName(view) {
  const names = { overview: 'Overview', plugins: 'Plugins', composer: 'Message studio', settings: 'Plugin settings', servers: 'Servers' };
  return names[view] || 'Overview';
}
function setView(view) {
  state.currentView = view;
  for (const section of $$('.view')) section.classList.add('hidden');
  const viewElement = $(`#${view}-view`);
  if (viewElement) viewElement.classList.remove('hidden');
  $('#breadcrumb-page').textContent = view === 'settings' && state.currentPlugin ? `${state.currentPlugin.title} settings` : saveViewName(view);
  $$('.primary-nav .nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.title = `${saveViewName(view)} · Hectee Control`;
  closeMobileNav();
  drawIcons();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function updateServerChrome() {
  const guild = state.guildData?.server;
  if (!guild) return;
  $('#sidebar-server-name').textContent = guild.name;
  $('#sidebar-server-icon').textContent = guild.name.slice(0, 1).toUpperCase();
  if (guild.icon) {
    $('#sidebar-server-icon').style.backgroundImage = `url("${guild.icon}")`;
    $('#sidebar-server-icon').style.backgroundSize = 'cover';
    $('#sidebar-server-icon').textContent = '';
  } else {
    $('#sidebar-server-icon').style.backgroundImage = '';
  }
  $('#breadcrumb-server').textContent = guild.name;
  $('#overview-title').innerHTML = `${escapeHtml(guild.name)}, <em>in sync.</em>`;
}
function pluginCard(plugin, full = false) {
  const enabled = Boolean(state.guildData?.plugins?.[plugin.id]);
  return `<article class="plugin-card" data-plugin-card="${plugin.id}">
    <div class="plugin-card-top"><span class="plugin-icon ${plugin.tone}">${icon(plugin.icon)}</span><label class="switch"><input type="checkbox" data-plugin-toggle="${plugin.id}" ${enabled ? 'checked' : ''} aria-label="Toggle ${escapeHtml(plugin.title)}"><span class="switch-track"></span></label></div>
    <h3>${escapeHtml(plugin.title)}</h3><p>${escapeHtml(plugin.description)}</p>
    <div class="plugin-card-bottom"><span class="plugin-status ${enabled ? '' : 'disabled'}"><span class="status-pulse"></span>${enabled ? 'Enabled' : 'Disabled'}</span><button class="card-settings" data-plugin-settings="${plugin.id}" aria-label="Configure ${escapeHtml(plugin.title)}" title="Configure plugin">${icon('settings-2')}</button></div>
  </article>`;
}
function renderPlugins() {
  $('#overview-plugin-grid').innerHTML = PLUGINS.map((plugin) => pluginCard(plugin)).join('');
  $('#all-plugin-grid').innerHTML = PLUGINS.map((plugin) => pluginCard(plugin, true)).join('');
  $('#active-count').innerHTML = `${activeCount()} <i>of 6</i>`;
  $('#plugin-active-label').textContent = `${activeCount()} active`;
  $('#plugin-nav').innerHTML = PLUGINS.filter((plugin) => state.guildData.plugins[plugin.id]).map((plugin) => `<button class="nav-item" data-plugin-settings="${plugin.id}">${icon(plugin.icon)}<span>${escapeHtml(plugin.title)}</span><span class="nav-state"></span></button>`).join('');
  drawIcons();
}
function renderServers() {
  $('#server-total').textContent = String(state.guilds.length).padStart(2, '0');
  const grid = $('#server-grid');
  grid.innerHTML = state.guilds.map((guild) => `<article class="server-card">${guild.icon ? `<img class="server-avatar" src="${guild.icon}" alt="">` : `<span class="server-avatar">${escapeHtml(guild.name.slice(0, 1).toUpperCase())}</span>`}<div class="server-card-copy"><strong>${escapeHtml(guild.name)}</strong><span><span class="${guild.botInstalled ? 'status-pulse' : 'server-missing-dot'}"></span>${guild.botInstalled ? 'Bot connected' : 'Bot not installed'}</span></div>${guild.botInstalled ? `<button class="button button-primary" data-manage-server="${guild.id}">Manage</button>` : `<button class="button button-subtle" data-invite-server="${guild.id}">Setup</button>`}</article>`).join('');
  $('#server-empty').classList.toggle('hidden', state.guilds.length > 0);
  drawIcons();
}
async function loadGuild(guildId) {
  const card = state.guilds.find((server) => server.id === guildId);
  if (!card?.botInstalled) return;
  try {
    state.guildData = await api(`/api/guilds/${guildId}`);
    state.guild = card;
    localStorage.setItem('hectee-server', guildId);
    updateServerChrome();
    renderPlugins();
    $('#welcome-channel').innerHTML = channelOptions(state.guildData.channels, state.guildData.settings.welcome);
    setView('overview');
  } catch (error) { toast(error.message, true); }
}
function channelOptions(channels, selected, includeEmpty = true) {
  const options = includeEmpty ? '<option value="">Choose a channel</option>' : '';
  return options + channels.map((channel) => `<option value="${channel.id}" ${channel.id === selected ? 'selected' : ''}># ${escapeHtml(channel.name)}</option>`).join('');
}
function roleOptions(roles, selected) {
  return roles.map((role) => `<option value="${role.id}" ${role.id === selected ? 'selected' : ''}>${escapeHtml(role.name)}</option>`).join('');
}
async function saveChanges(change) {
  if (!state.guild) return;
  setSaving('saving');
  try {
    const result = await api(`/api/guilds/${state.guild.id}`, { method: 'PUT', body: JSON.stringify(change) });
    state.guildData.plugins = result.plugins;
    state.guildData.settings = result.settings;
    state.guildData.welcomeMessage = result.welcomeMessage;
    setSaving('saved');
    return result;
  } catch (error) {
    setSaving('error');
    toast(error.message, true);
    throw error;
  }
}
function showPluginSettings(id) {
  const plugin = pluginById(id);
  if (!plugin || !state.guildData) return;
  state.currentPlugin = plugin;
  $('#settings-icon').className = `plugin-hero-icon ${plugin.tone}`;
  $('#settings-icon').innerHTML = icon(plugin.icon);
  $('#settings-eyebrow').textContent = 'PLUGIN SETTINGS';
  $('#settings-title').textContent = plugin.title;
  $('#settings-description').textContent = plugin.description;
  $('#settings-tip').textContent = plugin.tip;
  $('#settings-toggle').checked = Boolean(state.guildData.plugins[id]);
  $('#intent-warning').classList.toggle('hidden', id !== 'moderation' && id !== 'customCommands');
  $('#plugin-settings-form').innerHTML = settingsForm(plugin);
  setView('settings');
  drawIcons();
}
function settingsForm(plugin) {
  const settings = state.guildData.settings;
  const channels = state.guildData.channels;
  const roles = state.guildData.roles;
  if (plugin.id === 'moderation') return `
    <section class="form-panel"><h2>Auto-Mod filters</h2><p>Choose what the bot should catch and remove from new messages.</p>
      <label class="field-label" for="blocked-words">BLOCKED WORDS</label><textarea class="input-control" id="blocked-words" placeholder="Add words, separated by commas">${escapeHtml((settings.blocked_words || []).join(', '))}</textarea>
      <label class="field-label" for="blocked-domains">BLOCKED LINK DOMAINS</label><textarea class="input-control" id="blocked-domains" placeholder="spam.example, short.link">${escapeHtml((settings.blocked_domains || []).join(', '))}</textarea>
      <label class="field-label" for="mention-limit">MASS MENTION LIMIT</label><div class="input-with-suffix"><input class="input-control" id="mention-limit" type="number" min="2" max="50" value="${Number(settings.mention_limit) || 5}"><span class="input-suffix">mentions</span></div>
      <div class="inline-save"><button class="button button-primary" data-save-settings="moderation">Save filters</button></div></section>
    <section class="form-panel"><h2>Commands</h2><p>Moderators with the matching Discord permission can use /ban, /kick, /warn, /timeout, and /purge.</p></section>`;
  if (plugin.id === 'welcomer') return `
    <section class="form-panel"><h2>New member welcome</h2><p>Choose what happens as soon as a member arrives.</p>
      <label class="field-label" for="join-mode">JOIN MODE</label><select class="input-control" id="join-mode"><option value="verify" ${settings.join_mode !== 'instant' ? 'selected' : ''}>Verify first · existing flow</option><option value="instant" ${settings.join_mode === 'instant' ? 'selected' : ''}>Instant Member role</option></select><span class="field-hint">Instant role and verification are exclusive. Verify mode is recommended when channels are restricted.</span>
      <label class="field-label" for="member-role">MEMBER ROLE</label><select class="input-control" id="member-role"><option value="">Use the Member role in bot setup</option>${roleOptions(roles, settings.member_role)}</select>
      <label class="field-label" for="welcome-channel-setting">WELCOME CHANNEL</label><select class="input-control" id="welcome-channel-setting">${channelOptions(channels, settings.welcome)}</select>
      <label class="field-label" for="rules-channel">RULES CHANNEL</label><select class="input-control" id="rules-channel">${channelOptions(channels, settings.rules)}</select>
      <label class="field-label" for="welcome-text">WELCOME MESSAGE</label><textarea class="input-control" id="welcome-text" placeholder="Welcome {user} to {server}! {rules}">${escapeHtml(settings.welcome_text || '')}</textarea><span class="field-hint">Available tokens: {user}, {server}, and {rules}.</span>
      <div class="inline-save"><button class="button button-primary" data-save-settings="welcomer">Save welcome settings</button></div></section>`;
  if (plugin.id === 'logging') return `
    <section class="form-panel"><h2>Event destinations</h2><p>Send each kind of activity to a channel that your staff can access.</p>
      ${LOG_TYPES.map(([key, label]) => `<label class="field-label" for="log-${key}">${label.toUpperCase()}</label><select class="input-control" id="log-${key}">${channelOptions(channels, settings.log_channels?.[key] || settings.logs)}</select>`).join('')}
      <div class="inline-save"><button class="button button-primary" data-save-settings="logging">Save destinations</button></div></section>
    <section class="form-panel"><h2>Private log channel</h2><p>In Discord, run /setup-modules after setting your staff roles. This creates #mod-logs and keeps it private.</p><span class="connection-card"><span class="connection-icon">${icon('lock-keyhole')}</span><span><strong>${settings.logs ? 'A log channel is configured' : 'No default channel selected'}</strong><small>Per-event destinations can override it.</small></span></span></section>`;
  if (plugin.id === 'tickets') return `
    <section class="form-panel"><h2>Support team</h2><p>Only these roles can see tickets opened by members.</p>${roles.length ? `<div class="role-picker">${roles.map((role) => `<button class="role-choice ${(settings.staff_roles || []).includes(role.id) ? 'selected' : ''}" data-staff-role="${role.id}" style="--role-color:${/^#[0-9a-f]{6}$/i.test(role.color) && role.color !== '#000000' ? role.color : '#9298a5'}"><i></i>${escapeHtml(role.name)}</button>`).join('')}</div>` : '<p>There are no roles to choose.</p>'}<div class="inline-save"><button class="button button-primary" data-save-settings="tickets">Save staff roles</button></div></section>
    <section class="form-panel"><h2>Ticket panel</h2><p>Run /ticket-panel in a Discord channel to post the Open Ticket button. Members can have one open ticket at a time.</p></section>`;
  if (plugin.id === 'reactionRoles') return `
    <section class="form-panel"><h2>Role buttons</h2><p>Create a button panel in Discord. The bot role must be above every role members can select.</p><ol class="simple-steps"><li>Run <strong>/role-panel create</strong> in the channel where the panel should appear.</li><li>Copy the message ID from the bot's private reply.</li><li>Run <strong>/role-panel add</strong> with that ID, the role, label, and optional emoji.</li></ol><p>Members tap a button to add or remove its role.</p></section>`;
  return `<section class="form-panel"><h2>Saved text tags</h2><p>Create responses members can call with !name. Mentions in saved replies are disabled to prevent accidental pings.</p>
    <label class="field-label" for="tag-name">TAG NAME</label><input class="input-control" id="tag-name" maxlength="32" placeholder="rules">
    <label class="field-label" for="tag-response">RESPONSE</label><textarea class="input-control" id="tag-response" maxlength="1800" placeholder="Be kind, stay on topic, and have fun."></textarea>
    <div class="inline-save"><button class="button button-primary" data-save-tag>Create tag</button></div>
    <div class="tag-list" id="tag-list">${Object.entries(state.guildData.tags || {}).map(([name, response]) => tagRow(name, response)).join('') || '<p>No saved tags yet.</p>'}</div></section>`;
}
function tagRow(name, response) {
  return `<div class="tag-row"><span class="tag-badge">!${escapeHtml(name)}</span><span class="tag-response">${escapeHtml(response)}</span><button class="icon-button tag-delete" data-delete-tag="${escapeHtml(name)}" aria-label="Delete ${escapeHtml(name)}" title="Delete tag">${icon('trash-2')}</button></div>`;
}
function commaList(value) { return value.split(',').map((item) => item.trim()).filter(Boolean); }
async function savePluginSettings(pluginId) {
  const settings = {};
  if (pluginId === 'moderation') {
    settings.blocked_words = commaList($('#blocked-words').value);
    settings.blocked_domains = commaList($('#blocked-domains').value);
    settings.mention_limit = Number($('#mention-limit').value);
  } else if (pluginId === 'welcomer') {
    settings.join_mode = $('#join-mode').value;
    settings.member_role = $('#member-role').value || null;
    settings.welcome = $('#welcome-channel-setting').value || null;
    settings.rules = $('#rules-channel').value || null;
    settings.welcome_text = $('#welcome-text').value;
  } else if (pluginId === 'logging') {
    settings.log_channels = Object.fromEntries(LOG_TYPES.map(([key]) => [key, $(`#log-${key}`).value || null]));
    settings.logs = Object.values(settings.log_channels).find(Boolean) || state.guildData.settings.logs || null;
  } else if (pluginId === 'tickets') {
    settings.staff_roles = $$('.role-choice.selected').map((role) => role.dataset.staffRole);
  }
  await saveChanges({ settings });
  toast(`${pluginById(pluginId).title} settings saved.`);
  if (pluginId === 'tickets') showPluginSettings(pluginId);
}
async function togglePlugin(pluginId, enabled) {
  try {
    await saveChanges({ plugins: { [pluginId]: enabled } });
    renderPlugins();
    if (state.currentView === 'settings' && state.currentPlugin?.id === pluginId) $('#settings-toggle').checked = enabled;
    toast(`${pluginById(pluginId).title} ${enabled ? 'enabled' : 'disabled'}.`);
  } catch { renderPlugins(); }
}

function currentDraft() {
  return {
    content: $('#message-content').value,
    color: $('#embed-color-hex').value,
    author: $('#embed-author').value,
    authorIcon: $('#embed-author-icon').value,
    title: $('#embed-title').value,
    description: $('#embed-description').value,
    thumbnail: $('#embed-thumbnail').value,
    image: $('#embed-image').value,
    footer: $('#embed-footer').value,
    fields: state.fields,
    components: state.components,
  };
}
function fillComposer(draft = {}) {
  const set = (id, value) => { const input = $(`#${id}`); if (input) input.value = value || ''; };
  set('message-content', draft.content);
  set('embed-color-hex', draft.color || '#5865f2');
  set('embed-color', /^#[0-9a-f]{6}$/i.test(draft.color || '') ? draft.color : '#5865f2');
  set('embed-author', draft.author);
  set('embed-author-icon', draft.authorIcon);
  set('embed-title', draft.title);
  set('embed-description', draft.description);
  set('embed-thumbnail', draft.thumbnail);
  set('embed-image', draft.image);
  set('embed-footer', draft.footer);
  $('#welcome-channel').value = state.guildData.settings.welcome || '';
  updatePreviewChannel();
  state.fields = Array.isArray(draft.fields) ? draft.fields.map((field) => ({ name: field.name || '', value: field.value || '', inline: Boolean(field.inline) })) : [];
  state.components = Array.isArray(draft.components) ? draft.components.map((component) => ({ ...component, options: [...(component.options || [])] })) : [];
  renderFieldEditors();
  renderComponentEditors();
  renderPreview();
}
function updatePreviewChannel() {
  const channel = state.guildData?.channels.find((item) => item.id === $('#welcome-channel').value);
  const name = channel?.name || 'welcome';
  $('#preview-channel-name').textContent = name;
  $('#preview-input-channel').textContent = name;
}
function renderFieldEditors() {
  $('#field-editor-list').innerHTML = state.fields.map((field, index) => `<div class="field-editor" data-field-index="${index}"><div class="field-editor-head"><span>FIELD ${String(index + 1).padStart(2, '0')}</span><button data-remove-field="${index}" aria-label="Remove field">${icon('trash-2')}</button></div><input class="input-control" data-field-name="${index}" maxlength="256" value="${escapeHtml(field.name)}" placeholder="Field name"><textarea class="input-control" data-field-value="${index}" maxlength="1024" rows="2" placeholder="Field value">${escapeHtml(field.value)}</textarea><label class="field-inline"><span>Display inline</span><input type="checkbox" data-field-inline="${index}" ${field.inline ? 'checked' : ''}></label></div>`).join('');
  drawIcons();
}
function renderComponentEditors() {
  $('#component-editor-list').innerHTML = state.components.map((component, index) => `<div class="component-editor" data-component-index="${index}"><span class="component-kind">${component.type === 'button' ? 'LINK BUTTON' : 'SELECT MENU'}</span><button class="remove-component" data-remove-component="${index}" aria-label="Remove component">${icon('trash-2')}</button><input class="input-control" data-component-label="${index}" maxlength="80" value="${escapeHtml(component.label || '')}" placeholder="${component.type === 'button' ? 'Button label' : 'Select menu label'}">${component.type === 'button' ? `<input class="input-control" data-component-url="${index}" type="url" value="${escapeHtml(component.url || '')}" placeholder="https://example.com">` : `<input class="input-control component-option-input" data-component-options="${index}" value="${escapeHtml((component.options || []).join(', '))}" placeholder="Option one, option two">`}</div>`).join('');
  drawIcons();
}
function renderPreview() {
  const draft = currentDraft();
  const hasEmbed = [draft.author, draft.title, draft.description, draft.thumbnail, draft.image, draft.footer].some(Boolean) || draft.fields.some((field) => field.name || field.value);
  $('#preview-content').textContent = draft.content;
  $('#preview-content').classList.toggle('hidden', !draft.content);
  $('#discord-embed').classList.toggle('hidden', !hasEmbed);
  $('#preview-accent').style.backgroundColor = /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#5865f2';
  $('#color-swatch').style.backgroundColor = /^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#5865f2';
  $('#preview-author-name').textContent = draft.author;
  $('#preview-author').classList.toggle('hidden', !draft.author);
  const authorImage = $('#preview-author-icon');
  const authorIcon = safeImage(draft.authorIcon);
  if (authorIcon) authorImage.src = authorIcon;
  else authorImage.removeAttribute('src');
  authorImage.classList.toggle('hidden', !authorIcon);
  $('#preview-title').textContent = draft.title;
  $('#preview-title').classList.toggle('hidden', !draft.title);
  $('#preview-description').textContent = draft.description;
  $('#preview-description').classList.toggle('hidden', !draft.description);
  $('#preview-fields').innerHTML = draft.fields.filter((field) => field.name || field.value).map((field) => `<div class="discord-embed-field ${field.inline ? '' : 'full'}"><strong>${escapeHtml(field.name || 'Field name')}</strong><span>${escapeHtml(field.value || 'Field value')}</span></div>`).join('');
  const thumbnail = $('#preview-thumbnail');
  const thumbnailUrl = safeImage(draft.thumbnail);
  if (thumbnailUrl) thumbnail.src = thumbnailUrl;
  else thumbnail.removeAttribute('src');
  thumbnail.classList.toggle('hidden', !thumbnailUrl || !hasEmbed);
  const image = $('#preview-image');
  const imageUrl = safeImage(draft.image);
  if (imageUrl) image.src = imageUrl;
  else image.removeAttribute('src');
  image.classList.toggle('hidden', !imageUrl || !hasEmbed);
  $('#preview-footer').textContent = draft.footer;
  $('#preview-footer').classList.toggle('hidden', !draft.footer);
  $('#preview-components').innerHTML = draft.components.map((component) => component.type === 'button'
    ? `<button class="preview-button link" tabindex="-1">${escapeHtml(component.label || 'Button')} ${icon('external-link')}</button>`
    : `<select class="preview-select" tabindex="-1"><option>${escapeHtml(component.label || 'Choose an option')}</option>${(component.options || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select>`).join('');
  drawIcons();
}
function updateFieldFromTarget(target) {
  const nameIndex = target.dataset.fieldName;
  const valueIndex = target.dataset.fieldValue;
  const inlineIndex = target.dataset.fieldInline;
  if (nameIndex !== undefined) state.fields[Number(nameIndex)].name = target.value;
  if (valueIndex !== undefined) state.fields[Number(valueIndex)].value = target.value;
  if (inlineIndex !== undefined) state.fields[Number(inlineIndex)].inline = target.checked;
  renderPreview();
}
function updateComponentFromTarget(target) {
  const labelIndex = target.dataset.componentLabel;
  const urlIndex = target.dataset.componentUrl;
  const optionsIndex = target.dataset.componentOptions;
  if (labelIndex !== undefined) state.components[Number(labelIndex)].label = target.value;
  if (urlIndex !== undefined) state.components[Number(urlIndex)].url = target.value;
  if (optionsIndex !== undefined) state.components[Number(optionsIndex)].options = commaList(target.value);
  renderPreview();
}
async function saveMessage() {
  const channel = $('#welcome-channel').value;
  if (!channel) { toast('Choose a welcome channel before saving.', true); return; }
  try {
    await saveChanges({ settings: { welcome: channel, welcome_message: currentDraft() } });
    toast('Welcome message saved.');
  } catch { /* Error is shown by saveChanges. */ }
}
function openServerPicker() { setView('servers'); }
function closeMobileNav() {
  $('#sidebar').classList.remove('open');
  $('#mobile-scrim').classList.remove('visible');
}
function openMobileNav() {
  $('#sidebar').classList.add('open');
  $('#mobile-scrim').classList.add('visible');
}

async function start() {
  const session = await api('/api/session');
  if (session.setupRequired) displayAuthError('Dashboard sign-in is not configured yet. Add the Discord OAuth secret to the bot host.');
  if (!session.loggedIn) {
    $('#auth-screen').classList.remove('hidden');
    $('#app-shell').classList.add('hidden');
    const params = new URLSearchParams(location.search);
    if (params.has('auth')) displayAuthError('That sign-in link expired. Please try again.');
    drawIcons();
    return;
  }
  state.user = session.user;
  $('#auth-screen').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  $('#profile-name').textContent = state.user.username;
  setAvatar($('#user-avatar'), state.user, state.user.username.slice(0, 1).toUpperCase());
  setAvatar($('#top-avatar'), state.user, state.user.username.slice(0, 1).toUpperCase());
  state.guilds = (await api('/api/guilds')).guilds;
  renderServers();
  const remembered = localStorage.getItem('hectee-server');
  const rememberedServer = state.guilds.find((guild) => guild.id === remembered && guild.botInstalled);
  if (rememberedServer) await loadGuild(rememberedServer.id);
  else setView('servers');
  drawIcons();
}

$('#login-button').addEventListener('click', () => { location.href = '/auth/login'; });
$('#server-switcher').addEventListener('click', openServerPicker);
$('#top-server-switch').addEventListener('click', openServerPicker);
$('#mobile-menu').addEventListener('click', openMobileNav);
$('#sidebar-close').addEventListener('click', closeMobileNav);
$('#mobile-scrim').addEventListener('click', closeMobileNav);
$('#back-to-overview').addEventListener('click', () => setView('plugins'));
$('#profile-button').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('hectee-server');
  location.reload();
});
$('#reset-composer').addEventListener('click', () => { fillComposer({}); toast('Draft reset.'); });
$('#save-message').addEventListener('click', saveMessage);
$('#welcome-channel').addEventListener('change', updatePreviewChannel);
$('#add-field').addEventListener('click', () => {
  if (state.fields.length >= 25) return toast('Discord embeds support up to 25 fields.', true);
  state.fields.push({ name: '', value: '', inline: false });
  renderFieldEditors();
  renderPreview();
});
$('#add-button-component').addEventListener('click', () => {
  if (state.components.length >= 5) return toast('Discord messages support up to 5 component rows.', true);
  state.components.push({ type: 'button', label: '', url: '' });
  renderComponentEditors();
  renderPreview();
});
$('#add-select-component').addEventListener('click', () => {
  if (state.components.length >= 5) return toast('Discord messages support up to 5 component rows.', true);
  state.components.push({ type: 'select', label: '', options: [] });
  renderComponentEditors();
  renderPreview();
});
$('#embed-color').addEventListener('input', (event) => { $('#embed-color-hex').value = event.target.value; renderPreview(); });
$('#embed-color-hex').addEventListener('input', (event) => {
  if (/^#[0-9a-f]{6}$/i.test(event.target.value)) { $('#embed-color').value = event.target.value; renderPreview(); }
});
$('#plugin-settings-form').addEventListener('input', (event) => {
  if (event.target.matches('[data-field-name],[data-field-value],[data-field-inline]')) updateFieldFromTarget(event.target);
  if (event.target.matches('[data-component-label],[data-component-url],[data-component-options]')) updateComponentFromTarget(event.target);
});
$('#plugin-settings-form').addEventListener('change', (event) => {
  if (event.target.matches('[data-field-name],[data-field-value],[data-field-inline]')) updateFieldFromTarget(event.target);
  if (event.target.matches('[data-component-label],[data-component-url],[data-component-options]')) updateComponentFromTarget(event.target);
});

document.addEventListener('input', (event) => {
  if (event.target.closest('#composer-view') && !event.target.matches('[data-field-name],[data-field-value],[data-field-inline],[data-component-label],[data-component-url],[data-component-options]')) renderPreview();
});
document.addEventListener('change', (event) => {
  if (event.target.matches('[data-field-name],[data-field-value],[data-field-inline]')) updateFieldFromTarget(event.target);
  if (event.target.matches('[data-component-label],[data-component-url],[data-component-options]')) updateComponentFromTarget(event.target);
});
document.addEventListener('click', async (event) => {
  const manage = event.target.closest('[data-manage-server]');
  if (manage) return loadGuild(manage.dataset.manageServer);
  const invite = event.target.closest('[data-invite-server]');
  if (invite) {
    try {
      const result = await api(`/api/guilds/${invite.dataset.inviteServer}/invite`);
      location.assign(result.url);
    } catch (error) { toast(error.message, true); }
    return;
  }
  const targetView = event.target.closest('[data-view]')?.dataset.view || event.target.closest('[data-view-target]')?.dataset.viewTarget;
  if (targetView) {
    if (targetView === 'composer') fillComposer(state.guildData?.welcomeMessage || {});
    setView(targetView);
    return;
  }
  const plugin = event.target.closest('[data-plugin-settings]')?.dataset.pluginSettings;
  if (plugin) { showPluginSettings(plugin); return; }
  const toggle = event.target.closest('[data-plugin-toggle]');
  if (toggle) return togglePlugin(toggle.dataset.pluginToggle, toggle.checked);
  if (event.target.closest('#settings-toggle')) return togglePlugin(state.currentPlugin.id, event.target.closest('#settings-toggle').checked);
  const saveSettings = event.target.closest('[data-save-settings]');
  if (saveSettings) return savePluginSettings(saveSettings.dataset.saveSettings).catch(() => {});
  const staffRole = event.target.closest('[data-staff-role]');
  if (staffRole) { staffRole.classList.toggle('selected'); return; }
  const removeField = event.target.closest('[data-remove-field]');
  if (removeField) { state.fields.splice(Number(removeField.dataset.removeField), 1); renderFieldEditors(); renderPreview(); return; }
  const removeComponent = event.target.closest('[data-remove-component]');
  if (removeComponent) { state.components.splice(Number(removeComponent.dataset.removeComponent), 1); renderComponentEditors(); renderPreview(); return; }
  const saveTag = event.target.closest('[data-save-tag]');
  if (saveTag) {
    const name = $('#tag-name').value.trim().toLowerCase();
    const response = $('#tag-response').value.trim();
    if (!/^[a-z0-9_-]{1,32}$/.test(name) || !response) return toast('Enter a tag name and response.', true);
    try {
      const result = await api(`/api/guilds/${state.guild.id}/tags`, { method: 'PUT', body: JSON.stringify({ name, response }) });
      state.guildData.tags = result.tags;
      showPluginSettings('customCommands');
      toast(`!${name} is ready.`);
    } catch (error) { toast(error.message, true); }
    return;
  }
  const deleteTag = event.target.closest('[data-delete-tag]');
  if (deleteTag) {
    try {
      const result = await api(`/api/guilds/${state.guild.id}/tags/${encodeURIComponent(deleteTag.dataset.deleteTag)}`, { method: 'DELETE' });
      state.guildData.tags = result.tags;
      showPluginSettings('customCommands');
      toast('Tag deleted.');
    } catch (error) { toast(error.message, true); }
  }
});

start().catch((error) => {
  displayAuthError(error.message);
  $('#auth-screen').classList.remove('hidden');
  $('#app-shell').classList.add('hidden');
  drawIcons();
});
