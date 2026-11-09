// The public half of the OTA signing key (RSA 2048), the same text as ota/live-update-public.pem
// (tests/native-shell.test.ts checks it); the shell configuration carries it too (capacitor.config.ts).
export const OTA_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2Z4h5nO/kpbo+BTCQtrI',
  'InXU8IeEK9HZCvTzGk7X405EC1fr8NV5tzyyUa91XjjmZkI8aedNdyuE2GcB+O5J',
  'xrxXlPr94IWWC8zbSX8Kyo9thWV5WO2Zi6sdKGxfLs9JOpXZ57w5TNoNfLBuVzjP',
  'WsMG07u3VuyYjFPrLakToTGPeAEUYG1iFp98OpPQWfi0zKIWSMYMfmXR/1b9LyvS',
  'dLUkuL0wL6jz3dSQWe5WtkRFbjCS5/rAB9Z4hw5dbfYAjhQT3JLzv8s+hAOZyzOl',
  'ZC6zL3gGfs2lVuukDg0XmomTmFzKanmejGLt4lfz9axUIu4rCf14YJO/3+ZxlcEr',
  'cQIDAQAB',
  '-----END PUBLIC KEY-----',
].join('\n')
