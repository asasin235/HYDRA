/**
 * Language Detector — detects English, Hindi, Hinglish (mixed-hi-en), or unknown.
 * Uses Devanagari Unicode range detection and Hinglish transliteration markers.
 * @module core/language-detector
 */
import { createLogger } from './logger.js';

const log = createLogger('language-detector');

const DEVANAGARI_REGEX = /[\u0900-\u097F]/;
const LATIN_REGEX = /[a-zA-Z]/;

const HINGLISH_MARKERS = new Set([
  'hai', 'hain', 'kya', 'nahi', 'nahin', 'mein', 'tum', 'aap', 'yeh', 'woh',
  'kaise', 'kyun', 'lekin', 'acha', 'accha', 'theek', 'thik', 'bohot', 'bahut',
  'abhi', 'bhai', 'yaar', 'matlab', 'bilkul', 'sahi', 'chalo', 'dekho',
  'baat', 'karo', 'karna', 'hoga', 'raha', 'rahi', 'wala', 'wali', 'kuch',
  'sab', 'aur', 'agar', 'toh', 'phir', 'isliye', 'kyunki', 'jaise',
  'samajh', 'pata', 'bol', 'bolo', 'suno', 'mujhe', 'tumhe', 'unhe',
  'kaisa', 'kaisi', 'kitna', 'kitni', 'kahan', 'kidhar', 'idhar', 'udhar'
]);

/**
 * Detect language of text.
 * @param {string} text
 * @returns {'en' | 'hi' | 'mixed-hi-en' | 'unknown'}
 */
export function detectLanguage(text) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    log.debug('Empty text, returning unknown');
    return 'unknown';
  }

  const cleaned = text.trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'unknown';

  const hasDevanagari = DEVANAGARI_REGEX.test(cleaned);
  const hasLatin = LATIN_REGEX.test(cleaned);

  let devanagariCount = 0;
  let latinCount = 0;
  for (const char of cleaned) {
    if (DEVANAGARI_REGEX.test(char)) devanagariCount++;
    if (LATIN_REGEX.test(char)) latinCount++;
  }

  const totalScriptChars = devanagariCount + latinCount;
  if (totalScriptChars === 0) return 'unknown';

  const devanagariRatio = devanagariCount / totalScriptChars;
  const latinRatio = latinCount / totalScriptChars;

  const lowerWords = words.map(w => w.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
  const hinglishMarkerCount = lowerWords.filter(w => HINGLISH_MARKERS.has(w)).length;
  const hinglishRatio = lowerWords.length > 0 ? hinglishMarkerCount / lowerWords.length : 0;

  // Pure Devanagari Hindi
  if (devanagariRatio > 0.7 && !hasLatin) {
    log.debug({ devanagariRatio }, 'Detected Hindi (Devanagari)');
    return 'hi';
  }

  // Mixed Devanagari + Latin
  if (hasDevanagari && hasLatin) {
    log.debug({ devanagariRatio, latinRatio }, 'Detected mixed Hindi-English');
    return 'mixed-hi-en';
  }

  // Latin-only but heavy Hinglish markers
  if (latinRatio > 0.8 && hinglishRatio > 0.15) {
    log.debug({ hinglishRatio }, 'Detected Hinglish (transliterated)');
    return 'mixed-hi-en';
  }

  // Predominantly Devanagari with minor Latin
  if (devanagariRatio > 0.5) {
    log.debug({ devanagariRatio }, 'Detected Hindi (majority Devanagari)');
    return 'hi';
  }

  // Default to English for Latin-dominant text
  if (latinRatio > 0.5) {
    log.debug({ latinRatio }, 'Detected English');
    return 'en';
  }

  log.debug('Language uncertain, returning unknown');
  return 'unknown';
}

/**
 * Detect language with confidence score.
 * @param {string} text
 * @returns  language: string, confidence: number 
 */
export function detectLanguageWithConfidence(text) {
  const language = detectLanguage(text);

  if (!text || text.trim().length === 0) {
    return { language: 'unknown', confidence: 0 };
  }

  const cleaned = text.trim();
  let devanagariCount = 0;
  let latinCount = 0;
  for (const char of cleaned) {
    if (DEVANAGARI_REGEX.test(char)) devanagariCount++;
    if (LATIN_REGEX.test(char)) latinCount++;
  }
  const total = devanagariCount + latinCount;

  let confidence = 0;
  switch (language) {
    case 'hi':
      confidence = total > 0 ? Math.min(devanagariCount / total + 0.1, 1.0) : 0;
      break;
    case 'en':
      confidence = total > 0 ? Math.min(latinCount / total + 0.1, 1.0) : 0;
      break;
    case 'mixed-hi-en':
      confidence = 0.7;
      break;
    default:
      confidence = 0;
  }

  return { language, confidence: Math.round(confidence * 100) / 100 };
}

/**
 * Batch detect languages for multiple texts.
 * @param {string[]} texts
 * @returns {Array<{ text: string, language: string, confidence: number }>}
 */
export function detectLanguages(texts) {
  return (texts || []).map(text => ({
    text: (text || '').substring(0, 100),
    ...detectLanguageWithConfidence(text),
  }));
}
