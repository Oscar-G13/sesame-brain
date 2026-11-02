import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const common = new Set(readFileSync(resolve('src/web/common-passwords.txt'), 'utf8').split(/\r?\n/).map(s => s.toLowerCase()));
export function passwordError(password: unknown): string | undefined {
  if (typeof password !== 'string' || password.length < 10) return 'Use at least 10 characters.';
  if (password.length > 1024) return 'Use no more than 1,024 characters.';
  if (common.has(password.toLowerCase())) return 'Choose a password that is not on the common-password list.';
}
export function safeNext(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\x00-\x20]/.test(value) ? value : '/account';
}
export function validAgent(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{1,32}$/.test(value) && value !== 'all';
}
export function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
