// main.ts — mend: one patch tool for every AI edit format.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// Reads the patch from PATCH, or from standard input when PATCH is absent
// or "-". Edits are applied to the tree in the working directory.
//
// When MAKEFUN_ENV_URL is set, main.ts hands the trial over to runner.ts.

import { mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runTrial } from './runner.ts';

type Brk = '\n' | '\r\n';

interface FileModel {
  brk: Brk;
  lines: string[];
  eol: boolean;
}

function parseLines(text: string): FileModel {
  if (text === '') return { brk: '\n', lines: [], eol: false };
  const i = text.indexOf('\n');
  const brk: Brk = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const eol = text.endsWith(brk);
  const parts = text.split(brk);
  if (eol) parts.pop();
  return { brk, lines: parts, eol };
}

function renderLines(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.brk) + (m.eol ? m.brk : '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// Split text at \n, one trailing \r removed from each line, without the
// empty piece after a final \n. Used for patch lines and JSON new_str.
function splitLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// The tree under the working directory, kept in memory: the original state
// (as read from disk) and the current state (as edits leave it). Nothing is
// written to disk until every edit has been applied without failure.
class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();
  moves: Array<[string, string]> = [];

  get(path: string): string | null {
    if (!this.cur.has(path)) {
      let text: string | null = null;
      try {
        text = readFileSync(join(process.cwd(), ...path.split('/')), 'utf8');
      } catch {
        text = null;
      }
      this.orig.set(path, text);
      this.cur.set(path, text);
    }
    const v = this.cur.get(path);
    return v === undefined ? null : v;
  }

  exists(path: string): boolean {
    return this.get(path) !== null;
  }

  set(path: string, text: string | null): void {
    this.get(path);
    this.cur.set(path, text);
  }

  model(path: string): FileModel | null {
    const t = this.get(path);
    return t === null ? null : parseLines(t);
  }

  setModel(path: string, m: FileModel): void {
    this.set(path, renderLines(m));
  }

  original(path: string): string | null {
    this.get(path);
    const v = this.orig.get(path);
    return v === undefined ? null : v;
  }

  changedPaths(): string[] {
    const out: string[] = [];
    for (const [p, cur] of this.cur) {
      if (cur !== this.orig.get(p)) out.push(p);
    }
    return out;
  }
}

type Fail = { code: string; path: string };
type ApplyOutcome = { ok: true } | { ok: false; fail: Fail };

interface Edit {
  paths: string[];
  run(t: Tree, strict: boolean): ApplyOutcome;
}

function fail(code: string, path: string): ApplyOutcome {
  return { ok: false, fail: { code, path } };
}

function unsafeFirst(paths: string[]): string | null {
  for (const p of paths) if (!isSafePath(p)) return p;
  return null;
}

