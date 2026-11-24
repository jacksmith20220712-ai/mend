// main.ts — mend: one patch tool for every AI edit format.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Reads the patch from PATCH, or from standard input when PATCH is absent
// or "-". Edits are applied to the tree in the working directory.
//
// Exit codes:
//   0  success; stdout lists the paths that changed, then "ok: N file(s)".
//   1  one or more edits failed; stdout lists each failure, then
//      "failed: K of N edits". Nothing is written.
//   2  usage error, unreadable patch, unknown format, or parse error;
//      stdout holds exactly one line. Nothing is written.
//
// The trial harness (runner.ts) hands over to this file; the last lines of
// this file keep that hand-over and the no-run-as-script guard, so runner.ts
// and check.ts keep working unchanged.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;
type Format = (typeof FORMATS)[number];

class Exit2 {
  readonly line: string;
  constructor(line: string) { this.line = line; }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) { this.code = code; this.path = path; }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    if (this.now.has(p)) return this.now.get(p)!;
    return this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------------- file line model (SPEC section 3) ---------------- */

interface FileModel { lines: string[]; br: string; finalBreak: boolean; }

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/* ---------------- tier matching (SPEC section 5) ---------------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) if (!lineEq(lines[i + k]!, o[k]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function findTierSingle(lines: string[], anchor: string, strict: boolean, from: number): number | null {
  const found = findTier(lines, [anchor], strict, from);
  return found === null ? null : found.occ[0]!;
}

/** A line of N. For context lines, oIdx is the index of the matching line in O. */
interface NLine { text: string; context: boolean; oIdx: number; }

/**
 * Replace the k matched lines at pos with N. Context lines take the file's
 * own text; at tier 2 the other lines are re-indented (the leading
 * spaces/tabs of O's first line are replaced by those of the file's first
 * matched line).
 */
