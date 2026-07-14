// At-rest encryption for stored OAuth tokens (AES-256-GCM). The key is a 32-byte
// hex string in PLUGIN_ENC_KEY (openssl rand -hex 32). Ciphertext is stored as
// "iv.tag.data" (all base64). Without a key we fail CLOSED — refuse to persist a
// clear-text token — rather than silently store secrets in the clear.
import crypto from 'node:crypto';

function key() {
  const hex = process.env.PLUGIN_ENC_KEY || '';
  if (hex.length !== 64) {
    throw new Error('PLUGIN_ENC_KEY must be a 32-byte hex string (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join('.');
}

export function decrypt(blob) {
  if (!blob) return '';
  const [ivB64, tagB64, dataB64] = String(blob).split('.');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