// ---- Matching (section 5) ----

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function linesEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!linesEqualAt(lines[i + k], o[k], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function findTier(
  lines: string[],
  o: string[],
  from: number,
  strict: boolean,
): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

// ---- Body lines shared by unified hunks and V4A chunks ----

interface BodyItem {
  t: 'ctx' | 'old' | 'new' | 'mark';
  text: string;
}

function buildOld(items: BodyItem[]): string[] {
  const o: string[] = [];
  for (const it of items) {
    if (it.t === 'ctx' || it.t === 'old') o.push(it.text);
  }
  return o;
}

function reindentLine(t: string, p: string, f: string): string {
  if (t === '' || /^[ \t]+$/.test(t)) return t;
  if (!t.startsWith(p)) return t;
  return f + t.slice(p.length);
}

// N for a non-empty O: context lines are the file's own matched lines;
// new lines are re-indented at tier 2.
function buildNew(items: BodyItem[], fileLines: string[], pos: number, tier: number): string[] {
  const o = buildOld(items);
  const f = fileLines.length > pos ? leadingWs(fileLines[pos]) : '';
  const p = o.length > 0 ? leadingWs(o[0]) : '';
  const n: string[] = [];
  let oi = 0;
  for (const it of items) {
    if (it.t === 'ctx') {
      n.push(fileLines[pos + oi]);
      oi++;
    } else if (it.t === 'old') {
      oi++;
    } else if (it.t === 'new') {
      n.push(tier === 2 ? reindentLine(it.text, p, f) : it.text);
    }
  }
  return n;
}

// N for an empty O: only new lines, written as they are.
function buildNewOnly(items: BodyItem[]): string[] {
  const n: string[] = [];
  for (const it of items) if (it.t === 'new') n.push(it.text);
  return n;
}

// Whether a `\` line follows the hunk or chunk's last context or `+` line.
function backslashAfterLast(items: BodyItem[]): boolean {
  let lastIdx = -1;
  for (let k = 0; k < items.length; k++) {
    if (items[k].t === 'ctx' || items[k].t === 'new') lastIdx = k;
  }
  if (lastIdx === -1) return false;
  return lastIdx + 1 < items.length && items[lastIdx + 1].t === 'mark';
}

interface Hunk {
  a: number;
  body: BodyItem[];
}

// Apply a section's hunks in order to a file's lines. Returns null when a
// hunk's old lines match nowhere.
function applyHunks(
  model: FileModel,
  hunks: Hunk[],
  strict: boolean,
): { lines: string[]; eol: boolean } | null {
  let lines = [...model.lines];
  let eol = model.eol;
  let d = 0;
  for (const h of hunks) {
    const o = buildOld(h.body);
    if (o.length > 0) {
      const found = findTier(lines, o, 0, strict);
      if (found === null) return null;
      const target = h.a - 1 + d;
      let best = found.pos[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.pos) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const pos = best;
      const matchedToEnd = pos + o.length === lines.length;
      const n = buildNew(h.body, lines, pos, found.tier);
      const backslash = backslashAfterLast(h.body);
      lines.splice(pos, o.length, ...n);
      if (matchedToEnd) eol = !backslash;
      d += n.length - o.length;
    } else {
      const n = buildNewOnly(h.body);
      let insertAt = h.a + d;
      if (insertAt < 0) insertAt = 0;
      if (insertAt > lines.length) insertAt = lines.length;
      const atEnd = insertAt === lines.length;
      const backslash = backslashAfterLast(h.body);
      lines.splice(insertAt, 0, ...n);
      if (atEnd) eol = !backslash;
      d += n.length;
    }
  }
  return { lines, eol };
}

// ---- Unified diffs (section 6) ----

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

interface UnifiedSection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  headOld: string | null | undefined;
  headNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseUnifiedPath(s: string): string | null {
  let p = s;
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let inHeader = false;
  let curHunk: Hunk | null = null;

  const finishHunk = (): void => {
    if (curHunk !== null) {
      while (curHunk.body.length > 0) {
        const last = curHunk.body[curHunk.body.length - 1];
        if (last.t === 'ctx' && last.text === '') curHunk.body.pop();
        else break;
      }
      if (cur !== null) cur.hunks.push(curHunk);
      curHunk = null;
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (curHunk !== null) {
      if (line.startsWith('diff --git ')) {
        finishHunk();
        continue;
      }
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        finishHunk();
        continue;
      }
      if (
        line === '' ||
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\')
      ) {
        if (line === '') curHunk.body.push({ t: 'ctx', text: '' });
        else if (line.startsWith(' ')) curHunk.body.push({ t: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) curHunk.body.push({ t: 'old', text: line.slice(1) });
        else if (line.startsWith('+')) curHunk.body.push({ t: 'new', text: line.slice(1) });
        else curHunk.body.push({ t: 'mark', text: line.slice(1) });
        i++;
        continue;
      }
      finishHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const m = /^a\/(.*) b\/(.+)$/.exec(rest);
      if (m === null || m[1] === '') throw new ParseError(i + 1);
      cur = {
        diffOld: m[1],
        diffNew: m[2],
        headOld: undefined,
        headNew: undefined,
        renOld: undefined,
        renNew: undefined,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      if (cur === null) throw new ParseError(i + 1);
      curHunk = { a: parseInt(m[1], 10), body: [] };
      inHeader = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && inHeader) {
        if (i + 1 >= lines.length || !lines[i + 1].startsWith('+++ ')) throw new ParseError(i + 2);
        cur.headOld = parseUnifiedPath(line.slice(4));
        i++;
        continue;
      }
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        cur = {
          diffOld: undefined,
          diffNew: undefined,
          headOld: undefined,
          headNew: undefined,
          renOld: undefined,
          renNew: undefined,
          isCreate: false,
          isDelete: false,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
        cur.headOld = parseUnifiedPath(line.slice(4));
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && inHeader) cur.headNew = parseUnifiedPath(line.slice(4));
      i++;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  finishHunk();
  return sections.map((s) => unifiedEdit(s));
}

function unifiedEdit(sec: UnifiedSection): Edit {
  const oldPath =
    sec.headOld !== undefined
      ? sec.headOld
      : sec.renOld !== undefined
        ? sec.renOld
        : sec.diffOld !== undefined
          ? sec.diffOld
          : null;
  const newPath =
    sec.headNew !== undefined
      ? sec.headNew
      : sec.renNew !== undefined
        ? sec.renNew
        : sec.diffNew !== undefined
          ? sec.diffNew
          : null;

  if (oldPath === null || sec.isCreate) {
    const target = newPath;
    return {
      paths: target === null ? [] : [target],
      run(t: Tree): ApplyOutcome {
        if (target === null) return { ok: true };
        const u = unsafeFirst([target]);
        if (u !== null) return fail('unsafe', u);
        if (t.exists(target)) return fail('exists', target);
        const plus: string[] = [];
        let lastPlus: { hunk: Hunk; idx: number } | null = null;
        for (const h of sec.hunks) {
          for (let k = 0; k < h.body.length; k++) {
            if (h.body[k].t === 'new') {
              plus.push(h.body[k].text);
              lastPlus = { hunk: h, idx: k };
            }
          }
        }
        let eol = true;
        if (lastPlus !== null) {
          const { hunk, idx } = lastPlus;
          if (idx + 1 < hunk.body.length && hunk.body[idx + 1].t === 'mark') eol = false;
        }
        const text = plus.length === 0 ? '' : plus.join('\n') + (eol ? '\n' : '');
        t.set(target, text);
        return { ok: true };
      },
    };
  }

  if (newPath === null || sec.isDelete) {
    const target = oldPath as string;
    return {
      paths: [target],
      run(t: Tree): ApplyOutcome {
        const u = unsafeFirst([target]);
        if (u !== null) return fail('unsafe', u);
        if (!t.exists(target)) return fail('missing', target);
        t.set(target, null);
        return { ok: true };
      },
    };
  }

  if (oldPath !== newPath) {
    const from = oldPath as string;
    const to = newPath as string;
    return {
      paths: [from, to],
      run(t: Tree, strict: boolean): ApplyOutcome {
        const u = unsafeFirst([from, to]);
        if (u !== null) return fail('unsafe', u);
        if (!t.exists(from)) return fail('missing', from);
        if (t.exists(to)) return fail('exists', to);
        const model = t.model(from) as FileModel;
        const res = applyHunks(model, sec.hunks, strict);
        if (res === null) return fail('no-match', from);
        t.set(to, renderLines({ brk: model.brk, lines: res.lines, eol: res.eol }));
        t.set(from, null);
        t.moves.push([from, to]);
        return { ok: true };
      },
    };
  }

  const target = oldPath as string;
  return {
    paths: [target],
    run(t: Tree, strict: boolean): ApplyOutcome {
      const u = unsafeFirst([target]);
      if (u !== null) return fail('unsafe', u);
      if (!t.exists(target)) return fail('missing', target);
      const model = t.model(target) as FileModel;
      const res = applyHunks(model, sec.hunks, strict);
      if (res === null) return fail('no-match', target);
      t.setModel(target, { brk: model.brk, lines: res.lines, eol: res.eol });
      return { ok: true };
    },
  };
}

// ---- SEARCH/REPLACE blocks (section 7) ----

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Edit[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(searchIdx + 1);
      path = prevPath;
    }
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '=======') {
        eq = k;
        break;
      }
    }
    if (eq === -1) throw new ParseError(searchIdx + 1);
    let rep = -1;
    for (let m = eq + 1; m < lines.length; m++) {
      if (lines[m].trimEnd() === '>>>>>>> REPLACE') {
        rep = m;
        break;
      }
    }
    if (rep === -1) throw new ParseError(searchIdx + 1);
    blocks.push({
      path,
      oldLines: lines.slice(searchIdx + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b));
}

function srEdit(b: SrBlock): Edit {
  return {
    paths: [b.path],
    run(t: Tree, strict: boolean): ApplyOutcome {
      const u = unsafeFirst([b.path]);
      if (u !== null) return fail('unsafe', u);
      if (b.oldLines.length === 0) {
        if (t.exists(b.path)) return fail('exists', b.path);
        const text = b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
        t.set(b.path, text);
        return { ok: true };
      }
      if (!t.exists(b.path)) return fail('missing', b.path);
      const model = t.model(b.path) as FileModel;
      const found = findTier(model.lines, b.oldLines, 0, strict);
      if (found === null) return fail('no-match', b.path);
      if (found.pos.length > 1) return fail('ambiguous', b.path);
      const pos = found.pos[0];
      let n: string[];
      if (found.tier === 2) {
        const f = leadingWs(model.lines[pos]);
        const p = leadingWs(b.oldLines[0]);
        n = b.newLines.map((x) => reindentLine(x, p, f));
      } else {
        n = [...b.newLines];
      }
      const lines = [...model.lines];
      lines.splice(pos, b.oldLines.length, ...n);
      t.setModel(b.path, { brk: model.brk, lines, eol: model.eol });
      return { ok: true };
    },
  };
}

// ---- V4A patches (section 8) ----

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    const content: number[] = [];
    let j = i + 1;
    while (j < last) {
      const l = lines[j];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      content.push(j);
      j++;
    }
    while (content.length > 0 && lines[content[content.length - 1]].trim() === '') content.pop();
    const sec: V4aSection = { kind, path, moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    if (kind === 'add') {
      for (const idx of content) {
        const l = lines[idx];
        if (l === '') sec.lines.push('');
        else if (l.startsWith('+')) sec.lines.push(l.slice(1));
        else throw new ParseError(idx + 1);
      }
    } else if (kind === 'delete') {
      if (content.length > 0) throw new ParseError(content[0] + 1);
    } else {
      let chunk: V4aChunk | null = null;
      let started = false;
      const closeChunk = (): void => {
        if (chunk !== null) {
          sec.chunks.push(chunk);
          chunk = null;
        }
      };
      for (let k = 0; k < content.length; k++) {
        const idx = content[k];
        const l = lines[idx];
        if (k === 0 && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          continue;
        }
        if (l.startsWith('*** Move to: ')) throw new ParseError(idx + 1);
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, items: [] };
          started = true;
          continue;
        }
        if (l === '*** End of File') {
          if (chunk === null) throw new ParseError(idx + 1);
          chunk.eof = true;
          closeChunk();
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) {
            if (started) throw new ParseError(idx + 1);
            chunk = { anchor: null, eof: false, items: [] };
            started = true;
          }
          if (l === '') chunk.items.push({ t: 'ctx', text: '' });
          else if (l.startsWith(' ')) chunk.items.push({ t: 'ctx', text: l.slice(1) });
          else if (l.startsWith('-')) chunk.items.push({ t: 'old', text: l.slice(1) });
          else chunk.items.push({ t: 'new', text: l.slice(1) });
          continue;
        }
        throw new ParseError(idx + 1);
      }
      closeChunk();
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseError(sec.updateLine);
    }
    sections.push(sec);
    i = j;
  }
  return sections.map((s) => v4aEdit(s));
}

