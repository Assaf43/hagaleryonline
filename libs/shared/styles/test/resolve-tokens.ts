import { fileURLToPath } from 'node:url';
import { compile } from 'sass';
import postcss, { type AtRule, type Container, type Rule } from 'postcss';

export type Scope = 'light' | 'dark' | 'light@768' | 'light@1024';
export type Resolved = Record<Scope, Record<string, string>>;

const TOKENS_FILE = fileURLToPath(new URL('../_tokens.scss', import.meta.url));
const SEMANTIC = /^--(color-|font-|space-|radius-|duration-|ease|gutter|content-max|shadow-)/;

type Decls = Record<string, string>;

export interface ParsedTokens {
  root: Decls;
  dark: Decls;
  at768: Decls;
  at1024: Decls;
}

function declsOf(container: Container): Decls {
  const out: Decls = {};
  container.each((node) => {
    if (node.type === 'decl') out[node.prop] = node.value;
  });
  return out;
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, '').replace(/["']/g, '');
}

export function parseTokens(): ParsedTokens {
  const css = compile(TOKENS_FILE).css;
  const parsed: ParsedTokens = { root: {}, dark: {}, at768: {}, at1024: {} };
  postcss.parse(css).each((node) => {
    if (node.type === 'rule') {
      const rule = node as Rule;
      const sel = normalizeSelector(rule.selector);
      if (sel === ':root') Object.assign(parsed.root, declsOf(rule));
      else if (sel === ':root[data-theme=dark]') Object.assign(parsed.dark, declsOf(rule));
    } else if (node.type === 'atrule') {
      const at = node as AtRule;
      const params = at.params.replace(/\s+/g, '');
      const target = /width>=768px/.test(params) ? parsed.at768 : /width>=1024px/.test(params) ? parsed.at1024 : null;
      if (!target) return;
      at.each((child) => {
        if (child.type === 'rule' && normalizeSelector((child as Rule).selector) === ':root') {
          Object.assign(target, declsOf(child as Rule));
        }
      });
    }
  });
  return parsed;
}

/** Replaces every var(--x[, fallback]) using `scope`, recursively. */
function substitute(value: string, scope: Decls, seen: string[] = []): string {
  let result = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('var(', i);
    if (start === -1) {
      result += value.slice(i);
      break;
    }
    result += value.slice(i, start);
    let depth = 1;
    let j = start + 4;
    while (j < value.length && depth > 0) {
      if (value[j] === '(') depth++;
      else if (value[j] === ')') depth--;
      j++;
    }
    const inner = value.slice(start + 4, j - 1);
    const comma = inner.indexOf(',');
    const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma === -1 ? undefined : inner.slice(comma + 1).trim();
    if (seen.includes(name)) throw new Error(`Circular token reference: ${[...seen, name].join(' -> ')}`);
    if (name in scope) result += substitute(scope[name], scope, [...seen, name]);
    else if (fallback !== undefined) result += substitute(fallback, scope, seen);
    else throw new Error(`Unresolved token ${name}`);
    i = j;
  }
  return result;
}

function tidy(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/#[0-9a-fA-F]{3,8}\b/g, (hex) => hex.toLowerCase());
}

function resolveScope(scope: Decls): Decls {
  const out: Decls = {};
  for (const [prop, value] of Object.entries(scope)) out[prop] = tidy(substitute(value, scope));
  return out;
}

export async function resolveAll(): Promise<Resolved> {
  const { root, dark, at768, at1024 } = parseTokens();
  const light = { ...root };
  const darkScope = { ...light, ...dark };
  const l768 = { ...light, ...at768 };
  const l1024 = { ...l768, ...at1024 };
  const keep = (d: Decls): Decls =>
    Object.fromEntries(Object.entries(resolveScope(d)).filter(([k]) => k.startsWith('--') || k === 'color-scheme'));
  return { light: keep(light), dark: keep(darkScope), 'light@768': keep(l768), 'light@1024': keep(l1024) };
}

export async function resolveTokens(): Promise<Resolved> {
  const all = await resolveAll();
  const out = {} as Resolved;
  for (const scope of Object.keys(all) as Scope[]) {
    out[scope] = Object.fromEntries(
      Object.entries(all[scope])
        .filter(([k]) => SEMANTIC.test(k) || k === 'color-scheme')
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return out;
}
