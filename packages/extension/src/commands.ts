/**
 * The extension's keyboard command (spec 11.5): opens the draft picker at the focused field. A
 * command grants activeTab in Chrome and Firefox, so it needs no permission beyond spec 11.2.
 * Chrome lets the user rebind it at chrome://extensions/shortcuts, Firefox in about:addons.
 */
export const PICKER_COMMAND = 'open-picker';

/** The suggested shortcut; the user's binding may differ or be empty. */
export const PICKER_SHORTCUT = 'Alt+Q';

/** The `commands` manifest key. */
export const COMMANDS = {
  [PICKER_COMMAND]: {
    suggested_key: { default: PICKER_SHORTCUT },
    description: 'Pick a draft to insert into the focused field',
  },
} as const;
