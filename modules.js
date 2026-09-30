const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
} = require('discord.js');
const { guildData, save } = require('./store');

const recentMessages = new Map();
const DEFAULT_BLOCKED_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'damn'];
const COLORS = { info: 0x3498db, warn: 0xf1c40f, bad: 0xe74c3c, good: 0x2ecc71 };

function embed(title, description, color = COLORS.info) {
  return new EmbedBuilder().setColor(color).setTitle(title).setDescription(description).setTimestamp();
}

function clip(value, length = 1000) {
  return String(value || '').slice(0, length) || '(unavailable)';
}

function cleanId(value) {
  return value.replace(/[<@#!&>]/g, '').trim();
}

async function logTo(guild, title, description, color = COLORS.info, fields = []) {
  const data = guildData(guild.id);
  if (!data.plugins.logging) return;
  const eventKey = title.includes('deleted') || title.includes('purged') || title.includes('removed') ? 'message_delete'
    : title.includes('edited') ? 'message_edit'
      : title.includes('joined') ? 'member_join'
        : title.includes('left') ? 'member_leave'
          : title.includes('Nickname') ? 'nickname_change'
            : title.includes('Ticket') ? 'tickets'
              : 'moderation';
  const channelId = data.settings.log_channels?.[eventKey] || data.settings.logs;
  if (!channelId) return;
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = embed(title, description, color);
  if (fields.length) message.addFields(fields);
  await channel.send({ embeds: [message], allowedMentions: { parse: [] } }).catch((error) => {
    console.error(`Could not send a log in ${guild.id}:`, error);
  });
}

function addWarning(guildId, userId, reason, moderatorId) {
  const data = guildData(guildId);
  data.warnings[userId] ??= [];
  data.warnings[userId].push({ reason, moderatorId, at: new Date().toISOString() });
  save();
  return data.warnings[userId].length;
}

async function warnUser(guild, user, reason, moderatorId, automated = false) {
  const count = addWarning(guild.id, user.id, reason, moderatorId);
  await user.send({ embeds: [embed('Server warning', reason, COLORS.warn)] }).catch(() => {});
  await logTo(guild, automated ? 'Auto-Mod warning' : 'Member warned', `${user} received warning #${count}.`, COLORS.warn, [
    { name: 'Reason', value: clip(reason, 900) },
    { name: 'Moderator', value: moderatorId ? `<@${moderatorId}>` : 'Auto-Mod', inline: true },
  ]);
  return count;
}

function canManage(interaction, permission) {
  return interaction.memberPermissions?.has(permission) || interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);
}

function parseList(value) {
  return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function validateAndNormalize(key, value) {
  if (['logs', 'welcome', 'rules', 'member_role'].includes(key)) {
    if (key === 'member_role' && value.trim().toLowerCase() === 'off') return null;
    const id = cleanId(value);
    if (!/^\d{17,20}$/.test(id)) throw new Error('Use a channel or role mention, or its numeric ID.');
    return id;
  }
  if (key === 'staff_roles') {
    const ids = value.split(',').map(cleanId).filter(Boolean);
    if (!ids.length || ids.some((id) => !/^\d{17,20}$/.test(id))) throw new Error('Use one or more role mentions/IDs separated by commas.');
    return ids;
  }
  if (key === 'blocked_words' || key === 'blocked_domains') return parseList(value);
  if (key === 'mention_limit') {
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 2 || limit > 50) throw new Error('Mention limit must be a whole number from 2 to 50.');
    return limit;
  }
  if (key === 'join_mode') {
    const mode = value.trim().toLowerCase();
    if (!['verify', 'instant'].includes(mode)) throw new Error('Choose verify or instant.');
    return mode;
  }
  if (key === 'welcome_text') return value.slice(0, 1000);
  throw new Error('Unknown setting.');
}

async function configure(interaction) {
  const data = guildData(interaction.guildId);
  if (interaction.options.getSubcommand() === 'show') {
    const visible = Object.entries(data.settings).map(([key, value]) => `**${key}:** ${Array.isArray(value) ? value.join(', ') : value}`);
    await interaction.reply({ content: visible.join('\n') || 'No settings configured yet.', ephemeral: true });
    return;
  }

  const key = interaction.options.getString('key');
  try {
    data.settings[key] = validateAndNormalize(key, interaction.options.getString('value'));
    save();
    await interaction.reply({ content: `Saved **${key}**.`, ephemeral: true });
  } catch (error) {
    await interaction.reply({ content: error.message, ephemeral: true });
  }
}

async function runModeration(interaction) {
  const command = interaction.commandName;
  const permission = command === 'ban' ? PermissionFlagsBits.BanMembers
    : command === 'kick' ? PermissionFlagsBits.KickMembers
      : command === 'timeout' ? PermissionFlagsBits.ModerateMembers
        : PermissionFlagsBits.ManageMessages;
  if (!canManage(interaction, permission)) {
    await interaction.reply({ content: 'You do not have permission to use this command.', ephemeral: true });
    return;
  }

  if (command === 'purge') {
    const amount = interaction.options.getInteger('amount');
    const deleted = await interaction.channel.bulkDelete(amount, true);
    await interaction.reply({ content: `Deleted ${deleted.size} message(s).`, ephemeral: true });
    await logTo(interaction.guild, 'Messages purged', `${interaction.user} deleted ${deleted.size} message(s) in ${interaction.channel}.`, COLORS.warn);
    return;
  }

  const targetUser = interaction.options.getUser('user');
  const reason = interaction.options.getString('reason') || `Action by ${interaction.user.tag}`;
  if (targetUser.id === interaction.user.id || targetUser.id === interaction.client.user.id) {
    await interaction.reply({ content: 'You cannot use this action on yourself or the bot.', ephemeral: true });
    return;
  }
  const target = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
  if (!target) {
    await interaction.reply({ content: 'That member is no longer in the server.', ephemeral: true });
    return;
  }
  if (target.id === interaction.guild.ownerId || (interaction.member.roles.highest.comparePositionTo(target.roles.highest) <= 0 && interaction.user.id !== interaction.guild.ownerId)) {
    await interaction.reply({ content: 'Your role must be higher than the target member’s role.', ephemeral: true });
    return;
  }

  try {
    if (command === 'warn') {
      const count = await warnUser(interaction.guild, targetUser, interaction.options.getString('reason'), interaction.user.id);
      await interaction.reply({ content: `Warned ${targetUser.tag}. They now have ${count} recorded warning(s).`, ephemeral: true });
      return;
    }
    if (command === 'ban') await target.ban({ reason });
    if (command === 'kick') await target.kick(reason);
    if (command === 'timeout') await target.timeout(interaction.options.getInteger('minutes') * 60_000, reason);
    await interaction.reply({ content: `${targetUser.tag} was ${command === 'timeout' ? 'timed out' : `${command}ned`}.`, ephemeral: true });
    await logTo(interaction.guild, `Member ${command}`, `${targetUser} was ${command === 'timeout' ? 'timed out' : `${command}ned`} by ${interaction.user}.`, COLORS.bad, [
      { name: 'Reason', value: clip(reason, 900) },
    ]);
  } catch (error) {
    console.error(`Moderation command ${command} failed:`, error);
    await interaction.reply({ content: 'Discord could not complete that action. Check my role position and permissions.', ephemeral: true });
  }
}

async function runTag(interaction) {
  const data = guildData(interaction.guildId);
  const subcommand = interaction.options.getSubcommand();
  const name = interaction.options.getString('name').toLowerCase();
  if (subcommand === 'set') {
    data.tags[name] = interaction.options.getString('response');
    save();
    await interaction.reply({ content: `Saved the \/${name} snippet.`, ephemeral: true });
  } else if (subcommand === 'delete') {
    delete data.tags[name];
    save();
    await interaction.reply({ content: `Deleted the \/${name} snippet, if it existed.`, ephemeral: true });
  } else {
    await interaction.reply({ content: data.tags[name] || `No snippet named “${name}” exists.`, allowedMentions: { parse: [] } });
  }
}

async function runRolePanel(interaction) {
  const data = guildData(interaction.guildId);
  if (interaction.options.getSubcommand() === 'create') {
    const panel = await interaction.channel.send({ embeds: [embed(interaction.options.getString('title'), 'Choose a button below to add or remove that role.')] });
    data.rolePanels[panel.id] = { channelId: panel.channelId, buttons: [] };
    save();
    await interaction.reply({ content: `Panel posted. Message ID: ${panel.id}. Use /role-panel add in this channel to add buttons.`, ephemeral: true });
    return;
  }

  const messageId = interaction.options.getString('message_id');
  const panelConfig = data.rolePanels[messageId];
  const role = interaction.options.getRole('role');
  if (!panelConfig || panelConfig.channelId !== interaction.channelId) {
    await interaction.reply({ content: 'Create the panel first and add buttons in the same channel.', ephemeral: true });
    return;
  }
  if (panelConfig.buttons.length >= 5) {
    await interaction.reply({ content: 'A Discord message supports up to five role buttons.', ephemeral: true });
    return;
  }
  const botMember = await interaction.guild.members.fetchMe();
  if (role.managed || role.position >= botMember.roles.highest.position) {
    await interaction.reply({ content: 'Move the bot role above this role, or choose a regular role.', ephemeral: true });
    return;
  }
  const message = await interaction.channel.messages.fetch(messageId).catch(() => null);
  if (!message) {
    await interaction.reply({ content: 'I could not find that panel message.', ephemeral: true });
    return;
  }
  const label = interaction.options.getString('label');
  const emoji = interaction.options.getString('emoji');
  const button = { roleId: role.id, label, emoji: emoji || null };
  panelConfig.buttons.push(button);
  const components = panelConfig.buttons.map((item) => {
    const component = new ButtonBuilder().setCustomId(`rr:${messageId}:${item.roleId}`).setLabel(item.label).setStyle(ButtonStyle.Primary);
    if (item.emoji) component.setEmoji(item.emoji);
    return component;
  });
  await message.edit({ components: [new ActionRowBuilder().addComponents(components)] });
  save();
  await interaction.reply({ content: `Added the ${role} button.`, ephemeral: true });
}

async function openTicket(interaction) {
  const data = guildData(interaction.guildId);
  const existingId = data.openTickets[interaction.user.id];
  if (existingId) {
    const existing = interaction.guild.channels.cache.get(existingId);
    if (existing) {
      await interaction.reply({ content: `You already have an open ticket: ${existing}`, ephemeral: true });
      return;
    }
    delete data.openTickets[interaction.user.id];
  }
  const staffRoles = data.settings.staff_roles || [];
  if (!staffRoles.length) {
    await interaction.reply({ content: 'Tickets are not configured yet. Ask an admin to set Staff roles with /config set.', ephemeral: true });
    return;
  }
  const overwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ReadMessageHistory] },
    ...staffRoles.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] })),
  ];
  const channel = await interaction.guild.channels.create({
    name: `ticket-${interaction.user.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90),
    type: ChannelType.GuildText,
    permissionOverwrites: overwrites,
    reason: `Support ticket opened by ${interaction.user.tag}`,
  });
  data.openTickets[interaction.user.id] = channel.id;
  save();
  const closeButton = new ButtonBuilder().setCustomId('ticket:close').setLabel('Close ticket').setStyle(ButtonStyle.Danger);
  await channel.send({ content: `${interaction.user} ${staffRoles.map((id) => `<@&${id}>`).join(' ')}`, embeds: [embed('Support ticket', 'Please describe what you need help with. A staff member will be with you soon.')], components: [new ActionRowBuilder().addComponents(closeButton)], allowedMentions: { parse: [], users: [interaction.user.id], roles: staffRoles } });
  await interaction.reply({ content: `Your private ticket is ready: ${channel}`, ephemeral: true });
  await logTo(interaction.guild, 'Ticket opened', `${interaction.user} opened ${channel}.`);
}

async function closeTicket(interaction) {
  const data = guildData(interaction.guildId);
  const opener = Object.entries(data.openTickets).find(([, channelId]) => channelId === interaction.channelId)?.[0];
  if (!opener) {
    await interaction.reply({ content: 'This ticket is not registered as open.', ephemeral: true });
    return;
  }
  const isStaff = (data.settings.staff_roles || []).some((roleId) => interaction.member.roles.cache.has(roleId));
  if (interaction.user.id !== opener && !isStaff) {
    await interaction.reply({ content: 'Only the ticket opener or staff can close this ticket.', ephemeral: true });
    return;
  }
  delete data.openTickets[opener];
  save();
  await interaction.channel.permissionOverwrites.edit(opener, { ViewChannel: false });
  await interaction.channel.setName(`closed-${interaction.channel.name}`.slice(0, 100));
  await interaction.reply({ content: 'Ticket closed. Staff can still review the channel.', ephemeral: true });
  await logTo(interaction.guild, 'Ticket closed', `Ticket ${interaction.channel} was closed by ${interaction.user}.`, COLORS.warn);
}

function isAutomodHit(message) {
  const settings = guildData(message.guild.id).settings;
  const content = message.content.toLowerCase();
  const words = [...DEFAULT_BLOCKED_WORDS, ...(settings.blocked_words || [])];
  const matchedWord = words.find((word) => new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i').test(content));
  if (matchedWord) return `Blocked word: ${matchedWord}`;
  const domains = settings.blocked_domains || [];
  const matchedDomain = domains.find((domain) => content.includes(domain));
  if (matchedDomain) return `Blocked link domain: ${matchedDomain}`;
  const mentionLimit = settings.mention_limit || 5;
  if (message.mentions.users.size + message.mentions.roles.size >= mentionLimit || message.mentions.everyone) return 'Mass mentions';

  const now = Date.now();
  const key = `${message.guild.id}:${message.author.id}`;
  const recent = (recentMessages.get(key) || []).filter((item) => now - item.time < 8000);
  recent.push({ time: now, content });
  recentMessages.set(key, recent);
  if (recent.length >= 5 || recent.filter((item) => item.content === content).length >= 3) return 'Spam';
  return null;
}

async function onMessage(message) {
  if (!message.guild || message.author.bot || !message.content) return;
  const data = guildData(message.guild.id);
  const tagName = data.plugins.customCommands && message.content.trim().match(/^!([a-z0-9_-]{1,32})$/i)?.[1].toLowerCase();
  const tag = tagName && data.tags[tagName];
  if (tag) {
    await message.channel.send({ content: tag, allowedMentions: { parse: [] } });
    return;
  }
  if (!data.plugins.moderation) return;
  const reason = isAutomodHit(message);
  if (!reason) return;
  await message.delete().catch(() => {});
  await warnUser(message.guild, message.author, reason, null, true);
  await logTo(message.guild, 'Auto-Mod removed a message', `${message.author} sent a message removed in ${message.channel}.`, COLORS.bad, [
    { name: 'Reason', value: reason, inline: true }, { name: 'Content', value: clip(message.content, 900) },
  ]);
}

function welcomeToken(value, member, rules) {
  return String(value || '').replaceAll('{user}', `<@${member.id}>`)
    .replaceAll('{server}', member.guild.name)
    .replaceAll('{rules}', rules ? `<#${rules}>` : '');
}

function buildWelcomePayload(member, settings) {
  const draft = settings.welcome_message || {};
  const content = welcomeToken(draft.content || settings.welcome_text || 'Welcome {user} to **{server}**! {rules}', member, settings.rules);
  const components = (draft.components || []).slice(0, 5).flatMap((component, index) => {
    if (component.type === 'button' && component.label && component.url) {
      return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(component.label).setStyle(ButtonStyle.Link).setURL(component.url),
      )];
    }
    if (component.type === 'select' && component.options?.length) {
      const select = new StringSelectMenuBuilder()
        .setCustomId(`welcome-select:${index}`)
        .setPlaceholder((component.label || 'Choose an option').slice(0, 150))
        .addOptions(component.options.slice(0, 25).map((option, optionIndex) => ({
          label: option.slice(0, 100),
          value: `option-${optionIndex}`,
        })));
      return [new ActionRowBuilder().addComponents(select)];
    }
    return [];
  });
  const hasEmbed = [draft.author, draft.title, draft.description, draft.thumbnail, draft.image, draft.footer].some(Boolean)
    || draft.fields?.some((field) => field.name && field.value);
  if (!hasEmbed) return { content, components, allowedMentions: { parse: [], users: [member.id] } };

  const messageEmbed = new EmbedBuilder().setColor(Number.parseInt((draft.color || '#5865f2').replace('#', ''), 16));
  if (draft.author) messageEmbed.setAuthor({ name: welcomeToken(draft.author, member, settings.rules), ...(draft.authorIcon ? { iconURL: draft.authorIcon } : {}) });
  if (draft.title) messageEmbed.setTitle(welcomeToken(draft.title, member, settings.rules));
  if (draft.description) messageEmbed.setDescription(welcomeToken(draft.description, member, settings.rules));
  if (draft.thumbnail) messageEmbed.setThumbnail(draft.thumbnail);
  if (draft.image) messageEmbed.setImage(draft.image);
  if (draft.footer) messageEmbed.setFooter({ text: welcomeToken(draft.footer, member, settings.rules) });
  const fields = (draft.fields || []).filter((field) => field.name && field.value).map((field) => ({
    name: welcomeToken(field.name, member, settings.rules),
    value: welcomeToken(field.value, member, settings.rules),
    inline: Boolean(field.inline),
  }));
  if (fields.length) messageEmbed.addFields(fields);

  return { content, embeds: [messageEmbed], components, allowedMentions: { parse: [], users: [member.id] } };
}

