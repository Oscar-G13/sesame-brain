import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(process.cwd() + '/package.json', 'utf8'));
const baseUrl = (process.env.BASE_URL ?? 'https://brain.arxsable.ai').replace(/\/$/, '');
if (process.env.NODE_ENV === 'production' && (!baseUrl.startsWith('https://') || !process.env.SESSION_SECRET || !process.env.TOKEN_PEPPER)) throw new Error('Production requires HTTPS BASE_URL, SESSION_SECRET and TOKEN_PEPPER');
export const config = Object.freeze({ name: 'Brain', baseUrl, resource: baseUrl + '/mcp', version: pkg.version as string, sessionSecret: process.env.SESSION_SECRET ?? 'development-session-secret-not-for-production', tokenPepper: process.env.TOKEN_PEPPER ?? 'development-pepper-not-for-production', production: process.env.NODE_ENV === 'production', e2eEnabled: process.env.E2E_ENABLED === 'true', port: Number(process.env.PORT ?? 3000) });