function applyReplace(m: FileModel, o: string[], n: NLine[], tier: number, pos: number): FileModel {
  const F = o.length > 0 ? leadWs(m.lines[pos]!) : '';
  const P = o.length > 0 ? leadWs(o[0]!) : '';
  const out: string[] = [];
  for (const nl of n) {
    if (nl.context) { out.push(m.lines[pos + nl.oIdx]!); continue; }
    let t = nl.text;
    if (tier === 2 && o.length > 0 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return { lines: [...m.lines.slice(0, pos), ...out, ...m.lines.slice(pos + o.length)], br: m.br, finalBreak: m.finalBreak };
}

/* ---------------- format detection (SPEC section 4) ---------------- */

function detect(lines: string[]): Format {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return 'auto';
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return 'auto';
}

/* ---------------- JSON (SPEC section 9) ---------------- */

function jsonEdit(e: unknown, first: number): Edit | null {
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return null;
  const r = e as Record<string, unknown>;
  const cmd = r.command;
  const p = r.path;
  if (typeof p !== 'string') return null;
  if (cmd === 'create') {
    if (typeof r.file_text !== 'string') return null;
    const text = r.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (cmd === 'str_replace') {
    if (typeof r.old_str !== 'string' || r.old_str === '') return null;
    if (r.new_str !== undefined && typeof r.new_str !== 'string') return null;
    const oldStr = r.old_str;
    const newStr = (r.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const hasCrLf = cur.includes('\r\n');
      const text = hasCrLf ? cur.split('\r\n').join('\n') : cur;
      let at = -1;
      let count = 0;
      let from = 0;
      while (true) {
        const ix = text.indexOf(oldStr, from);
        if (ix < 0) break;
        if (at < 0) at = ix;
        count++;
        from = ix + 1;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      let next = text.slice(0, at) + newStr + text.slice(at + oldStr.length);
      if (hasCrLf) next = next.split('\n').join('\r\n');
      tree.now.set(p, next);
    };
  }
  if (cmd === 'insert') {
    if (typeof r.insert_line !== 'number' || !Number.isInteger(r.insert_line)) return null;
    if (typeof r.new_str !== 'string') return null;
    const lineNo = r.insert_line;
    const newStr = r.new_str;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const m = parseFile(cur);
      if (lineNo < 0 || lineNo > m.lines.length) throw new Fail('no-match', p);
      const added = parseFile(newStr).lines;
      const next: FileModel = { lines: [...m.lines.slice(0, lineNo), ...added, ...m.lines.slice(lineNo)], br: m.br, finalBreak: m.finalBreak };
      tree.now.set(p, renderFile(next));
    };
  }
  return null;
}

function jsonEdits(lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let parsed: unknown;
    try { parsed = JSON.parse(lines.join('\n')); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(parsed)) throw new Exit2(`error: parse ${first + 1}`);
    const edits: Edit[] = [];
    for (const e of parsed) {
      const ed = jsonEdit(e, first);
      if (ed === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(ed);
    }
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (blank(l)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(l); } catch { throw new Exit2(`error: parse ${i + 1}`); }
    const ed = jsonEdit(parsed, i);
    if (ed === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(ed);
  }
  return edits;
}

/* ---------------- unified diffs (SPEC section 6) ---------------- */

interface UHunk {
  a: number; // old start line (1-based) from the hunk header
  o: string[];
  n: NLine[];
  /** a "\" line follows the hunk's last context or "+" line */
  noBreak: boolean;
  /** a "\" line follows the hunk's last "+" line (for creations) */
  plusNoBreak: boolean;
  hasPlus: boolean;
}

interface USection {
  oldPath: string | null; // null = /dev/null (no file)
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

/** Path from a "--- <path>" / "+++ <path>" line: text after the four characters, up to the first tab, surrounding spaces removed; "/dev/null" means no file; a leading a/ or b/ is removed. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function buildUHunk(a: number, body: string[]): UHunk {
  type Item = { kind: 'ctx' | 'old' | 'new' | 'bs'; text: string };
  const items: Item[] = body.map((bl) => {
    if (bl === '') return { kind: 'ctx', text: '' };
    if (bl.startsWith(' ')) return { kind: 'ctx', text: bl.slice(1) };
    if (bl.startsWith('-')) return { kind: 'old', text: bl.slice(1) };
    if (bl.startsWith('+')) return { kind: 'new', text: bl.slice(1) };
    return { kind: 'bs', text: bl.slice(1) };
  });
  const o: string[] = [];
  const n: NLine[] = [];
  for (const it of items) {
    if (it.kind === 'ctx') { o.push(it.text); n.push({ text: it.text, context: true, oIdx: o.length - 1 }); }
    else if (it.kind === 'old') { o.push(it.text); }
    else if (it.kind === 'new') { n.push({ text: it.text, context: false, oIdx: -1 }); }
  }
  let lastCtxNew = -1;
  let lastPlus = -1;
  let hasPlus = false;
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'ctx' || items[k]!.kind === 'new') { lastCtxNew = k; break; }
  }
  for (let k = items.length - 1; k >= 0; k--) {
    if (items[k]!.kind === 'new') { lastPlus = k; break; }
  }
  for (const it of items) if (it.kind === 'new') hasPlus = true;
  const noBreak = lastCtxNew >= 0 && items[lastCtxNew + 1]?.kind === 'bs';
  const plusNoBreak = lastPlus >= 0 && items[lastPlus + 1]?.kind === 'bs';
  return { a, o, n, noBreak, plusNoBreak, hasPlus };
}

function parseUSection(lines: string[], start: number): { section: USection; next: number } {
  const n = lines.length;
  let i = start;
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let isCreate = false;
  let isDelete = false;
  const hunks: UHunk[] = [];

  const first = lines[i]!;
  if (first.startsWith('diff --git ')) {
    const m = DIFF_GIT_RE.exec(first);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    diffOld = m[1]!;
    diffNew = m[2]!;
    i++;
  } else {
    oldPath = headerPath(first);
    newPath = headerPath(lines[i + 1]!);
    i += 2;
  }
  let hasPair = oldPath !== undefined;

  // Header lines, until the first hunk or the next section.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      if (!HUNK_RE.test(line)) throw new Exit2(`error: parse ${i + 1}`);
      break;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (hasPair) break; // a second pair starts a new section
        oldPath = headerPath(line);
        newPath = headerPath(lines[i + 1]!);
        hasPair = true;
        i += 2;
        continue;
      }
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('+++ ')) { newPath = headerPath(line); i++; continue; }
    if (line.startsWith('rename from ')) { renameFrom = line.slice('rename from '.length).trim(); i++; continue; }
    if (line.startsWith('rename to ')) { renameTo = line.slice('rename to '.length).trim(); i++; continue; }
    if (line === 'new file mode' || line.startsWith('new file mode ')) { isCreate = true; i++; continue; }
    if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) { isDelete = true; i++; continue; }
    // index / old mode / new mode / similarity index / dissimilarity index /
    // Index: and any other line: ignored.
    i++;
  }

  // Hunks. Prose between hunks is ignored; a new section ends this one.
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) {
      const hm = HUNK_RE.exec(line);
      if (!hm) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(hm[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        // The body ends at a "diff --git " line, at a "--- " line followed by
        // a "+++ " line, or at the first other line; a "--- " line on its own
        // is a body line (an old line), not a section start.
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\') || bl === '') { body.push(bl); i++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      hunks.push(buildUHunk(a, body));
      continue;
    }
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    i++;
  }

  const old = oldPath !== undefined ? oldPath : (renameFrom !== null ? renameFrom : diffOld);
  const nw = newPath !== undefined ? newPath : (renameTo !== null ? renameTo : diffNew);
  return { section: { oldPath: old ?? null, newPath: nw ?? null, isCreate, isDelete, hunks }, next: i };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (line.startsWith('diff --git ') || (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const { section, next } = parseUSection(lines, i);
      edits.push(makeUnifiedEdit(section, strict));
      i = next;
    } else {
      i++;
    }
  }
  return edits;
}

/** Apply a section's hunks in order to a file model. d accumulates (N length - O length) of the hunks applied so far. */
function applyUnifiedHunks(m: FileModel, hunks: UHunk[], strict: boolean, path: string): FileModel {
  let cur = m;
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const pos = Math.max(0, Math.min(h.a + d, cur.lines.length));
      const atEnd = pos === cur.lines.length;
      const out = h.n.map((nl) => nl.text);
      cur = { lines: [...cur.lines.slice(0, pos), ...out, ...cur.lines.slice(pos)], br: cur.br, finalBreak: atEnd ? !h.noBreak : cur.finalBreak };
      d += h.n.length;
      continue;
    }
    const found = findTier(cur.lines, h.o, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const pos = best;
    const atEnd = pos + h.o.length === cur.lines.length;
    const next = applyReplace(cur, h.o, h.n, found.tier, pos);
    cur = { lines: next.lines, br: next.br, finalBreak: atEnd ? !h.noBreak : cur.finalBreak };
    d += h.n.length - h.o.length;
  }
  return cur;
}

function makeUnifiedEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.oldPath;
    const newP = s.newPath;
    const isCreate = oldP === null || s.isCreate;
    const isDelete = !isCreate && (newP === null || s.isDelete);
    const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const content: string[] = [];
      for (const h of s.hunks) for (const nl of h.n) if (!nl.context) content.push(nl.text);
      let lastPlusNoBreak = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        if (s.hunks[k]!.hasPlus) { lastPlusNoBreak = s.hunks[k]!.plusNoBreak; break; }
      }
      tree.now.set(p, content.length === 0 ? '' : content.join('\n') + (!lastPlusNoBreak ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const next = applyUnifiedHunks(parseFile(cur), s.hunks, strict, op);
      tree.now.set(np, renderFile(next));
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const next = applyUnifiedHunks(parseFile(cur), s.hunks, strict, p);
    tree.now.set(p, renderFile(next));
  };
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1; // index of the previous block's ">>>>>>> REPLACE" line
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    const searchLine = i;
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq < 0 && t === '=======') { eq = j; continue; }
      if (eq >= 0 && t === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevEnd = rep;
    prevPath = path;
    i = rep;
  }
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const m = parseFile(cur);
    const found = findTier(m.lines, oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, context: false, oIdx: -1 }));
    const next = applyReplace(m, oldLines, n, found.tier, pos);
    tree.now.set(path, renderFile(next));
  };
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

