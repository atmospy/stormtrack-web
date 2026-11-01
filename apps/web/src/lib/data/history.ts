/** CONTRACTS section 2 history index (`storms/history/all-index.json`, also `storms/index.json#history`). */
import { ContractError } from './contracts';

export interface BasinEntry {
  /** IBTrACS basin code (`id` in the contract) */
  code: string;
  name: string;
  count: number;
  year_min: number;
  year_max: number;
  sources: string[];
  /** data-root-relative paths (contract: `file`, `stats`) */
  file: string;
  stats: string;
  bytes: number | null;
  gzip_bytes: number | null;
}
export interface HistoryIndex {
  generated: string | null;
  basins: BasinEntry[];
}
export const BASIN_NAMES: Record<string, string> = {
  NA: 'North Atlantic', EP: 'East Pacific', WP: 'West Pacific', NI: 'North Indian', SI: 'South Indian', SP: 'South Pacific', SA: 'South Atlantic'
};
export const BASIN_ORDER = ['NA', 'EP', 'WP', 'NI', 'SI', 'SP', 'SA'];

/**
 * Tolerant of where the basin map lives: `{basins:{NI:{…}}}`, `{history:{…}}`, `{basins:[{code|basin:'NI',…}]}`
 * or a bare map of basin codes. The contract form is `basins: [{id, name, count, year_min, year_max, file, stats, bytes, gzip_bytes}]`.
 * Each entry needs count, year_min, year_max.
 */
export function parseHistoryIndex(raw: unknown): HistoryIndex {
  const C = 'storms/history/all-index.json';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ContractError(C, '$', 'expected an object');
  const o = raw as Record<string, unknown>;
  const holder = o.basins ?? o.history ?? o;
  const entries: [string, unknown][] = Array.isArray(holder)
    ? holder.map((e, i): [string, unknown] => {
        const eo = e as Record<string, unknown> | null;
        const code = eo?.id ?? eo?.code ?? eo?.basin;
        if (typeof code !== 'string') throw new ContractError(C, `basins[${i}]`, 'array entries need an "id" (basin code) string');
        return [code, e];
      })
    : typeof holder === 'object' && holder !== null
      ? Object.entries(holder as Record<string, unknown>).filter(([k]) => /^[A-Z]{2}$/.test(k))
      : [];
  if (entries.length === 0) throw new ContractError(C, 'basins', 'no basin entries found (expected codes like NI, WP, …)');
  const basins = entries.map(([code, e]): BasinEntry => {
    const p = `basins.${code}`;
    if (typeof e !== 'object' || e === null) throw new ContractError(C, p, 'expected an object');
    const eo = e as Record<string, unknown>;
    const n = (k: string) => {
      const v = eo[k];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new ContractError(C, `${p}.${k}`, `expected a finite number, got ${JSON.stringify(v)}`);
      return v;
    };
    const year_min = n('year_min'), year_max = n('year_max');
    if (year_max < year_min) throw new ContractError(C, p, `year_max (${year_max}) < year_min (${year_min})`);
    const optNum = (k: string) => (typeof eo[k] === 'number' && Number.isFinite(eo[k]) ? (eo[k] as number) : null);
    const rel = (k: string, dflt: string) => {
      const v = eo[k];
      if (v === undefined) return dflt;
      if (typeof v !== 'string' || v === '' || v.startsWith('/') || /^([a-z]+:)?\/\//i.test(v)) throw new ContractError(C, `${p}.${k}`, `must be a path relative to the data root, got ${JSON.stringify(v)}`);
      return v;
    };
    return {
      code,
      name: typeof eo.name === 'string' && eo.name ? eo.name : (BASIN_NAMES[code] ?? code),
      count: n('count'), year_min, year_max,
      sources: Array.isArray(eo.sources) ? eo.sources.filter((s): s is string => typeof s === 'string') : [],
      file: rel('file', `storms/history/${code}.geojson`),
      stats: rel('stats', `storms/stats/${code}.json`),
      bytes: optNum('bytes'), gzip_bytes: optNum('gzip_bytes')
    };
  });
  const rank = (c: string) => (BASIN_ORDER.includes(c) ? BASIN_ORDER.indexOf(c) : 99);
  basins.sort((a, b) => rank(a.code) - rank(b.code));
  return { generated: typeof o.generated === 'string' ? o.generated : null, basins };
}

/** Southern-hemisphere basins label a July-June season by the year it ends (Nov 2026 -> season 2027, shown "2026-27"). */
export const SEASONAL_BASINS = ['SI', 'SP', 'SA'];
export function seasonLabel(year: number, basin: string | null | undefined): string {
  return basin && SEASONAL_BASINS.includes(basin) ? `${year - 1}-${String(year).slice(2)}` : String(year);
}