function v4aEdit(sec: V4aSection): Edit {
  if (sec.kind === 'add') {
    return {
      paths: [sec.path],
      run(t: Tree): ApplyOutcome {
        const u = unsafeFirst([sec.path]);
        if (u !== null) return fail('unsafe', u);
        if (t.exists(sec.path)) return fail('exists', sec.path);
        const text = sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
        t.set(sec.path, text);
        return { ok: true };
      },
    };
  }
  if (sec.kind === 'delete') {
    return {
      paths: [sec.path],
      run(t: Tree): ApplyOutcome {
        const u = unsafeFirst([sec.path]);
        if (u !== null) return fail('unsafe', u);
        if (!t.exists(sec.path)) return fail('missing', sec.path);
        t.set(sec.path, null);
        return { ok: true };
      },
    };
  }
  const paths = sec.moveTo === null ? [sec.path] : [sec.path, sec.moveTo];
  return {
    paths,
    run(t: Tree, strict: boolean): ApplyOutcome {
      const u = unsafeFirst(paths);
      if (u !== null) return fail('unsafe', u);
      if (!t.exists(sec.path)) return fail('missing', sec.path);
      if (sec.moveTo !== null && t.exists(sec.moveTo)) return fail('exists', sec.moveTo);
      const model = t.model(sec.path) as FileModel;
      let lines = [...model.lines];
      let cursor = 0;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const ch of sec.chunks) {
        if (ch.anchor !== null) {
          let foundAt: number | null = null;
          for (const tier of tiers) {
            for (let j = cursor; j < lines.length; j++) {
              if (linesEqualAt(lines[j], ch.anchor, tier)) {
                foundAt = j;
                break;
              }
            }
            if (foundAt !== null) break;
          }
          if (foundAt === null) return fail('no-match', sec.path);
          cursor = foundAt + 1;
        }
        const o = buildOld(ch.items);
        if (o.length > 0) {
          let chosen: { tier: number; pos: number } | null = null;
          for (const tier of tiers) {
            const occ = occurrences(lines, o, tier, cursor);
            const good = ch.eof ? occ.filter((p) => p + o.length === lines.length) : occ;
            if (good.length > 0) {
              chosen = { tier, pos: good[0] };
              break;
            }
          }
          if (chosen === null) return fail('no-match', sec.path);
          const n = buildNew(ch.items, lines, chosen.pos, chosen.tier);
          lines.splice(chosen.pos, o.length, ...n);
          cursor = chosen.pos + n.length;
        } else {
          const n = buildNewOnly(ch.items);
          const at = ch.eof ? lines.length : cursor;
          lines.splice(at, 0, ...n);
          cursor = at + n.length;
        }
      }
      const result: FileModel = { brk: model.brk, lines, eol: model.eol };
      if (sec.moveTo !== null) {
        t.set(sec.moveTo, renderLines(result));
        t.set(sec.path, null);
        t.moves.push([sec.path, sec.moveTo]);
      } else {
        t.setModel(sec.path, result);
      }
      return { ok: true };
    },
  };
}

