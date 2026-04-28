import { truncateToWidth } from '@mariozechner/pi-tui';

export const WORKTREE_OVERLAY = {
  overlay: true,
  overlayOptions: {
    width: '58%',
    minWidth: 58,
    maxHeight: '72%',
    anchor: 'center',
  },
} as const;

export function borderTop(w: number, theme: any): string {
  return theme.fg('border', `┌${'─'.repeat(Math.max(0, w - 2))}┐`);
}

export function borderBottom(w: number, theme: any): string {
  return theme.fg('border', `└${'─'.repeat(Math.max(0, w - 2))}┘`);
}

export function borderMid(w: number, theme: any): string {
  return theme.fg('border', `├${'─'.repeat(Math.max(0, w - 2))}┤`);
}

export function borderLine(text: string, w: number, theme: any): string {
  const bdr = theme.fg('border', '│');
  const maxC = Math.max(0, w - 4);
  return bdr + ' ' + truncateToWidth(text + ' '.repeat(maxC), maxC) + ' ' + bdr;
}

export function visibleLen(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, '').length;
}

export function ellipsis(text: string, maxVisible: number): string {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= maxVisible) return text;
  return plain.slice(0, Math.max(0, maxVisible - 1)) + '…';
}

export function valueLine(theme: any, label: string, value: string, color: string = 'text'): string {
  return `${theme.fg('muted', label.padEnd(13))} ${theme.fg(color, value)}`;
}

export function boolMark(theme: any, value: unknown): string {
  return value ? theme.fg('success', '✓') : theme.fg('dim', '✗');
}

export function shortPath(path: string, max = 64): string {
  if (path.length <= max) return path;
  return '…' + path.slice(-(max - 1));
}
