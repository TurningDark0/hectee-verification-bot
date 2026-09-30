require('dotenv').config();
require('dotenv').config({ path: require('node:path').join(__dirname, '.env') });

const { PermissionFlagsBits, REST, Routes, SlashCommandBuilder } = require('discord.js');

const requiredEnv = ['DISCORD_TOKEN', 'CLIENT_ID', 'GUILD_ID'];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  throw new Error(`Missing environment variables: ${missingEnv.join(', ')}`);
}

const adminOnly = (command) => command.setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
const commands = [
  new SlashCommandBuilder().setName('setup-verification')
    .setDescription('Set up Hectee verification in the configured channel.'),
  adminOnly(new SlashCommandBuilder().setName('setup-modules')
    .setDescription('Create a private moderation log channel.')),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member.')
    .addUserOption((option) => option.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the ban')),
  new SlashCommandBuilder().setName('kick').setDescription('Kick a member.')
    .addUserOption((option) => option.setName('user').setDescription('Member to kick').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the kick')),
  new SlashCommandBuilder().setName('warn').setDescription('Warn a member and record the infraction.')
    .addUserOption((option) => option.setName('user').setDescription('Member to warn').setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the warning').setRequired(true)),
  new SlashCommandBuilder().setName('timeout').setDescription('Temporarily prevent a member from chatting.')
    .addUserOption((option) => option.setName('user').setDescription('Member to timeout').setRequired(true))
    .addIntegerOption((option) => option.setName('minutes').setDescription('Timeout length (1-40320 minutes)').setMinValue(1).setMaxValue(40320).setRequired(true))
    .addStringOption((option) => option.setName('reason').setDescription('Reason for the timeout')),
  new SlashCommandBuilder().setName('purge').setDescription('Delete up to 100 recent messages.')
    .addIntegerOption((option) => option.setName('amount').setDescription('Number of messages (1-100)').setMinValue(1).setMaxValue(100).setRequired(true)),
  adminOnly(new SlashCommandBuilder().setName('config').setDescription('Configure bot modules.')
    .addSubcommand((subcommand) => subcommand.setName('set').setDescription('Set a module option')
      .addStringOption((option) => option.setName('key').setDescription('Setting name').setRequired(true)
        .addChoices(
          { name: 'Logs channel', value: 'logs' }, { name: 'Welcome channel', value: 'welcome' },
          { name: 'Welcome text', value: 'welcome_text' }, { name: 'Rules channel', value: 'rules' },
          { name: 'Member role', value: 'member_role' }, { name: 'Staff roles', value: 'staff_roles' },
          { name: 'Join mode', value: 'join_mode' },
          { name: 'Blocked words', value: 'blocked_words' }, { name: 'Blocked domains', value: 'blocked_domains' },
          { name: 'Mention limit', value: 'mention_limit' },
        ))
      .addStringOption((option) => option.setName('value').setDescription('Channel/role mention, setting value, or list').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('show').setDescription('Show current module settings'))),
  adminOnly(new SlashCommandBuilder().setName('tag').setDescription('Create and use saved text snippets.')
    .addSubcommand((subcommand) => subcommand.setName('set').setDescription('Create or update a snippet')
      .addStringOption((option) => option.setName('name').setDescription('Short name').setRequired(true).setMaxLength(32))
      .addStringOption((option) => option.setName('response').setDescription('Text to send').setRequired(true).setMaxLength(1800)))
    .addSubcommand((subcommand) => subcommand.setName('delete').setDescription('Delete a snippet')
      .addStringOption((option) => option.setName('name').setDescription('Short name').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('show').setDescription('Show a saved snippet')
      .addStringOption((option) => option.setName('name').setDescription('Short name').setRequired(true)))),
  adminOnly(new SlashCommandBuilder().setName('role-panel').setDescription('Create a button role panel.')
    .addSubcommand((subcommand) => subcommand.setName('create').setDescription('Post a new role panel')
      .addStringOption((option) => option.setName('title').setDescription('Panel title').setRequired(true)))
    .addSubcommand((subcommand) => subcommand.setName('add').setDescription('Add a role button to a panel')
      .addStringOption((option) => option.setName('message_id').setDescription('Message ID of the panel').setRequired(true))
      .addRoleOption((option) => option.setName('role').setDescription('Role to toggle').setRequired(true))
      .addStringOption((option) => option.setName('label').setDescription('Button label').setRequired(true).setMaxLength(80))
      .addStringOption((option) => option.setName('emoji').setDescription('Optional emoji (Unicode only)')))),
  adminOnly(new SlashCommandBuilder().setName('ticket-panel').setDescription('Post a support ticket panel.')
    .addStringOption((option) => option.setName('title').setDescription('Panel title').setRequired(true))),
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

rest
  .put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
    body: commands,
  })
  .then(() => console.log('Registered guild slash commands.'))
  .catch((error) => {
    console.error('Failed to register slash commands:', error);
    process.exitCode = 1;
  });
