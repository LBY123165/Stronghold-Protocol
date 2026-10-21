// Account-name normalization shared by the title form and the account API.
const ACCOUNT_NAME_RE = /^(?=.*[\p{L}\p{N}])[\p{L}\p{M}\p{N}_.-]{3,24}$/u;

/** Normalize a username and return null unless it has 3–24 supported Unicode characters. */
export function normalizeAccountName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.normalize('NFC').trim();
  return ACCOUNT_NAME_RE.test(name) ? name : null;
}

/** Usernames are case-insensitive; normalize Unicode before forming the storage key. */
export function accountNameKey(raw) {
  const name = normalizeAccountName(raw);
  return name ? name.toLowerCase() : null;
}
