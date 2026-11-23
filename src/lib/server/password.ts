// #211: per-user password hashing, policy and generation — Web Crypto only (Workers-native).
//
// Hash format: `pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>` (16-byte salt, 32-byte key).
// Iterations are 100,000: workerd refuses PBKDF2 above that ("iteration counts above 100000 are
// not supported"), so the 310,000 OWASP figure can't run here. The count is stored per hash, so
// `needsRehash` upgrades old hashes on the next successful sign-in if this ever moves.

import { safeEqual } from './auth';

export const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;
const PREFIX = 'pbkdf2-sha256';

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
/** Longest input the KDF is run on at sign-in; anything longer is rejected (still via the KDF). */
const VERIFY_MAX = 1024;

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
	let str = '';
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(s)) return null;
	try {
		const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	} catch {
		return null;
	}
}

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		key,
		KEY_BITS
	);
	return new Uint8Array(bits);
}

type ParsedHash = { iterations: number; salt: Uint8Array<ArrayBuffer>; hash: string };

function parseHash(stored: string | null | undefined): ParsedHash | null {
	if (!stored) return null;
	const parts = stored.split('$');
	if (parts.length !== 4 || parts[0] !== PREFIX) return null;
	const iterations = Number(parts[1]);
	if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return null;
	const salt = fromB64url(parts[2]);
	const hash = fromB64url(parts[3]);
	if (!salt || salt.length < SALT_BYTES || !hash || hash.length !== KEY_BITS / 8) return null;
	return { iterations, salt, hash: parts[3] };
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
	const salt = new Uint8Array(SALT_BYTES);
	crypto.getRandomValues(salt);
	const hash = await derive(password, salt, iterations);
	return `${PREFIX}$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

// Used when there's no (valid) stored hash, so a missing user / GitHub-only user costs the
// same KDF time as a real one — sign-in timing doesn't reveal which usernames have passwords.
const DUMMY_SALT = new Uint8Array(SALT_BYTES);
const DUMMY_HASH = 'A'.repeat(43);

/** True when `password` matches `stored`. Always runs the KDF, even when `stored` is null. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
	const parsed = parseHash(stored);
	const tooLong = password.length > VERIFY_MAX;
	const candidate = b64url(
		await derive(
			tooLong ? '' : password,
			parsed?.salt ?? DUMMY_SALT,
			parsed?.iterations ?? PBKDF2_ITERATIONS
		)
	);
	const match = safeEqual(candidate, parsed?.hash ?? DUMMY_HASH);
	return !!parsed && !tooLong && match;
}

/** True when a stored hash should be replaced on the next successful sign-in. */
export function needsRehash(stored: string | null | undefined): boolean {
	const parsed = parseHash(stored);
	return !parsed || parsed.iterations < PBKDF2_ITERATIONS;
}

// No 0/O, 1/l/I — readable aloud and when copied by hand.
export const GENERATED_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 20 random characters grouped `xxxxx-xxxxx-xxxxx-xxxxx` (~117 bits). */
export function generatePassword(): string {
	const n = GENERATED_ALPHABET.length;
	const limit = 256 - (256 % n); // rejection sampling keeps every character equally likely
	const chars: string[] = [];
	const buf = new Uint8Array(32);
	while (chars.length < 20) {
		crypto.getRandomValues(buf);
		for (const b of buf) {
			if (b >= limit) continue;
			chars.push(GENERATED_ALPHABET[b % n]);
			if (chars.length === 20) break;
		}
	}
	return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

// The most common passwords from public breach lists, lowercased. Most are already under the
// 12-character minimum; the longer ones are the reason this list exists.
const COMMON_PASSWORDS = new Set(
	`123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball
abc123 football monkey letmein 696969 shadow master 666666 qwertyuiop 123321 mustang 1234567890
michael 654321 superman 1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan
jennifer zxcvbnm asdfgh hunter buster soccer harley batman andrew tigger sunshine iloveyou
2000 charlie robert thomas hockey ranger daniel starwars klaster 112233 george computer
michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 freedom 777777 pass maggie 159753
aaaaaa ginger princess joshua cheese amanda summer love ashley nicole chelsea biteme matthew
access yankees 987654321 dallas austin thunder taylor matrix minecraft william corvette hello
martin heather secret merlin diamond 1234qwer gfhjkm hammer silver 222222 88888888 anthony
justin test bailey q1w2e3r4t5 patrick internet scooter orange 11111 golfer cookie richard
samantha bigdog guitar jackson whatever mickey chicken sparky snoopy maverick phoenix camaro
peanut morgan welcome falcon cowboy ferrari samsung andrea smokey steelers joseph mercedes
dakota arsenal eagles melissa boomer booboo spider nascar monster tigers yellow xxxxxx
123123123 gateway marina diablo bulldog qwer1234 compaq purple hardcore banana junior hannah
123654 porsche lakers iceman money cowboys 987654 london tennis 999999 ncc1701 coffee scooby
0000 miller boston q1w2e3r4 brandon yamaha chester mother forever johnny edward 333333
oliver redsox player nikita knight fender barney midnight please brandy chicago badboy
slayer rangers charles angel flower rabbit wizard jasper enter rachel chris steven
winner adidas victoria natasha 1q2w3e4r jasmine winter prince marine ghbdtn fishing
cocacola casper james 232323 raiders 888888 marlboro gandalf asdfasdf crystal 87654321
12344321 golden 8675309 password1 password12 password123 password1234 passw0rd p@ssw0rd
p@ssword123 qwerty123 qwerty1234 qwertyuiop123 qwertyuiopas 123456789012 1234567890123
12345678910 111111111111 000000000000 123123123123 abcdefghijkl abcd1234abcd iloveyou1234
iloveyou123 letmein12345 letmein123456 welcome12345 welcome123456 changeme changeme123
changeme1234 administrator admin12345678 admin123456789 superman1234 baseball1234
football1234 starwars1234 trustno1trustno1 sunshine1234 princess1234 monkey123456
dragon123456 qazwsxedcrfv 1qaz2wsx3edc 1q2w3e4r5t6y zaq12wsxcde3 q1w2e3r4t5y6
correcthorsebatterystaple passwordpassword aaaaaaaaaaaa asdfghjklqwe`
		.split(/\s+/)
		.filter(Boolean)
);

/** Policy for a user-chosen password; returns the inline error, or null when it's acceptable. */
export function passwordPolicyError(password: string, username: string): string | null {
	if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
	if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
	const lower = password.toLowerCase();
	if (username && lower === username.trim().toLowerCase()) return "Your password can't be your username.";
	if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Pick something less guessable.';
	return null;
}

/** 'YYYY-MM-DD HH:MM:SS.SSS' (UTC) — the `password_set_at` stamp, millisecond precision. */
export function credentialStamp(ms = Date.now()): string {
	return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** Parse a `password_set_at` stamp (or any SQLite UTC datetime) to epoch ms; NaN when unset/bad. */
export function parseStamp(s: string | null | undefined): number {
	if (!s) return NaN;
	return Date.parse(s.replace(' ', 'T') + 'Z');
}
