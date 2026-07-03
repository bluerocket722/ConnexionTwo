/* Connexion Two — client-side encryption (WebCrypto, AES-256-GCM).
 *
 * End-to-end-at-rest: files are encrypted in the browser with a key derived from
 * the user's passphrase (PBKDF2-SHA-256). The passphrase and the derived key
 * NEVER leave the device — the server only ever stores ciphertext.
 *
 * Container format (all binary, prepended to the ciphertext):
 *   bytes 0..3   magic "C2E1"
 *   bytes 4..19  salt   (16 bytes, per-file, for PBKDF2)
 *   bytes 20..31 iv     (12 bytes, per-file, for AES-GCM)
 *   bytes 32..   ciphertext (includes the GCM auth tag)
 */
window.C2Crypto = (function () {
  const PBKDF2_ITERATIONS = 210000;   // OWASP-recommended floor for PBKDF2-SHA256
  const MAGIC = [0x43, 0x32, 0x45, 0x31]; // "C2E1"
  const enc = new TextEncoder();

  async function deriveKey(passphrase, salt) {
    const base = await crypto.subtle.importKey(
      'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  // bytes: ArrayBuffer | Uint8Array  ->  Uint8Array (encrypted container)
  async function encryptBytes(passphrase, bytes) {
    if (!passphrase) throw new Error('A passphrase is required to encrypt.');
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv   = crypto.getRandomValues(new Uint8Array(12));
    const key  = await deriveKey(passphrase, salt);
    const ct   = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
    const out  = new Uint8Array(4 + 16 + 12 + ct.length);
    out.set(MAGIC, 0);
    out.set(salt, 4);
    out.set(iv, 20);
    out.set(ct, 32);
    return out;
  }

  // packed: ArrayBuffer | Uint8Array (container)  ->  Uint8Array (plaintext)
  async function decryptBytes(passphrase, packed) {
    const buf = packed instanceof Uint8Array ? packed : new Uint8Array(packed);
    if (buf.length < 32 || buf[0] !== MAGIC[0] || buf[1] !== MAGIC[1] || buf[2] !== MAGIC[2] || buf[3] !== MAGIC[3]) {
      throw new Error('This is not a Connexion Two encrypted file.');
    }
    const salt = buf.slice(4, 20);
    const iv   = buf.slice(20, 32);
    const ct   = buf.slice(32);
    const key  = await deriveKey(passphrase, salt);
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
      return new Uint8Array(pt);
    } catch (_) {
      // GCM auth-tag failure = wrong passphrase or tampered file
      throw new Error('Wrong passphrase, or the file has been altered.');
    }
  }

  return { encryptBytes, decryptBytes, PBKDF2_ITERATIONS };
})();