async function onMemberJoin(member) {
  const data = guildData(member.guild.id);
  if (data.plugins.welcomer) {
    if (data.settings.join_mode === 'instant') {
      const roleId = data.settings.member_role || process.env.MEMBER_ROLE_ID;
      const role = roleId ? await member.guild.roles.fetch(roleId).catch(() => null) : null;
      if (role) await member.roles.add(role, 'Configured auto-role on join').catch(console.error);
    }
    const channelId = data.settings.welcome;
    if (channelId) {
      const channel = member.guild.channels.cache.get(channelId) || await member.guild.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased()) await channel.send(buildWelcomePayload(member, data.settings)).catch(console.error);
    }
  }
  await logTo(member.guild, 'Member joined', `${member.user} joined the server.`, COLORS.good);
}

async function setupModules(interaction) {
  const data = guildData(interaction.guildId);
  const existing = data.settings.logs
    ? await interaction.guild.channels.fetch(data.settings.logs).catch(() => null)
    : null;
  const staffRoles = (data.settings.staff_roles || []).filter((roleId) => interaction.guild.roles.cache.has(roleId));
  const permissionOverwrites = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
    ...staffRoles.map((roleId) => ({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] })),
  ];
  const channel = existing?.name === 'mod-logs' && existing.isTextBased()
    ? existing
    : await interaction.guild.channels.create({
      name: 'mod-logs',
      type: ChannelType.GuildText,
      permissionOverwrites,
      reason: `Private moderation logs set up by ${interaction.user.tag}`,
    });
  if (channel === existing) {
    await channel.permissionOverwrites.set(permissionOverwrites, 'Update private log channel staff access');
  }
  data.settings.logs = channel.id;
  save();
  await interaction.reply({ content: `Private logs are ready in ${channel}.`, ephemeral: true });
}

