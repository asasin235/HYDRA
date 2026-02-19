import crypto from 'crypto';
import axios from 'axios';

export function generateApiKey() {
  return crypto.randomBytes(32).toString('hex');
}

export function validateRequest(req, res, next) {
  try {
    const header = req.headers['authorization'] || req.headers['Authorization'];
    const expected = process.env.INTERNAL_API_KEY;
    if (!expected) {
      console.error('[auth] INTERNAL_API_KEY is not set');
      return res.status(500).json({ error: 'Server misconfigured' });
    }
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const key = header.slice(7).trim();
    if (key !== expected) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  } catch (error) {
    console.error('[auth] validateRequest error:', error.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}

export async function signedFetch(url, options = {}) {
  try {
    const key = process.env.INTERNAL_API_KEY;
    if (!key) throw new Error('INTERNAL_API_KEY not set');

    const instance = axios.create({
      headers: {
        Authorization: `Bearer ${key}`,
        ...(options.headers || {})
      },
      timeout: options.timeout || 15000
    });

    const method = (options.method || 'GET').toUpperCase();
    const data = options.data || options.body || undefined;

    const res = await instance.request({ url, method, data, params: options.params });
    return res.data;
  } catch (error) {
    console.error('[auth] signedFetch error:', error.message);
    throw error;
  }
}
