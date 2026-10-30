import type { Server, Site } from '../../config/schema.ts';
import type { Action, Direction } from '../../sync/types.ts';
import { span, symbols, type Line, type Theme } from '../style.ts';
import { padEnd, truncate } from '../text.ts';

const PROTOCOL_LABELS: Readonly<Record<string, string>> = {
  sftp: 'SFTP',
  ftps: 'FTPS',
  'ftps-implicit': 'FTPS implicit',
  ftp: 'FTP insecure',
  local: 'Local/Network',
};

export function protocolName(protocol: string): string {
  return PROTOCOL_LABELS[protocol] ?? protocol;
}

export function serverAddress(server: Server): string {
  if (server.protocol === 'local') {
    return server.remoteRoot;
  }
  return server.port === undefined ? (server.host ?? '') : `${server.host ?? ''}:${String(server.port)}`;
}

export function remoteServer(site: Site): Server | undefined {
  return site.servers.find((server) => server.id === site.remoteServerId);
}

export { DIRECTION_TITLES } from '../../sync/types.ts';

/** The delete option, worded for the direction as Dreamweaver words it. */
export function deleteLabel(direction: Direction): string {
  return direction === 'get' ? 'Delete local files not on remote server' : 'Delete remote files not on local drive';
}

const ACTION_LABELS: Readonly<Record<Action, string>> = {
  put: 'Put',
  get: 'Get',
  resolve: 'Resolve',
  'delete-remote': 'Delete',
  'delete-local': 'Delete',
  skip: 'Skip',
  synced: 'Synced',
};

/** The symbol and word of an action, such as `^ Put`; the word always carries the meaning. */
export function actionCell(action: Action, theme: Theme): string {
  const sym = symbols(theme);
  const glyph: Readonly<Record<Action, string>> = {
    put: sym.put,
    get: sym.get,
    resolve: sym.resolve,
    'delete-remote': sym.remove,
    'delete-local': sym.remove,
    skip: sym.skip,
    synced: sym.synced,
  };
  return `${glyph[action]} ${padEnd(ACTION_LABELS[action], 7)}`;
}

/** A row of a table, the whole row inverse when focused. */
export function tableRow(cells: readonly string[], widths: readonly number[], width: number, focused: boolean, theme: Theme): Line {
  const text = `  ${cells.map((cell, index) => (index === cells.length - 1 ? cell : padEnd(truncate(cell, widths[index] ?? 0, symbols(theme).ellipsis), widths[index] ?? 0))).join('  ')}`;
  return [span(padEnd(text, width), focused ? 'focus' : undefined)];
}

export function headerRow(cells: readonly string[], widths: readonly number[]): Line {
  return [span(`  ${cells.map((cell, index) => (index === cells.length - 1 ? cell : padEnd(cell, widths[index] ?? 0))).join('  ')}`, 'dim')];
}

/** `2026-10-29 12:00 UTC`, or `never`. */
export function when(ms: number | undefined): string {
  return ms === undefined ? 'never' : `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}
