require('dotenv').config();
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} = require('discord.js');
const registerModules = require('./modules');
const startDashboard = require('./dashboard');
const { guildData } = require('./store');

const requiredEnv = [
  'DISCORD_TOKEN',
  'GUILD_ID',
  'UNVERIFIED_ROLE_ID',
  'MEMBER_ROLE_ID',
  'VERIFICATION_CHANNEL_ID',
];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  throw new Error(`Missing environment variables: ${missingEnv.join(', ')}`);
}

const GUILD_ID = process.env.GUILD_ID;
const UNVERIFIED_ROLE_ID = process.env.UNVERIFIED_ROLE_ID;
const MEMBER_ROLE_ID = process.env.MEMBER_ROLE_ID;
const VERIFICATION_CHANNEL_ID = process.env.VERIFICATION_CHANNEL_ID;
const VERIFY_BUTTON_ID = 'hectee:verify';
const SKIP_CHANNEL_TYPES = new Set([
  ChannelType.AnnouncementThread,
  ChannelType.PrivateThread,
  ChannelType.PublicThread,
]);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message],
});

async function fetchRole(guild, roleId) {
  try {
    return guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId);
  } catch (error) {
    console.error(`Could not fetch role ${roleId}:`, error);
    return null;
  }
}

async function postVerificationMessage(channel) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Hectee Verification')
    .setDescription('Click The Button Below To Be Verified And Continue To Our Server');

  const button = new ButtonBuilder()
    .setCustomId(VERIFY_BUTTON_ID)
    .setLabel('Verify')
    .setEmoji('✅')
    .setStyle(ButtonStyle.Success);

  await channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
  });
}

async function setupVerification(interaction) {
  const guild = interaction.guild;

  if (!guild || guild.id !== GUILD_ID) {
    await interaction.reply({ content: 'This bot is not configured for this server.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const [channel, unverifiedRole, memberRole] = await Promise.all([
    guild.channels.fetch(VERIFICATION_CHANNEL_ID),
    fetchRole(guild, UNVERIFIED_ROLE_ID),
    fetchRole(guild, MEMBER_ROLE_ID),
  ]);

  if (!channel || !channel.isTextBased() || channel.isThread()) {
    await interaction.editReply('The configured verification channel was not found or is not a text channel.');
    return;
  }

  if (!unverifiedRole || !memberRole) {
    await interaction.editReply('The configured Unverified or Member role could not be found.');
    return;
  }

  const me = await guild.members.fetchMe();
  const requiredPermissions = [
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks,
  ];
  const missingPermissions = requiredPermissions.filter((permission) => !me.permissions.has(permission));

  if (missingPermissions.length > 0) {
    await interaction.editReply(
      'I need Manage Roles, Manage Channels, Send Messages, and Embed Links permissions to set up verification.',
    );
    return;
  }

  const channels = await guild.channels.fetch();
  const failedChannels = [];

  for (const serverChannel of channels.values()) {
    if (!serverChannel || SKIP_CHANNEL_TYPES.has(serverChannel.type)) {
      continue;
    }

    try {
      await serverChannel.permissionOverwrites.edit(unverifiedRole, {
        ViewChannel: serverChannel.id === channel.id,
      }, {
        reason: serverChannel.id === channel.id
          ? 'Allow unverified members to access the verification channel'
          : 'Hide server channels from unverified members',
      });
    } catch (error) {
      failedChannels.push(serverChannel.name);
      console.error(`Could not restrict ${serverChannel.name}:`, error);
    }
  }

  await postVerificationMessage(channel);

  const warning = failedChannels.length > 0
    ? ` I could not update these channels: ${failedChannels.join(', ')}. Check my Manage Channels permission there.`
    : '';
  await interaction.editReply(
    `Verification is ready in ${channel}. New members will receive **${unverifiedRole.name}**; the button gives them **${memberRole.name}** and removes the unverified role.${warning}`,
  );
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Ready as ${readyClient.user.tag}`);
  startDashboard(readyClient);
});

client.on(Events.GuildMemberAdd, async (member) => {
  if (member.guild.id !== GUILD_ID) {
    return;
  }

  const data = guildData(member.guild.id);
  if (!data.plugins.welcomer || data.settings.join_mode === 'instant') {
    return;
  }

  const unverifiedRole = await fetchRole(member.guild, UNVERIFIED_ROLE_ID);

  if (!unverifiedRole) {
    console.error(`The configured Unverified role ${UNVERIFIED_ROLE_ID} could not be found.`);
    return;
  }

  try {
    await member.roles.add(unverifiedRole, 'New member requires verification');
  } catch (error) {
    console.error(`Could not assign Unverified to ${member.user.tag}:`, error);
  }
});

client.on(Events.ChannelCreate, async (channel) => {
  if (!channel.guild || channel.guild.id !== GUILD_ID || SKIP_CHANNEL_TYPES.has(channel.type)) {
    return;
  }

  const unverifiedRole = await fetchRole(channel.guild, UNVERIFIED_ROLE_ID);
  if (!unverifiedRole) {
    return;
  }

  try {
    await channel.permissionOverwrites.edit(unverifiedRole, {
      ViewChannel: false,
    }, {
      reason: 'Hide newly created channels from unverified members',
    });
  } catch (error) {
    console.error(`Could not restrict newly created channel ${channel.name}:`, error);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === 'setup-verification') {
    try {
      await setupVerification(interaction);
    } catch (error) {
      console.error('Verification setup failed:', error);
      const message = 'Setup failed. Check that my role is above Unverified and Member, and that I have the required channel permissions.';

      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(message).catch(console.error);
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(console.error);
      }
    }
    return;
  }

  if (!interaction.isButton() || interaction.customId !== VERIFY_BUTTON_ID) {
    return;
  }

  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Verification is only available in the server.', ephemeral: true });
    return;
  }

  if (interaction.guildId !== GUILD_ID) {
    await interaction.reply({ content: 'Verification is not configured for this server.', ephemeral: true });
    return;
  }

  const [unverifiedRole, memberRole] = await Promise.all([
    fetchRole(interaction.guild, UNVERIFIED_ROLE_ID),
    fetchRole(interaction.guild, MEMBER_ROLE_ID),
  ]);

  if (!unverifiedRole || !memberRole) {
    await interaction.reply({
      content: 'Verification is not configured yet. Please contact a server moderator.',
      ephemeral: true,
    });
    return;
  }

  try {
    await interaction.member.roles.add(memberRole, 'Member completed server verification');
    await interaction.member.roles.remove(unverifiedRole, 'Member completed server verification');
    await interaction.reply({ content: 'You are verified. Welcome to Hectee!', ephemeral: true });
  } catch (error) {
    console.error(`Could not verify ${interaction.user.tag}:`, error);
    await interaction.reply({
      content: 'I could not update your roles. Please contact a server moderator.',
      ephemeral: true,
    }).catch(console.error);
  }
});

registerModules(client);

if (require.main === module) {
  client.login(process.env.DISCORD_TOKEN).catch((error) => {
    console.error('Could not log in to Discord:', error);
    process.exitCode = 1;
  });
}
