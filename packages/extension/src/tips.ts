/**
 * The popup's one tip, the picker shortcut (critique H3): shown in the footer until the user
 * closes it or opens the picker with drafts in it for the first time.
 */
import type { StorageArea } from './storage.ts';

/** `storage.local` key: true once the picker tip is dismissed. */
export const LOCAL_PICKER_TIP = 'qusme.tips.picker';

export async function pickerTipDismissed(local: StorageArea): Promise<boolean> {
  return (await local.get([LOCAL_PICKER_TIP]))[LOCAL_PICKER_TIP] === true;
}

export async function dismissPickerTip(local: StorageArea): Promise<void> {
  await local.set({ [LOCAL_PICKER_TIP]: true });
}