interface VChunk {
  anchor: string | null; // null = no anchor
  eof: boolean;
  o: string[];
  n: NLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const end = last; // the "*** End Patch" line index (exclusive bound)
  while (i < end) {
    if (blank(lines[i]!)) { i++; continue; } // blank lines between sections
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const p = line.slice('*** Add File: '.length).trim();
      const { raw, next } = collectVSection(lines, i + 1, end);
      const content = stripTrailingBlanks(raw);
      const fileLines: string[] = [];
      for (const [idx, rl] of content) {
        if (rl.startsWith('+')) fileLines.push(rl.slice(1));
        else if (rl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(makeVAddEdit(p, fileLines));
      i = next;
    } else if (line.startsWith('*** Delete File: ')) {
      const p = line.slice('*** Delete File: '.length).trim();
      const { raw, next } = collectVSection(lines, i + 1, end);
      const content = stripTrailingBlanks(raw);
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]![0] + 1}`);
      edits.push(makeVDeleteEdit(p));
      i = next;
    } else if (line.startsWith('*** Update File: ')) {
      const p = line.slice('*** Update File: '.length).trim();
      const { raw, next } = collectVSection(lines, i + 1, end);
      const content = stripTrailingBlanks(raw);
      const sec = parseVUpdate(p, content, i + 1);
      edits.push(makeVUpdateEdit(sec, strict));
      i = next;
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

/** Collect a section's raw [line index, line] pairs until the next section header or the End Patch line. */
function collectVSection(lines: string[], from: number, end: number): { raw: Array<[number, string]>; next: number } {
  const raw: Array<[number, string]> = [];
  let i = from;
  while (i < end) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    raw.push([i, l]);
    i++;
  }
  return { raw, next: i };
}

/** Blank lines at the end of a section are not part of it. */
function stripTrailingBlanks(raw: Array<[number, string]>): Array<[number, string]> {
  let k = raw.length;
  while (k > 0 && blank(raw[k - 1]![1])) k--;
  return raw.slice(0, k);
}

function parseVUpdate(path: string, content: Array<[number, string]>, headerLine: number): { path: string; moveTo: string | null; chunks: VChunk[] } {
  let moveTo: string | null = null;
  const chunks: VChunk[] = [];
  let idx = 0;
  if (idx < content.length && content[idx]![1].startsWith('*** Move to: ')) {
    moveTo = content[idx]![1].slice('*** Move to: '.length).trim();
    idx++;
  }
  type Item = { kind: 'ctx' | 'old' | 'new'; text: string };
  let cur: { anchor: string | null; eof: boolean; items: Item[] } | null = null;
  let firstChunk = true;
  const pushChunk = () => {
    if (cur === null) return;
    const o: string[] = [];
    const n: NLine[] = [];
    for (const it of cur.items) {
      if (it.kind === 'ctx') { o.push(it.text); n.push({ text: it.text, context: true, oIdx: o.length - 1 }); }
      else if (it.kind === 'old') { o.push(it.text); }
      else { n.push({ text: it.text, context: false, oIdx: -1 }); }
    }
    chunks.push({ anchor: cur.anchor, eof: cur.eof, o, n });
    cur = null;
  };
  while (idx < content.length) {
    const [ln, l] = content[idx]!;
    if (l.startsWith('@@')) {
      pushChunk();
      const anchorText = l.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
      firstChunk = false;
      idx++;
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln + 1}`);
        idx++;
        continue; // no chunk yet; the no-chunk check at the end reports it
      }
      cur.eof = true;
      pushChunk();
      firstChunk = false;
      idx++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) {
        if (!firstChunk) {
          if (blank(l)) { idx++; continue; } // blank line between chunks
          throw new Exit2(`error: parse ${ln + 1}`);
        }
        cur = { anchor: null, eof: false, items: [] };
        firstChunk = false;
      }
      if (l === '') cur.items.push({ kind: 'ctx', text: '' });
      else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1) });
      else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1) });
      else cur.items.push({ kind: 'new', text: l.slice(1) });
      idx++;
      continue;
    }
    // Any other line (including a "*** Move to:" that is not first).
    throw new Exit2(`error: parse ${ln + 1}`);
  }
  pushChunk();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return { path, moveTo, chunks };
}

