/**
 * The extension's required permissions (spec 11.2), and nothing else: no host permissions for any
 * site the user posts to and no `tabs`. Page access comes from activeTab, after a user gesture.
 * `alarms` drives sync while the queue is unlocked (11.4); it shows the user no permission warning.
 */
export const PERMISSIONS = ['activeTab', 'scripting', 'contextMenus', 'storage', 'alarms'] as const;

/** The qus.me service (spec 8.5). Pairing by typed code talks to it (8.3). */
export const SERVICE_ORIGIN = 'https://app.qus.me';

/**
 * The one optional host permission (spec 11.2): the service origin, requested at the moment a
 * typed pairing code or an approval code is used, an agent is approved or revoked, never at
 * install. Relay websockets need no host permission.
 */
export const OPTIONAL_HOST_PERMISSIONS = [`${SERVICE_ORIGIN}/*`] as const;