// ---- JSON edits (section 9) ----

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  const firstCh = lines[first].trimStart()[0];
  const edits: Edit[] = [];
  if (firstCh === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    for (const el of arr) {
      const e = jsonEdit(el);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(l);
      } catch {
        throw new ParseError(i + 1);
      }
      const e = jsonEdit(obj);
      if (e === null) throw new ParseError(i + 1);
      edits.push(e);
    }
  }
  return edits;
}

function jsonEdit(obj: unknown): Edit | null {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const path = o.path;
    const text = o.file_text;
    return {
      paths: [path],
      run(t: Tree): ApplyOutcome {
        const u = unsafeFirst([path]);
        if (u !== null) return fail('unsafe', u);
        if (t.exists(path)) return fail('exists', path);
        t.set(path, text);
        return { ok: true };
      },
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const path = o.path;
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : (o.new_str as string);
    return {
      paths: [path],
      run(t: Tree): ApplyOutcome {
        const u = unsafeFirst([path]);
        if (u !== null) return fail('unsafe', u);
        if (!t.exists(path)) return fail('missing', path);
        const text = t.get(path) as string;
        const model = parseLines(text);
        const crlf = model.brk === '\r\n';
        const tn = crlf ? text.split('\r\n').join('\n') : text;
        const on = crlf ? oldStr.split('\r\n').join('\n') : oldStr;
        const nn = crlf ? newStr.split('\r\n').join('\n') : newStr;
        let count = 0;
        let idx = -1;
        let from = 0;
        for (;;) {
          const p = tn.indexOf(on, from);
          if (p === -1) break;
          count++;
          if (idx === -1) idx = p;
          from = p + 1;
        }
        if (count === 0) return fail('no-match', path);
        if (count > 1) return fail('ambiguous', path);
        let result = tn.slice(0, idx) + nn + tn.slice(idx + on.length);
        if (crlf) result = result.split('\n').join('\r\n');
        t.set(path, result);
        return { ok: true };
      },
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const path = o.path;
    const lineNo = o.insert_line;
    const newStr = o.new_str;
    return {
      paths: [path],
      run(t: Tree): ApplyOutcome {
        const u = unsafeFirst([path]);
        if (u !== null) return fail('unsafe', u);
        if (!t.exists(path)) return fail('missing', path);
        const model = t.model(path) as FileModel;
        if (lineNo < 0 || lineNo > model.lines.length) return fail('no-match', path);
        const ins = splitLines(newStr);
        const lines = [...model.lines];
        lines.splice(lineNo, 0, ...ins);
        t.setModel(path, { brk: model.brk, lines, eol: model.eol });
        return { ok: true };
      },
    };
  }
  return null;
}

// ---- Format detection (section 4) and dispatch ----

const FORMATS = ['unified', 'search-replace', 'v4a', 'json', 'auto'];

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first === -1) return null;
  const firstLine = lines[first];
  if (firstLine.trim() === '*** Begin Patch') return 'v4a';
  const firstNonWs = firstLine.trimStart();
  if (firstNonWs.startsWith('[') || firstNonWs.startsWith('{')) return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function parsePatch(fmt: string, lines: string[], patchText: string): Edit[] {
  if (fmt === 'unified') return parseUnified(lines);
  if (fmt === 'search-replace') return parseSearchReplace(lines);
  if (fmt === 'v4a') return parseV4a(lines);
  return parseJson(lines, patchText);
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// The exit-0 listing (section 2), with move edits shown as R lines.
function changeListing(tree: Tree): string[] {
  const changed = new Set(tree.changedPaths());
  const dPaths: string[] = [];
  const aPaths: string[] = [];
  const mPaths: string[] = [];
  for (const p of changed) {
    const o = tree.original(p);
    const c = tree.get(p);
    if (o === null && c !== null) aPaths.push(p);
    else if (o !== null && c === null) dPaths.push(p);
    else if (o !== null && c !== null && o !== c) mPaths.push(p);
  }
  const dSet = new Set(dPaths);
  const aSet = new Set(aPaths);
  const entries: Array<{ sort: string; line: string }> = [];
  const usedD = new Set<string>();
  const usedA = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (dSet.has(oldP) && aSet.has(newP) && !usedD.has(oldP) && !usedA.has(newP)) {
      entries.push({ sort: newP, line: `R ${oldP} -> ${newP}` });
      usedD.add(oldP);
      usedA.add(newP);
    }
  }
  for (const p of dPaths) if (!usedD.has(p)) entries.push({ sort: p, line: `D ${p}` });
  for (const p of aPaths) if (!usedA.has(p)) entries.push({ sort: p, line: `A ${p}` });
  for (const p of mPaths) entries.push({ sort: p, line: `M ${p}` });
  entries.sort((x, y) => compareBytes(x.sort, y.sort));
  return entries.map((e) => e.line);
}

