/**
 * The extension's required permissions (spec 11.2), and nothing else: no host permissions for any
 * site the user posts to and no `tabs`. Page access comes from activeTab, after a user gesture.
 */
export const PERMISSIONS = ['activeTab', 'scripting', 'contextMenus', 'storage'] as const;
