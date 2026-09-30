const fs = require('node:fs');
const path = require('node:path');

const filePath = path.join(__dirname, '..', 'data.json');
const DEFAULT_PLUGINS = {
  moderation: true,
  welcomer: true,
  reactionRoles: true,
  customCommands: true,
  logging: true,
  tickets: true,
};
let state = { guilds: {} };

try {
  state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('Could not read data.json; starting with empty settings:', error);
  }
}

function guildData(guildId) {
  state.guilds[guildId] ??= {
    plugins: { ...DEFAULT_PLUGINS },
    settings: {},
    warnings: {},
    tags: {},
    rolePanels: {},
    openTickets: {},
  };
  const data = state.guilds[guildId];
  data.plugins ??= {};
  for (const [name, enabled] of Object.entries(DEFAULT_PLUGINS)) data.plugins[name] ??= enabled;
  data.settings ??= {};
  data.warnings ??= {};
  data.tags ??= {};
  data.rolePanels ??= {};
  data.openTickets ??= {};
  return data;
}

function save() {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2));
  fs.renameSync(temporaryPath, filePath);
}

module.exports = { guildData, save };