function writeTree(tree: Tree): void {
  for (const p of tree.changedPaths()) {
    const cur = tree.get(p);
    const full = join(process.cwd(), ...p.split('/'));
    if (cur === null) {
      try {
        rmSync(full);
      } catch {
        // already gone
      }
    } else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, cur, 'utf8');
    }
  }
}

function usageError(): void {
  writeSync(1, 'error: usage\n');
  process.exitCode = 2;
}

function main(): void {
  const argv = process.argv.slice(2);
  let format = 'auto';
  let check = false;
  let strict = false;
  const positional: string[] = [];
  const seen = new Set<string>();
  let endOpts = false;
  for (const a of argv) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seen.has('check')) return usageError();
        seen.add('check');
        check = true;
      } else if (a === '--strict') {
        if (seen.has('strict')) return usageError();
        seen.add('strict');
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) return usageError();
        seen.add('format');
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return usageError();
        format = v;
      } else {
        return usageError();
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return usageError();
  const patchArg = positional.length === 1 ? positional[0] : null;

  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      writeSync(1, 'error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }

  const lines = splitLines(patchText);
  const fmt = format === 'auto' ? detectFormat(lines) : format;
  if (fmt === null) {
    writeSync(1, 'error: format\n');
    process.exitCode = 2;
    return;
  }

  let edits: Edit[];
  try {
    edits = parsePatch(fmt, lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) {
      writeSync(1, `error: parse ${e.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw e;
  }
  if (edits.length === 0) {
    writeSync(1, 'error: parse 1\n');
    process.exitCode = 2;
    return;
  }

  const tree = new Tree();
  const failures: Fail[] = [];
  for (const ed of edits) {
    const r = ed.run(tree, strict);
    if (!r.ok) failures.push(r.fail);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    writeSync(1, out);
    process.exitCode = 1;
    return;
  }

  const listing = changeListing(tree);
  if (!check) writeTree(tree);
  let out = '';
  for (const l of listing) out += l + '\n';
  const n = listing.length;
  out += n === 1 ? 'ok: 1 file\n' : `ok: ${n} files\n`;
  writeSync(1, out);
  process.exitCode = 0;
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  main();
}