function registerModules(client) {
  client.on(Events.MessageCreate, (message) => onMessage(message).catch(console.error));
  client.on(Events.MessageDelete, (message) => {
    if (message.guild) logTo(message.guild, 'Message deleted', `A message by ${message.author || 'unknown user'} was deleted in ${message.channel}.`, COLORS.warn, [
      { name: 'Content', value: clip(message.content, 900) },
    ]).catch(console.error);
  });
  client.on(Events.MessageUpdate, (before, after) => {
    if (after.guild && before.content !== after.content) logTo(after.guild, 'Message edited', `A message by ${after.author || 'unknown user'} was edited in ${after.channel}.`, COLORS.info, [
      { name: 'Before', value: clip(before.content, 900) }, { name: 'After', value: clip(after.content, 900) },
    ]).catch(console.error);
  });
  client.on(Events.GuildMemberAdd, (member) => onMemberJoin(member).catch(console.error));
  client.on(Events.GuildMemberRemove, (member) => logTo(member.guild, 'Member left', `${member.user} left the server.`, COLORS.warn).catch(console.error));
  client.on(Events.GuildMemberUpdate, (before, after) => {
    if (before.nickname !== after.nickname) logTo(after.guild, 'Nickname changed', `${after.user} changed their nickname.`, COLORS.info, [
      { name: 'Before', value: before.nickname || before.user.username, inline: true },
      { name: 'After', value: after.nickname || after.user.username, inline: true },
    ]).catch(console.error);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        const plugins = guildData(interaction.guildId).plugins;
        if (['ban', 'kick', 'warn', 'timeout', 'purge'].includes(interaction.commandName)) {
          if (!plugins.moderation) return await interaction.reply({ content: 'The Moderation plugin is disabled in the dashboard.', ephemeral: true });
          return await runModeration(interaction);
        }
        if (interaction.commandName === 'config') return await configure(interaction);
        if (interaction.commandName === 'setup-modules') return await setupModules(interaction);
        if (interaction.commandName === 'tag') {
          if (!plugins.customCommands) return await interaction.reply({ content: 'The Custom Commands plugin is disabled in the dashboard.', ephemeral: true });
          return await runTag(interaction);
        }
        if (interaction.commandName === 'role-panel') {
          if (!plugins.reactionRoles) return await interaction.reply({ content: 'The Reaction Roles plugin is disabled in the dashboard.', ephemeral: true });
          return await runRolePanel(interaction);
        }
        if (interaction.commandName === 'ticket-panel') {
          if (!plugins.tickets) return await interaction.reply({ content: 'The Tickets plugin is disabled in the dashboard.', ephemeral: true });
          const panel = embed(interaction.options.getString('title'), 'Need help? Tap **Open Ticket** to create a private support channel.');
          const button = new ButtonBuilder().setCustomId('ticket:open').setLabel('Open Ticket').setStyle(ButtonStyle.Primary);
          await interaction.channel.send({ embeds: [panel], components: [new ActionRowBuilder().addComponents(button)] });
          await interaction.reply({ content: 'Ticket panel posted.', ephemeral: true });
          return;
        }
      }

      if (interaction.isStringSelectMenu() && interaction.customId.startsWith('welcome-select:')) {
        const index = Number(interaction.customId.split(':')[1]);
        const selected = Number(interaction.values[0]?.split('-')[1]);
        const option = guildData(interaction.guildId).settings.welcome_message?.components?.[index]?.options?.[selected];
        return await interaction.reply({ content: `Selected: ${option || 'your option'}`, ephemeral: true, allowedMentions: { parse: [] } });
      }
      if (interaction.isButton() && interaction.customId === 'ticket:open') {
        if (!guildData(interaction.guildId).plugins.tickets) return await interaction.reply({ content: 'Tickets are disabled right now.', ephemeral: true });
        return await openTicket(interaction);
      }
      if (interaction.isButton() && interaction.customId === 'ticket:close') return await closeTicket(interaction);
      if (interaction.isButton() && interaction.customId.startsWith('rr:')) {
        if (!guildData(interaction.guildId).plugins.reactionRoles) return await interaction.reply({ content: 'Reaction Roles are disabled right now.', ephemeral: true });
        const [, panelId, roleId] = interaction.customId.split(':');
        const panel = guildData(interaction.guildId).rolePanels[panelId];
        const button = panel?.buttons.find((item) => item.roleId === roleId);
        const role = await interaction.guild.roles.fetch(roleId).catch(() => null);
        if (!button || !role || role.managed || role.position >= (await interaction.guild.members.fetchMe()).roles.highest.position) {
          await interaction.reply({ content: 'That role button is no longer available.', ephemeral: true });
          return;
        }
        const hasRole = interaction.member.roles.cache.has(roleId);
        await interaction.member.roles[hasRole ? 'remove' : 'add'](role, 'Self-service role button');
        await interaction.reply({ content: `${hasRole ? 'Removed' : 'Added'} **${role.name}**.`, ephemeral: true });
      }
    } catch (error) {
      console.error('Feature interaction failed:', error);
      const reply = { content: 'That action failed. Check my permissions and role position, then try again.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(reply).catch(() => {});
      else await interaction.reply(reply).catch(() => {});
    }
  });
}

module.exports = registerModules;