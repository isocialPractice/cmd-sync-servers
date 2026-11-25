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
  linkNotFollowed: 'Symbolic link skipped: this site does not follow links.',
  linkOutside: 'Leads out of the site, and this site follows only links inside it. Skipped.',
  linkBroken: 'Symbolic link to something that does not exist. Skipped.',
  linkLoop: 'Leads back into a folder above it. Skipped.',
  underLink: 'Inside a linked folder that is not followed. Skipped.',
  throughLinkOutside: 'Reached through a link that leads out of the site.',
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

/**
 * The sentences every front end uses for the synchronization records
 * Dreamweaver keeps in `_notes/dwsync.xml`.
 */
export const DREAMWEAVER_TEXT = {
  /** Asked when a site is set up in a folder that holds the records. */
  question: 'This folder holds Dreamweaver synchronization records (_notes/dwsync.xml).\nUse them, and keep them up to date for Dreamweaver?',
  /** After a look at the whole site that could not tell how Dreamweaver reads the server's clock. */
  clockUnknown: "Dreamweaver's records are not used yet: too few files match them to tell how Dreamweaver reads this server's clock.",
  /** After a look at some paths only, before any sync of the whole site. */
  clockNotLearned: "Dreamweaver's records are not used yet: a sync of the whole site first learns how Dreamweaver reads this server's clock.",
  /** After setup, when the records show nothing in sync. */
  nothingTaken: "Dreamweaver's records show no file in sync with this server.",
} as const;

function files(count: number): string {
  return `${String(count)} ${count === 1 ? 'file' : 'files'}`;
}

/** `Dreamweaver's records: 204 files in sync.`, for a status. */
export function dreamweaverInSync(count: number): string {
  return `Dreamweaver's records: ${files(count)} in sync.`;
}

/**
 * What setting a site up did with Dreamweaver's records: how many files it
 * took as in sync, or why none.
 */
export function dreamweaverTakeOver(adopted: number, clock: 'known' | 'unknown'): string {
  if (clock === 'unknown') {
    return DREAMWEAVER_TEXT.clockUnknown;
  }
  return adopted === 0 ? DREAMWEAVER_TEXT.nothingTaken : `Took ${files(adopted)} as in sync from Dreamweaver's records.`;
}
