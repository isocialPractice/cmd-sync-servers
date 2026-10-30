/**
 * The status texts every front end shows beside a preview row. One place, so
 * the CLI, the terminal UI and the VS Code extension read the same.
 */
export const STATUS = {
  bothChanged: 'Changed locally and on the server since the last sync. Choose Put or Get.',
  changedLocallyDeletedRemotely: 'Changed locally and deleted on the server since the last sync.',
  deletedLocallyChangedRemotely: 'Deleted locally and changed on the server since the last sync.',
  firstSyncDiffers: 'Differs from the server copy and has no sync record. Choose Put or Get.',
  localNewer: 'Changed locally since the last sync. Choose Get to replace it, or Put.',
  remoteNewer: 'Changed on the server since the last sync. Choose Put to replace it, or Get.',
  putRestore: 'Deleted on the server since the last sync. It will be uploaded again.',
  getRestoreBoth: 'Deleted locally since the last sync. It will be downloaded again unless the delete option is checked.',
  getRestore: 'Deleted locally since the last sync. It will be downloaded again.',
  deleteRemoteSynced: 'Deleted locally since the last sync.',
  deleteLocalSynced: 'Deleted on the server since the last sync.',
  deleteRemoteNeverSynced: 'On the server only and never synchronized. Check to delete it.',
  deleteLocalNeverSynced: 'On this computer only and never synchronized. Check to delete it.',
  caseCollision: 'Another file differs from this name only by case. Neither is transferred.',
  caseRename: 'Spelled differently on the other side only by case, which some servers cannot tell apart. Neither is transferred: use one spelling on both sides.',
  symlink: 'Symbolic link skipped.',
  underLink: 'Inside a linked folder, which is never written through. Skipped.',
  notAFile: 'Not a regular file. Skipped.',
  stale: 'Changed since the preview. Skipped.',
} as const;

/** The status of a row held back by the sensitive-file guard. */
export function guardedStatus(pattern: string): string {
  return `Matches the sensitive pattern "${pattern}". Check to transfer anyway.`;
}

/** The status of a name that cannot be used on this system. */
export function unsafeNameStatus(reason: string): string {
  return `Name is not valid on this system: ${reason}.`;
}
