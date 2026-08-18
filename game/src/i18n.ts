/**
 * Localisation.
 *
 * docs/SYSTEMS.md §16 calls this trivial and insists on doing it early anyway —
 * not because it is urgent, but because writing t('unit.laborer.name') costs
 * nothing now and retrofitting it across a finished UI is tedious.
 *
 * Arabic is treated as a first-class target from the start, which for a
 * Qatar-themed game is the obvious call. In practice that means three things,
 * all of which are free if chosen early and painful later:
 *
 *   1. CSS logical properties everywhere (margin-inline-start, never
 *      margin-left), so `dir="rtl"` flips the layout correctly.
 *   2. UI text lives in the DOM, not in PixiJS. The browser's text engine
 *      handles Arabic shaping and bidi correctly; canvas text rendering
 *      frequently does not.
 *   3. A font with real Arabic shaping. Latin-only fonts render Arabic as
 *      disconnected letterforms.
 */

import en from './locales/en.json'
import ar from './locales/ar.json'

export type Locale = 'en' | 'ar'

const CATALOGUES: Record<Locale, Record<string, string>> = {
  en: en as Record<string, string>,
  ar: ar as Record<string, string>,
}

export const RTL_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['ar'])

let current: Locale = 'en'

export function setLocale(locale: Locale): void {
  current = locale
  const rtl = RTL_LOCALES.has(locale)
  document.documentElement.lang = locale
  document.documentElement.dir = rtl ? 'rtl' : 'ltr'
}

export function getLocale(): Locale {
  return current
}

/**
 * Look up a key. Falls back to English, then to the key itself — a visible key
 * is a better failure than an empty string, because it tells you what is missing.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const raw = CATALOGUES[current][key] ?? CATALOGUES.en[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
}

/**
 * Format a number for the active locale.
 *
 * Both Western (0-9) and Eastern Arabic (٠-٩) numerals are used in Qatar, so
 * this is a presentation choice rather than a correctness one. Defaulting to
 * Western numerals for resource counts because they are what players of this
 * genre expect at a glance; switching is a one-line change here.
 */
export function formatNumber(n: number): string {
  return new Intl.NumberFormat(current === 'ar' ? 'ar-QA-u-nu-latn' : 'en-US').format(n)
}
