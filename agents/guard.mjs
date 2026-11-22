// Guard — rights classes, spoiler/leak/embargo flags, caption rules,
// source scoring. Authority order: user statement > spec > tests > code.
export const RIGHTS_CLASSES = ['owned', 'permitted', 'licensed', 'reference'];
export const SPOILER_WORDS = [
  'spoiler', 'ending', 'twist ending', 'dies at the end', 'killed off', 'final twist',
  'leak', 'leaked', 'embargo', 'unreleased', 'secret ending', 'plot twist',
  'who dies', 'the killer is', 'reveals the ending',
];
export const HOOK_WORDS = [
  'you', 'secret', 'nobody', 'stop', 'why', 'how', 'mistake', 'free', 'first',
  'never', 'always', 'truth', 'hack', 'insane', 'crazy', 'everyone', 'misses',
  'changes everything', 'tells you', 'watch this', 'before you',
];

export function validateJobInput(input) {
  const errors = [];
  if (!input) return ['no input'];
  const hasUrl = !!(input.sourceUrl && String(input.sourceUrl).trim());
  const hasFile = !!(input.sourceFile && String(input.sourceFile).trim());
  if (!hasUrl && !hasFile) errors.push('a video link or an uploaded file is required');
  if (hasUrl) {
    let u;
    try { u = new URL(input.sourceUrl); } catch { errors.push('sourceUrl is not a valid URL'); }
    if (u && !['http:', 'https:'].includes(u.protocol)) errors.push('sourceUrl must be http(s)');
    // Rights first: a URL job needs rightsConfirmed:true and a stored basis.
    if (input.rightsConfirmed !== true) errors.push('rights confirmation is required for a URL job — tick "I own this video or have the rights to clip and repost it"');
    if (!RIGHTS_CLASSES.includes(input.rightsBasis)) errors.push(`rightsBasis must be one of ${RIGHTS_CLASSES.join(', ')}`);
    if (input.rightsBasis === 'reference') errors.push('reference sources are shown as a link and are never downloaded — pick owned, permitted or licensed to clip');
  }
  if (input.formats && !input.formats.every(f => ['9:16', '1:1', '16:9'].includes(f))) errors.push('formats must be 9:16, 1:1 or 16:9');
  if (input.resolutions && !input.resolutions.every(r => ['1080p', '4K', '8K'].includes(r))) errors.push('resolutions must be 1080p, 4K or 8K');
  if (input.telegramChatId && !/^(-?[0-9]+|@[A-Za-z0-9_]{5,})$/.test(String(input.telegramChatId).trim())) errors.push('telegramChatId must be a Telegram chat id (e.g. -1001234567890) or @channel username');
  return errors;
}

export function isExpired(permission) {
  if (!permission?.expires) return false;
  return new Date(permission.expires) < new Date();
}

// An expired permission is treated as reference-only, never clippable.
export function effectiveRightsBasis(permission) {
  if (!permission) return 'reference';
  if (isExpired(permission)) return 'reference';
  return permission.basis || 'permitted';
}

export function flagText(text) {
  const lower = String(text || '').toLowerCase();
  const spoilerRisk = SPOILER_WORDS.some(w => lower.includes(w));
  const leakRisk = lower.includes('leak') || lower.includes('embargo') || lower.includes('unreleased');
  return { spoilerRisk, leakRisk };
}

// score = 0.4*velocity + 0.3*engagement + 0.2*fit + 0.1*rights,
// and 0 whenever rights < 1 — an unauthorised source never ranks.
export function scoreSource({ velocity = 0, engagement = 0, fit = 0, rights = 0 }) {
  if (rights < 1) return 0;
  const clamp01 = v => Math.max(0, Math.min(1, v));
  return +(0.4 * clamp01(velocity) + 0.3 * clamp01(engagement) + 0.2 * clamp01(fit) + 0.1 * clamp01(rights)).toFixed(3);
}

export function scoreSentence(text, index, total) {
  const lower = String(text || '').toLowerCase();
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  let s = 0.35;
  const hits = HOOK_WORDS.filter(w => lower.includes(w)).length;
  s += Math.min(0.3, hits * 0.12);
  if (words.length >= 6 && words.length <= 28) s += 0.15; // good spoken length
  if (/[?!]/.test(text)) s += 0.08;
  if (index === 0) s += 0.05; // opening hook matters
  if (index === total - 1) s -= 0.05;
  return Math.max(0, Math.min(1, +s.toFixed(3)));
}

export function writeCaption({ text, hashtags = [], platform = 'YouTube', sponsored = false }) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('caption text is required');
  const maxTags = platform === 'YouTube' ? 5 : platform === 'Instagram' ? 8 : 3;
  const tags = hashtags.slice(0, maxTags);
  let caption = text.trim();
  if (caption.length > 120) throw new Error('caption must be 120 characters or fewer');
  if (sponsored) {
    if (!caption.startsWith('Ad:')) throw new Error('sponsored captions must start with "Ad:"');
  }
  const flags = flagText(caption);
  if (flags.spoilerRisk || flags.leakRisk) throw new Error('caption contains a spoiler or leak flag and must not be published');
  return { caption, hashtags: tags, platform };
}

export function approvalChecklistValid(checklist) {
  return Array.isArray(checklist) && checklist.length === 6 && checklist.every(Boolean);
}

export const APPROVAL_CHECKLIST = [
  'Is the footage mine or authorised?',
  'No ending, twist or embargoed reveal?',
  'Hook in the first two seconds?',
  'Captions readable on a phone?',
  'Caption has no false claim?',
  'Disclosure added if sponsored?',
];
