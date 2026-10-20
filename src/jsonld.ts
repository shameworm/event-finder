import * as cheerio from 'cheerio';

/**
 * Pull every JSON-LD object out of a page, flattening arrays and @graph.
 * Concert.ua and Karabas both publish full schema.org Event objects this way,
 * which is far more stable than CSS selectors.
 */
export function extractJsonLd(html: string): Record<string, unknown>[] {
  const $ = cheerio.load(html);
  const out: Record<string, unknown>[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // some sites emit trailing commas or stray HTML comments
      try {
        parsed = JSON.parse(raw.replace(/<!--[\s\S]*?-->/g, '').replace(/,\s*([}\]])/g, '$1'));
      } catch {
        return;
      }
    }
    push(parsed, out);
  });
  return out;
}

function push(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) push(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) {
    push(obj['@graph'], out);
    return;
  }
  out.push(obj);
}

/** Keep only schema.org *Event objects. */
export function eventsFromJsonLd(html: string): Record<string, unknown>[] {
  return extractJsonLd(html).filter((o) => {
    const t = o['@type'];
    const type = Array.isArray(t) ? t[0] : t;
    return typeof type === 'string' && /Event$|^Festival$/.test(type.split('/').pop() ?? '');
  });
}