function makeVAddEdit(p: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeVDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function makeVUpdateEdit(sec: { path: string; moveTo: string | null; chunks: VChunk[] }, strict: boolean): Edit {
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let m = parseFile(cur);
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findTierSingle(m.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? m.lines.length : cursor;
        const out = ch.n.map((nl) => nl.text);
        m = { lines: [...m.lines.slice(0, pos), ...out, ...m.lines.slice(pos)], br: m.br, finalBreak: m.finalBreak };
        cursor = pos + out.length;
        continue;
      }
      const found = findTier(m.lines, ch.o, strict, cursor);
      if (found === null) throw new Fail('no-match', p);
      let pos: number;
      if (ch.eof) {
        const ok = found.occ.filter((q) => q + ch.o.length === m.lines.length);
        if (ok.length === 0) throw new Fail('no-match', p);
        pos = ok[0]!;
      } else {
        pos = found.occ[0]!;
      }
      m = applyReplace(m, ch.o, ch.n, found.tier, pos);
      cursor = pos + ch.n.length;
    }
    const text = renderFile(m);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, text);
      tree.now.set(p, null);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

/* ---------------- run ---------------- */

function run(argv: string[], stdinText: string): { exit: number; stdout: string } {
  let format: Format | null = null;
  let check = false;
  let strict = false;
  let ended = false;
  const pos: string[] = [];
  for (const a of argv) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('--format=')) {
      if (format !== null) throw new Exit2('error: usage');
      const v = a.slice('--format='.length);
      if (!(FORMATS as readonly string[]).includes(v)) throw new Exit2('error: usage');
      format = v as Format;
      continue;
    }
    if (!ended && a === '--check') { if (check) throw new Exit2('error: usage'); check = true; continue; }
    if (!ended && a === '--strict') { if (strict) throw new Exit2('error: usage'); strict = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') throw new Exit2('error: usage');
    pos.push(a);
  }
  if (pos.length > 1) throw new Exit2('error: usage');
  let text: string;
  if (pos.length === 0 || pos[0] === '-') {
    text = stdinText;
  } else {
    try { text = readFileSync(pos[0]!, 'utf8'); } catch { throw new Exit2('error: no-patch'); }
  }
  const lines = patchLines(text);
  const fmt: Format = format ?? detect(lines);
  if (fmt === 'auto') throw new Exit2('error: format');
  let edits: Edit[];
  if (fmt === 'json') edits = jsonEdits(lines);
  else if (fmt === 'unified') edits = unifiedEdits(lines, strict);
  else if (fmt === 'search-replace') edits = searchReplaceEdits(lines, strict);
  else edits = v4aEdits(lines, strict);
  if (edits.length === 0) throw new Exit2('error: parse 1');
  const tree = new Tree();
  const failures: Fail[] = [];
  for (const e of edits) {
    const snap = new Map(tree.now);
    try { e(tree); } catch (err) {
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      if (err instanceof Fail) failures.push(err);
      else throw err;
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => `error: ${f.code} ${f.path}`).join('\n') + `\nfailed: ${failures.length} of ${edits.length} edits\n`;
    return { exit: 1, stdout: out };
  }
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  // A move that succeeded qualifies for an "R old -> new" line when the old
  // path existed before and does not after, and the new path did not exist
  // before and does after; the pair's D and A lines are replaced by it.
  const coveredOld = new Set<string>();
  const coveredNew = new Set<string>();
  const entries: Array<{ key: string; line: string }> = [];
  for (const [op, np] of tree.moves) {
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      entries.push({ key: np, line: `R ${op} -> ${np}` });
      coveredOld.add(op);
      coveredNew.add(np);
    }
  }
  for (const p of tree.now.keys()) {
    if (coveredOld.has(p) || coveredNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (was === null) entries.push({ key: p, line: `A ${p}` });
    else if (now === null) entries.push({ key: p, line: `D ${p}` });
    else entries.push({ key: p, line: `M ${p}` });
  }
  entries.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = entries.map((e) => e.line);
  outLines.push(`ok: ${entries.length} file${entries.length === 1 ? '' : 's'}`);
  const stdout = outLines.join('\n') + '\n';
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) { try { rmSync(p, { force: true }); } catch { /* ignore */ } }
      else {
        const dir = dirname(p);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(p, now, 'utf8');
      }
    }
  }
  return { exit: 0, stdout };
}

function main(argv: string[]): void {
  let stdinText = '';
  try { stdinText = readFileSync(0, 'utf8'); } catch { stdinText = ''; }
  let res: { exit: number; stdout: string };
  try {
    res = run(argv, stdinText);
  } catch (e) {
    if (e instanceof Exit2) { writeSync(1, e.line + '\n'); process.exit(2); }
    throw e;
  }
  writeSync(1, res.stdout);
  process.exit(res.exit);
}

// A trial: the kit's runner reads the checks from the env and runs this
// file on each one, without this variable. Otherwise run the tool.
const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  main(process.argv.slice(2));
}
