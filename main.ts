// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, as [old path, new path] pairs, in patch order (section 2's R lines). */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file's lines under section 3: its own line break, its lines, and whether it ends with a break. */
interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(fl: FileLines): string {
  return fl.lines.length === 0 ? '' : fl.lines.join(fl.br) + (fl.final ? fl.br : '');
}

/** A file an edit creates: LF breaks, ending with a break unless it has no lines (section 3). */
function createdText(lines: string[], finalBreak = true): string {
  return lines.length === 0 ? '' : lines.join('\n') + (finalBreak ? '\n' : '');
}

/** Section 5's tier normalisation: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function tierNorm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position at or after `from` where O occurs in `fileLines` at `tier` (overlaps allowed). */
function occurrencesAt(fileLines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const want = O.map((s) => tierNorm(s, tier));
  for (let i = from; i + O.length <= fileLines.length; i += 1) {
    let hit = true;
    for (let j = 0; j < O.length; j += 1) {
      if (tierNorm(fileLines[i + j]!, tier) !== want[j]) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its occurrences; null when it occurs at none. */
function findTier(fileLines: string[], O: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier += 1) {
    const occ = occurrencesAt(fileLines, O, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/**
 * The lines N writes over the matched span at `at`, under section 5: context lines (each carrying the index
 * of its line in O) are the file's own matched lines; other lines are the patch's, re-indented at tier 2.
 */
interface NewLine {
  text: string;
  /** Index into O when this is a context line, else -1. */
  ctx: number;
}

function writtenLines(fileLines: string[], O: string[], N: NewLine[], at: number, tier: number): string[] {
  const F = leadWs(fileLines[at]!);
  const P = leadWs(O[0]!);
  return N.map((n) => {
    if (n.ctx >= 0) return fileLines[at + n.ctx]!;
    if (tier !== 2) return n.text;
    if (n.text.trim() === '' || !n.text.startsWith(P)) return n.text;
    return F + n.text.slice(P.length);
  });
}

/** One line of a hunk or chunk body: context, old, new, or a `\` line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  /** True when this context line came from a wholly empty patch line (section 6's trailing-empty rule). */
  fromEmpty: boolean;
}

interface Hunk {
  A: number;
  body: BodyLine[];
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  minus: string | null | undefined; // undefined: not seen; null: /dev/null
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- `/`+++ ` header line: after the four characters, up to the first tab, spaces trimmed, a/ or b/ off. */
function headerPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0]!.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Read a unified diff into its sections (section 6); parse faults throw Exit2. */
function unifiedSections(lines: string[]): USection[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (diffOld: string | null, diffNew: string | null): USection => {
    const s: USection = { diffOld, diffNew, minus: undefined, plus: undefined, renameFrom: undefined, renameTo: undefined, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ') || line === 'diff --git') {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader || cur.minus !== undefined) cur = startSection(null, null);
      cur.minus = headerPath(line);
      cur.plus = headerPath(lines[i + 1]!);
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ') || l === 'diff --git') break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') body.push({ kind: 'ctx', text: '', fromEmpty: true });
        else if (l[0] === ' ') body.push({ kind: 'ctx', text: l.slice(1), fromEmpty: false });
        else if (l[0] === '-') body.push({ kind: 'old', text: l.slice(1), fromEmpty: false });
        else if (l[0] === '+') body.push({ kind: 'new', text: l.slice(1), fromEmpty: false });
        else if (l[0] === '\\') body.push({ kind: 'bs', text: l, fromEmpty: false });
        else break;
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.fromEmpty) body.pop();
      cur.hunks.push({ A: Number(m[1]), body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('+++ ')) cur.plus = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).split('\t')[0]!.replace(/^ +| +$/g, '');
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).split('\t')[0]!.replace(/^ +| +$/g, '');
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections;
}

/** True when a `\` line immediately follows the body's last context or `+` line (section 6's final-break rule). */
function bsAfterLastWritten(body: BodyLine[]): boolean {
  let last = -1;
  body.forEach((b, k) => {
    if (b.kind === 'ctx' || b.kind === 'new') last = k;
  });
  return last >= 0 && body[last + 1]?.kind === 'bs';
}

/** Apply a section's hunks to a file's lines in order (section 6); `path` names no-match failures. */
function applyHunks(fl: FileLines, hunks: Hunk[], strict: boolean, path: string): FileLines {
  let lines = [...fl.lines];
  let final = fl.final;
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NewLine[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        N.push({ text: b.text, ctx: O.length });
        O.push(b.text);
      } else if (b.kind === 'old') O.push(b.text);
      else if (b.kind === 'new') N.push({ text: b.text, ctx: -1 });
    }
    if (O.length === 0) {
      const at = Math.min(h.A + d, lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...N.map((n) => n.text));
      if (atEnd) final = !bsAfterLastWritten(h.body);
    } else {
      const found = findTier(lines, O, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let at = found.occ[0]!;
      for (const o of found.occ) if (Math.abs(o - target) < Math.abs(at - target)) at = o;
      const atEnd = at + O.length === lines.length;
      lines.splice(at, O.length, ...writtenLines(lines, O, N, at, found.tier));
      if (atEnd) final = !bsAfterLastWritten(h.body);
    }
    d += N.length - O.length;
  }
  return { lines, br: fl.br, final };
}

/** One unified section as an edit (section 6). */
function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.minus !== undefined ? s.minus : (s.renameFrom ?? s.diffOld);
  const newPath = s.plus !== undefined ? s.plus : (s.renameTo ?? s.diffNew);
  const creation = s.newFile || oldPath === null;
  const deletion = !creation && (s.deletedFile || newPath === null);
  return (tree) => {
    if (creation) {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const added: string[] = [];
      let lastBs = false;
      for (const h of s.hunks) {
        h.body.forEach((b, k) => {
          if (b.kind === 'new') {
            added.push(b.text);
            lastBs = h.body[k + 1]?.kind === 'bs';
          }
        });
      }
      tree.now.set(p, createdText(added, !lastBs));
      return;
    }
    const from = oldPath ?? '';
    if (!safe(from)) throw new Fail('unsafe', from);
    if (deletion) {
      if (tree.get(from) === null) throw new Fail('missing', from);
      tree.now.set(from, null);
      return;
    }
    const to = newPath ?? from;
    if (!safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (to !== from && tree.get(to) !== null) throw new Fail('exists', to);
    const out = applyHunks(splitFile(before), s.hunks, strict, from);
    tree.now.set(to, joinFile(out));
    if (to !== from) {
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

/** Read SEARCH/REPLACE blocks (section 7); parse faults throw Exit2. */
function srBlocks(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k >= searchFrom; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    let j = i + 1;
    while (j < lines.length && lines[j]!.trimEnd() !== '=======') j += 1;
    if (j >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    let k = j + 1;
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, j), newLines: lines.slice(j + 1, k) });
    prevPath = path;
    searchFrom = k + 1;
    i = k + 1;
  }
  return blocks;
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  const p = b.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdText(b.newLines));
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const fl = splitFile(before);
    const found = findTier(fl.lines, b.oldLines, strict, 0);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const N: NewLine[] = b.newLines.map((text) => ({ text, ctx: -1 }));
    fl.lines.splice(at, b.oldLines.length, ...writtenLines(fl.lines, b.oldLines, N, at, found.tier));
    tree.now.set(p, joinFile(fl));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  return srBlocks(lines).map((b) => srEdit(b, strict));
}

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  moveTo: string | undefined;
  addLines: string[];
  chunks: VChunk[];
}

/** Read a V4A patch into its sections (section 8); parse faults throw Exit2. */
function v4aSections(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  interface Raw {
    kind: 'add' | 'del' | 'upd';
    path: string;
    lineNo: number;
    raw: { text: string; no: number }[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) {
      const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : 'upd';
      cur = { kind, path: l.slice(l.indexOf(': ') + 2).trim(), lineNo: i + 1, raw: [] };
      raws.push(cur);
    } else if (cur !== null) {
      cur.raw.push({ text: l, no: i + 1 });
    } else if (!blank(l)) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  const sections: VSection[] = [];
  for (const r of raws) {
    while (r.raw.length > 0 && blank(r.raw[r.raw.length - 1]!.text)) r.raw.pop();
    const sec: VSection = { kind: r.kind, path: r.path, lineNo: r.lineNo, moveTo: undefined, addLines: [], chunks: [] };
    if (r.kind === 'add') {
      for (const { text, no } of r.raw) {
        if (text === '') sec.addLines.push('');
        else if (text[0] === '+') sec.addLines.push(text.slice(1));
        else throw new Exit2(`error: parse ${no}`);
      }
    } else if (r.kind === 'del') {
      const bad = r.raw.find((x) => !blank(x.text));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.no}`);
    } else {
      let idx = 0;
      if (r.raw[0]?.text.startsWith('*** Move to: ')) {
        sec.moveTo = r.raw[0].text.slice(13).trim();
        idx = 1;
      }
      let chunk: VChunk | null = null;
      for (; idx < r.raw.length; idx += 1) {
        const { text, no } = r.raw[idx]!;
        if (text.startsWith('@@')) {
          const anchor = text.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          sec.chunks.push(chunk);
        } else if (text.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${no}`);
          chunk.eof = true;
          chunk = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${no}`);
            chunk = { anchor: null, body: [], eof: false };
            sec.chunks.push(chunk);
          }
          if (text === '') chunk.body.push({ kind: 'ctx', text: '', fromEmpty: true });
          else if (text[0] === ' ') chunk.body.push({ kind: 'ctx', text: text.slice(1), fromEmpty: false });
          else if (text[0] === '-') chunk.body.push({ kind: 'old', text: text.slice(1), fromEmpty: false });
          else chunk.body.push({ kind: 'new', text: text.slice(1), fromEmpty: false });
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${r.lineNo}`);
    }
    sections.push(sec);
  }
  return sections;
}

/** Apply an Update File section's chunks to a file's lines, cursor and all (section 8). */
function applyChunks(fl: FileLines, chunks: VChunk[], strict: boolean, path: string): FileLines {
  const lines = [...fl.lines];
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      const found = findTier(lines, [ch.anchor], strict, cursor);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.occ[0]! + 1;
    }
    const O: string[] = [];
    const N: NewLine[] = [];
    for (const b of ch.body) {
      if (b.kind === 'ctx') {
        N.push({ text: b.text, ctx: O.length });
        O.push(b.text);
      } else if (b.kind === 'old') O.push(b.text);
      else if (b.kind === 'new') N.push({ text: b.text, ctx: -1 });
    }
    if (O.length === 0) {
      const at = ch.eof ? lines.length : cursor;
      lines.splice(at, 0, ...N.map((n) => n.text));
      cursor = at + N.length;
      continue;
    }
    const found = findTier(lines, O, strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    const occ = ch.eof ? found.occ.filter((o) => o + O.length === lines.length) : found.occ;
    if (occ.length === 0) throw new Fail('no-match', path);
    const at = occ[0]!;
    const written = writtenLines(lines, O, N, at, found.tier);
    lines.splice(at, O.length, ...written);
    cursor = at + written.length;
  }
  return { lines, br: fl.br, final: fl.final };
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  const p = s.path;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, createdText(s.addLines));
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const to = s.moveTo ?? p;
    if (!safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (to !== p && tree.get(to) !== null) throw new Fail('exists', to);
    const out = applyChunks(splitFile(before), s.chunks, strict, p);
    tree.now.set(to, joinFile(out));
    if (to !== p) {
      tree.now.set(p, null);
      tree.moves.push([p, to]);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return v4aSections(lines).map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? srEdits(lines, strict)
      : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const finalOf = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const moved = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [from, to] of tree.moves) {
    if (moved.has(from) || moved.has(to)) continue;
    if (tree.original(from) !== null && finalOf(from) === null && tree.original(to) === null && finalOf(to) !== null) {
      rows.push({ key: to, text: `R ${from} -> ${to}` });
      moved.add(from);
      moved.add(to);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || moved.has(p)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
