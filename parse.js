// parse.js — a fast, dependency-free Markdown renderer matching marked 18.1.3
// (defaults: gfm on, breaks off, pedantic off, async off), written from the
// CommonMark 0.31.2 + GFM spec and black-box probing of marked's behaviour.
// Single-pass: a line-based block parser feeding a char-scanning inline parser.
// No state is kept between parse() calls; link references live in the call's
// own state object, as does the document-wide `inA` flag that suppresses
// extended autolinks after an unclosed inline <a> tag anywhere in the doc.

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// marked's escape(): & < > " ' -> &amp; &lt; &gt; &quot; &#39;, except an &
// that starts a valid entity reference (&name;, &#123;, &#x1F600;) is kept
// verbatim -- the reference is NOT decoded, marked preserves the entity
// text. (Probes: &nbsp; &copy; &ThisIsNotDefined; &MadeUpEntity; stay;
// &#87654321; (8 digits) and &#abcdef0; (7 hex digits) are escaped.)
const ENT_REF = /^(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/;
function escapeHtml(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      // numeric character reference: #1-7 decimal digits or #x/X 1-6 hex
      // digits, then ';'. Decoded to the character (0, surrogate or
      // >0x10FFFF become U+FFFD); the decoded char is escaped if special.
      if (s.charCodeAt(i + 1) === 35) {
        let j = i + 2;
        let hex = false;
        if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
        const ds = j;
        const max = hex ? 6 : 7;
        let count = 0;
        while (count < max && j < s.length) {
          const d = s.charCodeAt(j);
          const ok = hex
            ? (d >= 48 && d <= 57) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)
            : (d >= 48 && d <= 57);
          if (!ok) break;
          j++; count++;
        }
        if (count > 0 && s.charCodeAt(j) === 59) {
          let cp = parseInt(s.slice(ds, j), hex ? 16 : 10);
          if (cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
          const ch = String.fromCodePoint(cp);
          if (ch === '&') out += '&amp;';
          else if (ch === '<') out += '&lt;';
          else if (ch === '>') out += '&gt;';
          else if (ch === '"') out += '&quot;';
          else if (ch === "'") out += '&#39;';
          else out += ch;
          i = j + 1;
          continue;
        }
      }
      const m = ENT_REF.exec(s.slice(i + 1));
      if (m) { out += '&' + m[0]; i += 1 + m[0].length; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    let j = i + 1;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Full escape for code spans and code blocks: every & becomes &amp;.
function escapeHtmlFull(s) {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

// Link-label normalisation: collapse whitespace runs to one space, trim,
// Unicode case-fold (toLowerCase is close enough for the labels in play).
function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// marked's cleanUrl: encodeURI, %25 -> %, null on throw.
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

// ---------------------------------------------------------------------------
// Character helpers (char-code based, no regex on the hot path)
// ---------------------------------------------------------------------------

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Column indent of a line, tabs counting to the next multiple of 4.
// Returns {cols, pos} where pos is the string index at that column.
function indentOf(line) {
  let col = 0, i = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) { col += 4 - (col % 4); i++; }
    else break;
  }
  return { cols: col, pos: i };
}

// Remove trailing spaces/tabs from a line.
function rtrim(line) {
  let e = line.length;
  while (e > 0) {
    const c = line.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return line.slice(0, e);
}

// Block-level HTML tag names (HTML block type 6 + inline tag recognition).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// escape() for href / title / alt / lang: escapes & only when it does NOT
// start a valid entity reference, plus < > " ' always.
const ENT_START = /&(?:#\d{1,7}|#[Xx][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/;
function escapeAttr(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 38) { // &
      const rest = s.slice(i);
      const m = ENT_START.exec(rest);
      if (m && m.index === 0) { out += m[0]; i += m[0].length; continue; }
      out += '&amp;'; i++; continue;
    }
    if (c === 60) { out += '&lt;'; i++; continue; }
    if (c === 62) { out += '&gt;'; i++; continue; }
    if (c === 34) { out += '&quot;'; i++; continue; }
    if (c === 39) { out += '&#39;'; i++; continue; }
    // copy a run of plain chars up to the next special
    let j = i + 1;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      if (d === 38 || d === 60 || d === 62 || d === 34 || d === 39) break;
      j++;
    }
    out += s.slice(i, j);
    i = j;
  }
  return out;
}

// Unescape backslash escapes: \ + ASCII punctuation -> the punctuation.
function unescapeBackslash(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && PUNCT.has(s[i + 1])) { out += s[i + 1]; i += 2; }
    else { out += s[i]; i++; }
  }
  return out;
}

function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}
const UNI_SPACE = /\s/;
const UNI_PUNCT = /[\p{P}\p{S}]/u;
function isSpaceCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c < 128 ? isSpaceCode(c) : UNI_SPACE.test(ch);
}
function isPunctCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  return c < 128 ? isAsciiPunctCode(c) : UNI_PUNCT.test(ch);
}

// Find the `]` matching the `[` at `start` (depth-aware, skipping backslash
// escapes and code spans). Returns the index of the matching `]` or -1.
function findMatchingBracket(s, start) {
  const n = s.length;
  let depth = 1;
  let i = start + 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const nx = s.charCodeAt(i + 1);
      if (nx !== undefined && isAsciiPunctCode(nx)) i += 2;
      else i += 1;
      continue;
    }
    if (c === 96) { // backtick run: skip a `+[^`]*`+ code span if present
      // (the runs need not match in length, as in the label check; this
      // keeps a stray `]` inside a code span from closing the label)
      let k = i;
      while (k < n && s.charCodeAt(k) === 96) k++;
      let j = k;
      while (j < n && s.charCodeAt(j) !== 96) j++;
      if (j < n) {
        let e = j;
        while (e < n && s.charCodeAt(e) === 96) e++;
        i = e;
      } else {
        i = k; // no closing run: the opening run is literal text
      }
      continue;
    }
    if (c === 91) { depth++; i++; continue; }
    if (c === 93) {
      depth--;
      if (depth === 0) return i;
      i++; continue;
    }
    i++;
  }
  return -1;
}

// Parse an inline link destination + optional title starting at s[pos] === '('.
// Returns {end, dest, title} (end = index just past the closing ')') or null.
function parseInlineDest(s, pos) {
  const n = s.length;
  let p = pos + 1;
  // skip spaces/tabs/newlines
  while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
  if (p >= n) return null;
  let dest = '';
  if (s.charCodeAt(p) === 60) { // <angle>
    p++;
    const start = p;
    let ok = false;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 62) { ok = true; break; }
      if (c === 10) return null; // no line endings in <...>
      if (c === 92 && p + 1 < n) { p += 2; continue; }
      p++;
    }
    if (!ok) return null;
    dest = s.slice(start, p);
    p++; // past >
  } else {
    // bare destination: no spaces/controls, balanced parens
    const start = p;
    let depth = 0;
    let ok = false;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 92 && p + 1 < n) { p += 2; continue; }
      if (c === 40) { depth++; p++; continue; }
      if (c === 41) {
        if (depth === 0) { ok = true; break; }
        depth--; p++; continue;
      }
      if (isSpaceCode(c) || c < 32) break;
      p++;
    }
    if (p === start) return null; // empty bare destination is not allowed here
    dest = s.slice(start, p);
    if (!ok && p >= n) return null;
    if (ok) { /* dest ends at this ')' — but that ')' closes the link, not the dest */ }
    // If we stopped at ')' with depth 0, the dest ends here and there is no title.
    if (p < n && s.charCodeAt(p) === 41 && depth === 0) {
      return { end: p + 1, dest: unescapeBackslash(dest), title: null };
    }
  }
  // skip spaces/tabs/newlines before an optional title
  while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
  if (p >= n) return null;
  let title = null;
  const tc = s.charCodeAt(p);
  if (tc === 41) {
    return { end: p + 1, dest: unescapeBackslash(dest), title: null };
  }
  if (tc === 34 || tc === 39 || tc === 40) {
    const open = tc;
    const close = open === 40 ? 41 : open;
    p++;
    const start = p;
    let ok = false;
    while (p < n) {
      const c = s.charCodeAt(p);
      if (c === 92 && p + 1 < n) { p += 2; continue; }
      if (c === close) { ok = true; break; }
      if (open === 40 && c === 40) return null; // no '(' inside a (...) title
      if (c === 10) {
        // a blank line inside a title is not allowed
        if (p + 1 < n && s.charCodeAt(p + 1) === 10) return null;
      }
      p++;
    }
    if (!ok) return null;
    title = s.slice(start, p);
    p++; // past close
    while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
    if (p >= n || s.charCodeAt(p) !== 41) return null;
    return { end: p + 1, dest: unescapeBackslash(dest), title: unescapeBackslash(title) };
  }
  return null;
}

// Match an <...> autolink at s[i] === '<'. Returns {end, href, text} or null.
function matchAutolink(s, i) {
  const n = s.length;
  const gt = s.indexOf('>', i + 1);
  if (gt < 0 || gt === i + 1) return null;
  const content = s.slice(i + 1, gt);
  if (content.indexOf(' ') >= 0 || content.indexOf('\n') >= 0 || content.indexOf('<') >= 0) return null;
  // scheme: letter, then 1-31 of letter/digit/+/-/. , then ':'
  let j = 0;
  if (!/[A-Za-z]/.test(content[0])) return null;
  j = 1;
  while (j < content.length && /[A-Za-z0-9+.-]/.test(content[j])) j++;
  if (j >= 2 && j <= 32 && content[j] === ':') {
    return { end: gt + 1, href: content, text: content };
  }
  // email
  if (isEmail(content)) {
    return { end: gt + 1, href: 'mailto:' + content, text: content };
  }
  return null;
}

function isEmail(s) {
  const at = s.indexOf('@');
  if (at <= 0) return false;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local)) return false;
  if (domain.indexOf('..') >= 0) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  for (const lab of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
  }
  return true;
}

// Match an extended autolink (www. / scheme / email) starting at s[i].
// `prev` is the character before i (or undefined). Returns {end, href, text}
// or null. `allowWww` is false inside link labels? No — www is allowed in
// labels only when not inLink; the caller gates the whole call.
// Cheap test: could an extended autolink start at s[j]? (scheme:// or www.)
function isExtStart(s, j) {
  const c = s.charCodeAt(j) | 32; // ascii-lowercased
  if (c === 104) { // h: http:// or https:// (case-insensitive)
    if ((s.charCodeAt(j + 1) | 32) !== 116 || (s.charCodeAt(j + 2) | 32) !== 116 || (s.charCodeAt(j + 3) | 32) !== 112) return false;
    if (s.charCodeAt(j + 4) === 58 && s.charCodeAt(j + 5) === 47 && s.charCodeAt(j + 6) === 47) return true;
    return (s.charCodeAt(j + 4) | 32) === 115 && s.charCodeAt(j + 5) === 58 && s.charCodeAt(j + 6) === 47 && s.charCodeAt(j + 7) === 47;
  }
  if (c === 102) { // f: ftp:// (case-insensitive)
    return (s.charCodeAt(j + 1) | 32) === 116 && (s.charCodeAt(j + 2) | 32) === 112 && s.charCodeAt(j + 3) === 58 && s.charCodeAt(j + 4) === 47 && s.charCodeAt(j + 5) === 47;
  }
  if (c === 119) return s.startsWith('www.', j); // w: lowercase only
  return false;
}

function matchExtended(s, i, prev) {
  const n = s.length;
  let href = null;
  let start = i;
  // scheme://
  const rest = s.slice(i);
  let m = /^(?:https?|ftp):\/\//i.exec(rest);
  if (m) {
    start = i;
    href = null; // href = the matched text itself
  } else if (rest.startsWith('www.')) {
    // www. needs a boundary before it: start, whitespace, (, *, _, ~
    if (prev !== undefined && !(isSpaceCh(prev) || prev === '(' || prev === '*' || prev === '_' || prev === '~')) return null;
    start = i;
  } else {
    return null;
  }
  // domain: labels of [A-Za-z0-9-]+ separated by '.', then a tail of [^\s<]*
  let p = start + (m ? m[0].length : 4);
  // domain labels
  let domStart = p;
  let domEnd = p;
  while (p < n) {
    const c = s.charCodeAt(p);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95) { p++; domEnd = p; continue; }
    if (c === 46) { // dot: only if followed by a label char
      const nx = s.charCodeAt(p + 1);
      if ((nx >= 48 && nx <= 57) || (nx >= 65 && nx <= 90) || (nx >= 97 && nx <= 122) || nx === 45 || nx === 95) { p++; domEnd = p; continue; }
      break;
    }
    break;
  }
  if (domEnd === domStart) return null;
  // tail: [^\s<]*
  while (p < n) {
    const c = s.charCodeAt(p);
    if (isSpaceCode(c) || c === 60) break;
    p++;
  }
  let url = s.slice(start, p);
  url = trimAutolink(url);
  if (!url) return null;
  // re-validate the domain after trimming (it must still have content)
  const afterScheme = m ? url.slice(m[0].length) : url.slice(4);
  if (!afterScheme || !/[A-Za-z0-9]/.test(afterScheme[0])) return null;
  const fullHref = m ? url : 'http://' + url;
  return { end: start + url.length, href: fullHref, text: url };
}

// Trim a raw extended-autolink match per the GFM rules: unmatched '('
// truncates, unbalanced trailing ')' is dropped, then trailing punctuation.
function trimAutolink(url) {
  // (a) truncate at the first '(' with no matching ')'
  let depth = 0;
  let firstUnmatched = -1;
  for (let k = 0; k < url.length; k++) {
    const c = url.charCodeAt(k);
    if (c === 40) { if (depth === 0) firstUnmatched = k; depth++; }
    else if (c === 41) { if (depth > 0) { depth--; if (depth === 0) firstUnmatched = -1; } }
  }
  if (firstUnmatched >= 0 && depth > 0) url = url.slice(0, firstUnmatched);
  // (b)+(c) loop: drop unbalanced trailing ')' and trailing punctuation
  for (;;) {
    let changed = false;
    // trailing ')' while unbalanced
    while (url.length && url.charCodeAt(url.length - 1) === 41) {
      let o = 0, cl = 0;
      for (let k = 0; k < url.length; k++) {
        if (url.charCodeAt(k) === 40) o++;
        else if (url.charCodeAt(k) === 41) cl++;
      }
      if (cl > o) { url = url.slice(0, -1); changed = true; }
      else break;
    }
    // trailing punctuation ? ! . , : * _ ~ and ; (with entity rule)
    while (url.length) {
      const last = url.charCodeAt(url.length - 1);
      if (last === 59) { // ;
        const em = /&(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);$/.exec(url);
        if (em) { url = url.slice(0, url.length - em[0].length); changed = true; continue; }
        url = url.slice(0, -1); changed = true; continue;
      }
      if (last === 63 || last === 33 || last === 46 || last === 44 || last === 58 || last === 42 || last === 95 || last === 126) {
        url = url.slice(0, -1); changed = true; continue;
      }
      break;
    }
    if (!changed) break;
  }
  return url;
}

// Try to match an email extended autolink whose local part ends at the '@'
// at position `at` (local part starts at or after `runStart`). The local part
// chars are [A-Za-z0-9.!#$%&'+/=?^_`{|}~-] (note: no '*'). Returns the match
// {start, end, href, text} or null.
function matchEmailAt(s, runStart, at) {
  let start = at;
  while (start > runStart) {
    const c = s.charCodeAt(start - 1);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 ||
        c === 39 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 ||
        c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45) {
      start--;
    } else break;
  }
  if (start === at) return null;
  const local = s.slice(start, at);
  // domain: labels, at least one dot, then stop at first non-domain char
  let p = at + 1;
  const n = s.length;
  let domStart = p;
  while (p < n) {
    const c = s.charCodeAt(p);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) { p++; continue; }
    if (c === 46) {
      const nx = s.charCodeAt(p + 1);
      if ((nx >= 48 && nx <= 57) || (nx >= 65 && nx <= 90) || (nx >= 97 && nx <= 122) || nx === 45) { p++; continue; }
      break;
    }
    break;
  }
  if (p === domStart) return null;
  const domain = s.slice(at + 1, p);
  if (domain.indexOf('.') < 0) return null;
  if (domain.indexOf('..') >= 0) return null;
  const labels = domain.split('.');
  for (const lab of labels) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return null;
  }
  const text = local + '@' + domain;
  return { start, end: p, href: 'mailto:' + text, text };
}

// Match an inline HTML tag at s[i] === '<'. Returns {end, selfClose, tagName,
// isClose} or null. Covers comments, PIs, declarations, CDATA and tags.
function matchTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    const e = s.indexOf('-->', i + 4);
    if (e < 0) return null;
    return { end: e + 3, selfClose: false, tagName: null, isClose: false };
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    if (e < 0) return null;
    return { end: e + 2, selfClose: false, tagName: null, isClose: false };
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    if (e < 0) return null;
    return { end: e + 3, selfClose: false, tagName: null, isClose: false };
  }
  if (s.startsWith('<!', i)) {
    const c = s.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const e = s.indexOf('>', i + 2);
      if (e < 0) return null;
      return { end: e + 1, selfClose: false, tagName: null, isClose: false };
    }
    return null;
  }
  // open / close tag
  let p = i + 1;
  let isClose = false;
  if (s.charCodeAt(p) === 47) { isClose = true; p++; }
  const nameStart = p;
  if (p >= n) return null;
  const c0 = s.charCodeAt(p);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return null;
  p++;
  while (p < n) {
    const c = s.charCodeAt(p);
    if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45) p++;
    else break;
  }
  const tagName = s.slice(nameStart, p).toLowerCase();
  // attributes
  let selfClose = false;
  for (;;) {
    while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
    if (p >= n) return null;
    const c = s.charCodeAt(p);
    if (c === 62) { p++; break; }
    if (c === 47) {
      if (s.charCodeAt(p + 1) === 62) { selfClose = true; p += 2; break; }
      return null;
    }
    // attribute name
    const a0 = s.charCodeAt(p);
    if (!((a0 >= 65 && a0 <= 90) || (a0 >= 97 && a0 <= 122) || a0 === 95 || a0 === 58)) return null;
    p++;
    while (p < n) {
      const d = s.charCodeAt(p);
      if ((d >= 48 && d <= 57) || (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || d === 95 || d === 58 || d === 46 || d === 45) p++;
      else break;
    }
    while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
    if (p < n && s.charCodeAt(p) === 61) {
      p++;
      while (p < n && isSpaceCode(s.charCodeAt(p))) p++;
      if (p >= n) return null;
      const q = s.charCodeAt(p);
      if (q === 34 || q === 39) {
        p++;
        const e = s.indexOf(String.fromCharCode(q), p);
        if (e < 0) return null;
        p = e + 1;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        let q0 = p;
        while (p < n) {
          const d = s.charCodeAt(p);
          if (isSpaceCode(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          p++;
        }
        if (p === q0) return null;
      }
    }
  }
  return { end: p, selfClose, tagName, isClose };
}

// ---------------------------------------------------------------------------
// The inline scanner. mode: 0 normal, 1 inLink (a link's label text),
// 2 plain (image alt text: no tags, no links, entities preserved).
// Returns the HTML (or plain text in mode 2). st: {refs, inA, links}.
//
// Delimiter runs (* _ ~) are emitted as their own chunks and resolved in a
// post-pass (the CommonMark delimiter algorithm, incl. the rule 9/10 odd
// match and the ~ length rule: a ~ pair only when both runs are equal and
// 1 or 2 long).
// ---------------------------------------------------------------------------

const MODE_LINK = 1;
const MODE_PLAIN = 2;

function inlineParse(s, st, mode) {
  const n = s.length;
  const out = [];
  const delims = [];
  const plain = mode === MODE_PLAIN;
  const inLink = mode === MODE_LINK;
  let i = 0;

  // Emit a raw text run [a, b): decoded + escaped (plain mode: preserved).
  const emitText = (a, b) => {
    if (b <= a) return;
    const raw = s.slice(a, b);
    out.push(escapeHtml(raw));
  };

  while (i < n) {
    const c = s.charCodeAt(i);
    // ---- www. / scheme extended autolink ----
    if (!inLink && !plain && !st.inA && (c === 119 || c === 104 || c === 72 || c === 102 || c === 70) && isExtStart(s, i)) {
      const ext = matchExtended(s, i, i > 0 ? s[i - 1] : undefined);
      if (ext) {
        const href = cleanUrl(ext.href);
        if (href !== null) {
          out.push('<a href="' + escapeAttr(href) + '">' + escapeHtml(ext.text) + '</a>');
          i = ext.end;
          continue;
        }
      }
      // not a valid autolink here: emit this one char as text
      out.push(escapeHtml(s[i]));
      i++;
      continue;
    }
    // ---- text run (stops at specials, newline, @, autolink starts) ----
    if (c !== 92 && c !== 96 && c !== 91 && c !== 33 && c !== 60 && c !== 42 && c !== 95 && c !== 126 && c !== 10 && c !== 64) {
      const runStart = i;
      let j = i;
      let emailed = false;
      while (!emailed) {
        while (j < n) {
          const d = s.charCodeAt(j);
          if (d === 92 || d === 96 || d === 91 || d === 33 || d === 60 || d === 42 || d === 95 || d === 126 || d === 10 || d === 64) break;
          if (!inLink && !plain && !st.inA && (d === 119 || d === 104 || d === 72 || d === 102 || d === 70) && isExtStart(s, j)) break;
          j++;
        }
        // '@': try an email autolink whose local part ends here
        if (j < n && s.charCodeAt(j) === 64 && !inLink && !plain) {
          const em = matchEmailAt(s, runStart, j);
          if (em) {
            const href = cleanUrl(em.href);
            if (href !== null) {
              emitText(runStart, em.start);
              out.push('<a href="' + escapeAttr(href) + '">' + escapeHtml(em.text) + '</a>');
              i = em.end;
              emailed = true;
              break;
            }
          }
          j++; // '@' is plain text: keep scanning the run
          continue;
        }
        break;
      }
      if (emailed) continue;
      if (j < n && s.charCodeAt(j) === 10) {
        // soft / hard break: count trailing spaces in the run
        let t = j;
        while (t > runStart && s.charCodeAt(t - 1) === 32) t--;
        if (j - t >= 2) {
          emitText(runStart, t);
          if (!plain) out.push('<br>');
          else out.push('\n');
          i = j + 1;
          continue;
        }
        emitText(runStart, j);
        out.push('\n');
        i = j + 1;
        continue;
      }
      emitText(runStart, j);
      i = j;
      continue;
    }

    // ---- backslash ----
    if (c === 92) {
      const nx = s.charCodeAt(i + 1);
      if (nx === 10) { // backslash + newline = hard break
        if (!plain) out.push('<br>');
        else out.push('\n');
        i += 2;
        continue;
      }
      if (nx !== undefined && isAsciiPunctCode(nx)) {
        out.push(escapeHtml(s[i + 1]));
        i += 2;
        continue;
      }
      out.push('\\');
      i += 1;
      continue;
    }

    // ---- newline (reached directly) ----
    if (c === 10) {
      out.push('\n');
      i++;
      continue;
    }

    // ---- code span ----
    if (c === 96) {
      let k = i;
      while (k < n && s.charCodeAt(k) === 96) k++;
      const run = k - i;
      let j = k;
      let found = -1;
      while (j < n) {
        if (s.charCodeAt(j) === 96) {
          let e = j;
          while (e < n && s.charCodeAt(e) === 96) e++;
          if (e - j === run) { found = j; break; }
          j = e;
        } else j++;
      }
      if (found < 0) {
        out.push('`'.repeat(run));
        i = k;
        continue;
      }
      let content = s.slice(k, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && !/^\s+$/.test(content)) {
        content = content.slice(1, -1);
      }
      if (plain) out.push(escapeAttr(content));
      else out.push('<code>' + escapeHtmlFull(content) + '</code>');
      i = found + run;
      continue;
    }

    // ---- '!' (possible image) ----
    if (c === 33) {
      if (s.charCodeAt(i + 1) === 91 && !plain) {
        const img = tryLinkOrImage(s, i + 1, st, true);
        if (img) {
          out.push(img.html);
          i = img.end;
          continue;
        }
      }
      out.push('!');
      i++;
      continue;
    }

    // ---- '[' (possible link) ----
    if (c === 91) {
      if (!plain) {
        const lnk = tryLinkOrImage(s, i, st, false);
        if (lnk) {
          out.push(lnk.html);
          i = lnk.end;
          continue;
        }
      }
      out.push('[');
      i++;
      continue;
    }

    // ---- '<' (autolink or tag) ----
    if (c === 60) {
      const au = matchAutolink(s, i);
      if (au) {
        const href = cleanUrl(au.href);
        if (href !== null) {
          if (plain) out.push(escapeAttr(au.text));
          else out.push('<a href="' + escapeAttr(href) + '">' + escapeHtml(au.text) + '</a>');
          i = au.end;
          continue;
        }
      }
      const tag = matchTag(s, i);
      if (tag) {
        if (tag.tagName === 'a') {
          if (tag.isClose) st.inA = false;
          else if (!tag.selfClose) st.inA = true;
        }
        if (plain) out.push(escapeAttr(s.slice(i, tag.end)));
        else out.push(s.slice(i, tag.end));
        i = tag.end;
        continue;
      }
      out.push('&lt;');
      i++;
      continue;
    }

    // ---- '@' reached directly (email local part is empty here) ----
    if (c === 64) {
      out.push('@');
      i++;
      continue;
    }

    // ---- delimiter runs (* _ ~) ----
    if (c === 42 || c === 95 || c === 126) {
      let k = i;
      while (k < n && s.charCodeAt(k) === c) k++;
      const run = k - i;
      const ch = String.fromCharCode(c);
      const prev = i > 0 ? s[i - 1] : ' ';
      const next = k < n ? s[k] : ' ';
      const leftFlank = !isSpaceCh(next) && (!isPunctCh(next) || isSpaceCh(prev) || isPunctCh(prev));
      const rightFlank = !isSpaceCh(prev) && (!isPunctCh(prev) || isSpaceCh(next) || isPunctCh(next));
      let canOpen, canClose;
      if (c === 95) {
        canOpen = leftFlank && (!rightFlank || isPunctCh(prev));
        canClose = rightFlank && (!leftFlank || isPunctCh(next));
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      const idx = out.length;
      out.push(ch.repeat(run));
      delims.push({ ch, len: run, idx, canOpen, canClose, ct: '', ot: '' });
      i = k;
      continue;
    }

    // fallback (should not happen)
    out.push(escapeHtml(s[i]));
    i++;
  }

  // ---- delimiter post-pass ----
  if (delims.length) resolveDelims(out, delims, plain);
  return out.join('');
}

// Resolve * _ ~ delimiter runs into <em>/<strong>/<del> (or '' in plain mode).
function resolveDelims(out, delims, plain) {
  const EM = plain ? ['', ''] : ['<em>', '</em>'];
  const STRONG = plain ? ['', ''] : ['<strong>', '</strong>'];
  const DEL = plain ? ['', ''] : ['<del>', '</del>'];
  const refresh = (d) => {
    out[d.idx] = d.ct + d.ch.repeat(d.len) + d.ot;
  };
  for (let ci = 0; ci < delims.length; ci++) {
    const closer = delims[ci];
    if (!closer.canClose || closer.len === 0) continue;
    if (closer.ch === '~') {
      // ~ pairs only with an equal-length run of 1 or 2
      for (let oi = ci - 1; oi >= 0; oi--) {
        const opener = delims[oi];
        if (opener.ch !== '~' || !opener.canOpen || opener.len === 0) continue;
        if (opener.len !== closer.len || opener.len > 2) continue;
        const use = opener.len;
        opener.len -= use;
        closer.len -= use;
        opener.ot = DEL[0] + opener.ot;
        closer.ct = closer.ct + DEL[1];
        refresh(opener);
        refresh(closer);
        break;
      }
      continue;
    }
    // * and _
    while (closer.len > 0) {
      let opener = null;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const cand = delims[oi];
        if (cand.ch !== closer.ch || !cand.canOpen || cand.len === 0) continue;
        // rule 9/10 (odd match): if EITHER delimiter can both open and
        // close, the sum of the run lengths must not be a multiple of 3
        // unless both lengths are multiples of 3
        if ((cand.canOpen && cand.canClose) || (closer.canOpen && closer.canClose)) {
          const sum = cand.len + closer.len;
          if (sum % 3 === 0 && (cand.len % 3 !== 0 || closer.len % 3 !== 0)) continue;
        }
        opener = cand;
        break;
      }
      if (!opener) break;
      const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
      opener.len -= use;
      closer.len -= use;
      if (use === 2) {
        opener.ot = STRONG[0] + opener.ot;
        closer.ct = closer.ct + STRONG[1];
      } else {
        opener.ot = EM[0] + opener.ot;
        closer.ct = closer.ct + EM[1];
      }
      refresh(opener);
      refresh(closer);
    }
  }
}

// Try to form a link (isImage=false) or image (true) starting at the '[' at
// index `lb` in s. Returns {html, end} or null (caller then emits '[' literally).
// The label is parsed inline (inLink mode for links, plain mode for images);
// a link is vetoed when its label contains a bracket-link (marked's
// nested-link rule), in which case this returns null.
// A link/image label cannot contain a backtick that is not part of a
// code span as matched by `+[^`]*`+ (opening run, non-backtick content,
// closing run; the two runs need NOT have the same length). An unmatched
// backtick, or a code span holding a backtick, blocks the link.
function labelHasBadBacktick(s) {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n && isAsciiPunctCode(s.charCodeAt(i + 1))) { i += 2; continue; }
    if (c !== 96) { i++; continue; }
    let k = i;
    while (k < n && s.charCodeAt(k) === 96) k++;
    let j = k;
    while (j < n && s.charCodeAt(j) !== 96) j++;
    if (j >= n) return true; // no closing backtick run
    let e = j;
    while (e < n && s.charCodeAt(e) === 96) e++;
    i = e;
  }
  return false;
}

function tryLinkOrImage(s, lb, st, isImage) {
  const close = findMatchingBracket(s, lb);
  if (close < 0) return null;
  const label = s.slice(lb + 1, close);
  if (label.length > 999) return null;
  if (labelHasBadBacktick(label)) return null;
  const after = close + 1;
  let href = null;
  let title = null;
  let end = -1;
  if (s.charCodeAt(after) === 40) { // ( inline
    const d = parseInlineDest(s, after);
    if (!d) return null; // a '(' claims the link: no fallback to shortcut
    href = d.dest;
    title = d.title;
    end = d.end;
  } else if (s.charCodeAt(after) === 91) { // [ full / collapsed
    const refClose = findMatchingBracket(s, after);
    if (refClose >= 0) {
      const refLabel = s.slice(after + 1, refClose);
      if (refLabel.length <= 999) {
        const key = refLabel === '' ? label : refLabel;
        const ref = st.refs.get(normalizeLabel(key));
        if (ref) {
          href = ref.href;
          title = ref.title;
          end = refClose + 1;
        }
      }
    }
    if (end < 0) {
      // fall back to shortcut
      const ref = st.refs.get(normalizeLabel(label));
      if (!ref) return null;
      href = ref.href;
      title = ref.title;
      end = after;
    }
  } else { // shortcut
    const ref = st.refs.get(normalizeLabel(label));
    if (!ref) return null;
    href = ref.href;
    title = ref.title;
    end = after;
  }
  const clean = cleanUrl(href);
  if (clean === null) return null;
  if (isImage) {
    const alt = inlineParse(label, st, MODE_PLAIN);
    let html = '<img src="' + escapeAttr(clean) + '" alt="' + alt + '"';
    if (title !== null && title !== undefined) html += ' title="' + escapeAttr(title) + '"';
    html += '>';
    return { html, end };
  }
  // link: parse the label, veto when it contains a bracket-link
  const inABefore = st.inA;
  const linksBefore = st.links;
  const labelHtml = inlineParse(label, st, MODE_LINK);
  if (st.links > linksBefore) {
    st.inA = inABefore; // the vetoed label will be re-parsed by the caller
    return null;
  }
  st.links++;
  let html = '<a href="' + escapeAttr(clean) + '"';
  if (title !== null && title !== undefined) html += ' title="' + escapeAttr(title) + '"';
  html += '>' + labelHtml + '</a>';
  return { html, end };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// --- line classifiers (all take the line and its indent info) ---

function matchAtx(line, ind) {
  const content = line.slice(ind.pos);
  if (content.charCodeAt(0) !== 35) return null;
  let h = 0;
  while (h < content.length && content.charCodeAt(h) === 35) h++;
  if (h > 6) return null;
  if (h === content.length) return { level: h, text: '' };
  const nx = content.charCodeAt(h);
  if (nx !== 32 && nx !== 9) return null;
  let p = h;
  while (p < content.length && (content.charCodeAt(p) === 32 || content.charCodeAt(p) === 9)) p++;
  let text = rtrim(content.slice(p));
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+$/, '');
  return { level: h, text };
}

function matchFence(line, ind) {
  const content = line.slice(ind.pos);
  const ch = content.charCodeAt(0);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (len < content.length && content.charCodeAt(len) === ch) len++;
  if (len < 3) return null;
  const info = content.slice(len);
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  return { char: String.fromCharCode(ch), len, info, indent: ind.cols };
}

// Is `content` the closing fence of `fence` (same char, run >= opening,
// nothing but spaces/tabs after, indent <= 3)?
function isFenceClose(content, fence) {
  const ind = indentOf(content);
  if (ind.cols > 3) return false;
  const c = content.slice(ind.pos);
  const ch = c.charCodeAt(0);
  if (ch !== fence.char.charCodeAt(0)) return false;
  let len = 0;
  while (len < c.length && c.charCodeAt(len) === ch) len++;
  return len >= fence.len && /^[ \\t]*$/.test(c.slice(len));
}

function isHrLine(line, ind) {
  const content = line.slice(ind.pos);
  if (!content) return false;
  const ch = content.charCodeAt(0);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    const c = content.charCodeAt(i);
    if (c === ch) count++;
    else if (c !== 32 && c !== 9) return false;
  }
  return count >= 3;
}

// 0 = not a setext underline, 1 = '=', 2 = '-'
function isSetextLine(line, ind) {
  if (ind.cols > 3) return 0;
  const content = line.slice(ind.pos);
  if (!content) return 0;
  const ch = content.charCodeAt(0);
  if (ch !== 61 && ch !== 45) return 0;
  let i = 0;
  while (i < content.length && content.charCodeAt(i) === ch) i++;
  while (i < content.length) {
    const c = content.charCodeAt(i);
    if (c !== 32 && c !== 9) return 0;
    i++;
  }
  return ch === 61 ? 1 : 2;
}

// List marker. Returns null or {type, bullet, delim, num, indentCols,
// contentIndent, content (string), rest}.
function parseMarker(line, ind) {
  if (ind.cols > 3) return null;
  const p = ind.pos;
  const n = line.length;
  let type, bullet = '', delim = '', num = 0, markerEnd = p;
  const c0 = line.charCodeAt(p);
  if (c0 === 45 || c0 === 43 || c0 === 42) {
    type = 'bullet';
    bullet = line[p];
    markerEnd = p + 1;
  } else if (c0 >= 48 && c0 <= 57) {
    let q = p;
    while (q < n && line.charCodeAt(q) >= 48 && line.charCodeAt(q) <= 57) q++;
    if (q - p > 9) return null;
    const dc = line.charCodeAt(q);
    if (dc !== 46 && dc !== 41) return null;
    type = 'ordered';
    delim = line[q];
    num = parseInt(line.slice(p, q), 10);
    markerEnd = q + 1;
  } else return null;
  // the marker must be followed by space/tab or EOL
  if (markerEnd < n) {
    const nx = line.charCodeAt(markerEnd);
    if (nx !== 32 && nx !== 9) return null;
  }
  const markerEndCol = ind.cols + (markerEnd - p);
  // whitespace after the marker, in columns
  let col = markerEndCol;
  let q = markerEnd;
  while (q < n) {
    const c = line.charCodeAt(q);
    if (c === 32) { col++; q++; }
    else if (c === 9) { col += 4 - (col % 4); q++; }
    else break;
  }
  const wsCols = col - markerEndCol;
  let contentIndent;
  if (q >= n) contentIndent = markerEndCol + 1;
  else if (wsCols >= 5) contentIndent = markerEndCol + 1;
  else contentIndent = col;
  // content = the line after removing (contentIndent - markerEndCol)
  // columns from the marker end, expanding the surviving leading tabs to
  // spaces using their absolute columns.
  const content = dedentExpand(line.slice(markerEnd), markerEndCol, contentIndent - markerEndCol);
  return { type, bullet, delim, num, indentCols: ind.cols, contentIndent, content, markerEndCol };
}

// Blockquote marker: returns the content after '>' (and one space/tab) or null.
function matchBQ(line, ind) {
  if (ind.cols > 3) return null;
  if (line.charCodeAt(ind.pos) !== 62) return null;
  const p = ind.pos + 1; // index just after '>'
  // remove one column of following whitespace (if any), expanding the
  // surviving leading tabs to spaces using their absolute columns.
  return dedentExpand(line.slice(p), ind.cols + 1, 1);
}

function matchHtmlBlock(line, ind) {
  if (ind.cols > 3) return null;
  const content = line.slice(ind.pos);
  if (content.charCodeAt(0) !== 60) return null;
  const low = content.toLowerCase();
  const m1 = /^<(script|pre|style|textarea)([\s>]|$)/.exec(low);
  if (m1) return { type: 1, tag: m1[1] };
  if (low.startsWith('<!--')) return { type: 2 };
  if (low.startsWith('<?')) return { type: 3 };
  if (/^<![a-z]/.test(low)) return { type: 4 };
  if (low.startsWith('<![cdata[')) return { type: 5 };
  const m6 = /^<\/?([a-z][a-z0-9-]*)([\s>\/]|$)/.exec(low);
  if (m6 && BLOCK_TAGS.has(m6[1])) return { type: 6 };
  // type 7: a single complete tag alone on the line
  const tag = matchTag(content, 0);
  if (tag) {
    const rest = content.slice(tag.end);
    if (/^[ \t]*$/.test(rest)) return { type: 7 };
  }
  return null;
}

// HTML block types 1-6 (those that can interrupt a paragraph), else null.
function matchHtmlBlock16(line, ind) {
  const h = matchHtmlBlock(line, ind);
  if (h && h.type <= 6) return h;
  return null;
}

// Whether this line, at a paragraph start, would interrupt a paragraph.
// inList: the innermost block container is a list item (set by a list
// item's content, reset by a blockquote's content). Inside a list item any
// ordered marker interrupts a paragraph; elsewhere only '1.' does.
function interruptsParagraph(line, inList) {
  const ind = indentOf(line);
  if (ind.cols >= 4) return false;
  if (isBlankLine(line)) return true;
  const content = line.slice(ind.pos);
  if (matchAtx(line, ind)) return true;
  if (matchFence(line, ind)) return true;
  if (isSetextLine(line, ind)) return false;
  if (isHrLine(line, ind)) return true;
  if (matchBQ(line, ind) !== null) return true;
  const mk = parseMarker(line, ind);
  if (mk) {
    const hasContent = mk.content.trim() !== '';
    if (mk.type === 'bullet' && hasContent) return true;
    if (mk.type === 'ordered' && (inList || mk.num === 1) && hasContent) return true;
    return false;
  }
  if (matchHtmlBlock16(line, ind)) return true;
  return false;
}

// Whether a line is paragraph continuation text. lazy: the line has no
// container marker, so any list marker ends the container instead.
function isParaLine(line, inPara, inList, lazy) {
  if (isBlankLine(line)) return false;
  const ind = indentOf(line);
  if (!inPara && ind.cols >= 4) return false;
  if (matchAtx(line, ind)) return false;
  if (matchFence(line, ind)) return false;
  if (isSetextLine(line, ind)) return false;
  if (isHrLine(line, ind)) return false;
  if (matchBQ(line, ind) !== null) return false;
  const mk = parseMarker(line, ind);
  if (mk) {
    const hasContent = mk.content.trim() !== '';
    if (mk.type === 'bullet' && hasContent) return false;
    if (mk.type === 'ordered' && (lazy || inList || mk.num === 1) && hasContent) return false;
  }
  if (matchHtmlBlock16(line, ind)) return false;
  return true;
}

// --- tables ---

function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      if (line.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
      cur += line[i] + line[i + 1]; i += 2; continue;
    }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += line[i]; i++;
  }
  cells.push(cur);
  let p = 0;
  while (p < n && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
  if (line.charCodeAt(p) === 124 && cells.length && cells[0].trim() === '') cells.shift();
  let e = n;
  while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e > 0 && line.charCodeAt(e - 1) === 124 && cells.length && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

// Returns the alignment array or null when the line is not a delimiter row.
function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.charCodeAt(0) === 58;
    const right = cell.charCodeAt(cell.length - 1) === 58;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

function hasUnescapedPipe(line) {
  for (let i = 0; i < line.length; i++) {
    if (line.charCodeAt(i) === 124) {
      let bs = 0;
      let j = i - 1;
      while (j >= 0 && line.charCodeAt(j) === 92) { bs++; j--; }
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

// --- link reference definitions ---

function skipDefWs(t, p) {
  while (p < t.length) {
    const c = t.charCodeAt(p);
    if (c === 32 || c === 9) { p++; continue; }
    if (c === 10) {
      let q = p + 1;
      while (q < t.length && (t.charCodeAt(q) === 32 || t.charCodeAt(q) === 9)) q++;
      if (q >= t.length || t.charCodeAt(q) === 10) return -1;
      p = q;
      continue;
    }
    break;
  }
  return p;
}

function parseDefDest(t, p) {
  if (t.charCodeAt(p) === 60) {
    p++;
    const start = p;
    while (p < t.length) {
      const c = t.charCodeAt(p);
      if (c === 62) return { dest: t.slice(start, p), end: p + 1 };
      if (c === 10) return null;
      if (c === 92 && p + 1 < t.length) { p += 2; continue; }
      p++;
    }
    return null;
  }
  const start = p;
  let depth = 0;
  while (p < t.length) {
    const c = t.charCodeAt(p);
    if (c === 92 && p + 1 < t.length) { p += 2; continue; }
    if (c === 40) { depth++; p++; continue; }
    if (c === 41) { if (depth === 0) break; depth--; p++; continue; }
    if (isSpaceCode(c) || c < 32) break;
    p++;
  }
  if (p === start) return null;
  return { dest: t.slice(start, p), end: p };
}

function parseDefTitle(t, p) {
  const open = t.charCodeAt(p);
  if (open !== 34 && open !== 39 && open !== 40) return null;
  const close = open === 40 ? 41 : open;
  p++;
  const start = p;
  while (p < t.length) {
    const c = t.charCodeAt(p);
    if (c === 92 && p + 1 < t.length) { p += 2; continue; }
    if (c === close) return { title: t.slice(start, p), end: p + 1 };
    if (open === 40 && c === 40) return null;
    if (c === 10) {
      if (p + 1 < t.length && t.charCodeAt(p + 1) === 10) return null;
    }
    p++;
  }
  return null;
}

// Try to parse a link reference definition starting at lines[i].
// Returns the number of lines consumed, or 0 when it is not a definition.
function parseDef(lines, i, b, st) {
  const win = [];
  for (let k = i; k < Math.min(b, i + 6); k++) win.push(lines[k]);
  const t = win.join('\n');
  let p = 0;
  let col = 0;
  while (p < t.length) {
    const c = t.charCodeAt(p);
    if (c === 32) { col++; p++; }
    else if (c === 9) { col += 4 - (col % 4); p++; }
    else break;
    if (col > 3) return 0;
  }
  if (t.charCodeAt(p) !== 91) return 0;
  const close = findMatchingBracket(t, p);
  if (close < 0) return 0;
  const label = t.slice(p + 1, close);
  if (!label || label.length > 999) return 0;
  p = close + 1;
  if (t.charCodeAt(p) !== 58) return 0;
  p++;
  p = skipDefWs(t, p);
  if (p < 0) return 0;
  const d = parseDefDest(t, p);
  if (!d) return 0;
  p = d.end;
  // The title: on the same line after whitespace, or on the next line
  // after whitespace. It must be separated from the destination by at
  // least one whitespace character; when there is no title the definition
  // ends at the destination's line (the next line is a separate block).
  let title = null;
  let q = p;
  while (q < t.length && (t.charCodeAt(q) === 32 || t.charCodeAt(q) === 9)) q++;
  if (q < t.length && (t.charCodeAt(q) === 34 || t.charCodeAt(q) === 39 || t.charCodeAt(q) === 40)) {
    if (q === p) return 0; // no whitespace between the dest and the title
    const ti = parseDefTitle(t, q);
    if (!ti) return 0;
    title = ti.title;
    p = ti.end;
    while (p < t.length && (t.charCodeAt(p) === 32 || t.charCodeAt(p) === 9)) p++;
    if (p < t.length && t.charCodeAt(p) !== 10) return 0;
  } else if (q < t.length && t.charCodeAt(q) === 10) {
    let r = q + 1;
    while (r < t.length && (t.charCodeAt(r) === 32 || t.charCodeAt(r) === 9)) r++;
    if (r < t.length && t.charCodeAt(r) !== 10 && (t.charCodeAt(r) === 34 || t.charCodeAt(r) === 39 || t.charCodeAt(r) === 40)) {
      const ti = parseDefTitle(t, r);
      if (!ti) return 0;
      title = ti.title;
      p = ti.end;
      while (p < t.length && (t.charCodeAt(p) === 32 || t.charCodeAt(p) === 9)) p++;
      if (p < t.length && t.charCodeAt(p) !== 10) return 0;
    } else {
      p = q; // no title; the definition ends at the destination's line
    }
  } else if (q < t.length) {
    return 0; // junk after the destination on the same line
  } else {
    p = q; // end of the window
  }
  const consumed = t.slice(0, p).split('\n').length;
  const key = normalizeLabel(label);
  if (!st.refs.has(key)) {
    st.refs.set(key, { href: unescapeBackslash(d.dest), title: title === null ? null : unescapeBackslash(title) });
  }
  return consumed;
}

// --- code blocks ---

// Remove `cols` columns of indentation from a line. `straddle` is 'remove'
// (drop a tab that crosses the boundary) or 'spaces' (replace it with the
// remaining spaces).
// Remove up to `cols` columns of leading whitespace (tab-aware, absolute
// columns); the remainder is verbatim. A tab ending exactly on the boundary
// is removed whole; a tab straddling it leaves (col + w - cols) spaces.
// Used for indented code and blockquote lazy lines (cols is always 4 there,
// so a tab never straddles the boundary).
function dedentLine(line, cols) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < cols) {
    const c = line.charCodeAt(i);
    if (c === 32) { col++; i++; }
    else if (c === 9) {
      const w = 4 - (col % 4);
      if (col + w > cols) return ' '.repeat(col + w - cols) + line.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

// Remove up to `n` columns of leading whitespace, where the line's first
// char is at absolute column `baseCol`; the remaining leading tabs are
// expanded to spaces using their absolute columns, and the rest of the line
// (from the first non-whitespace char) is verbatim. Used for list-item and
// blockquote dedents, where marked expands the surviving indent to spaces.
function dedentExpand(line, baseCol, n) {
  let i = 0;
  let col = baseCol;
  let out = '';
  const cut = baseCol + n;
  const len = line.length;
  while (i < len) {
    const c = line.charCodeAt(i);
    if (c === 32) {
      if (col < cut) { col++; i++; }
      else { out += ' '; col++; i++; }
    } else if (c === 9) {
      const w = 4 - (col % 4);
      const end = col + w;
      if (end <= cut) { col = end; i++; }
      else if (col < cut) { out += ' '.repeat(end - cut); col = end; i++; }
      else { out += ' '.repeat(w); col = end; i++; }
    } else break;
  }
  return out + line.slice(i);
}

// Remove up to `n` leading whitespace characters (space or tab, each one
// character) -- the fenced-code dedent. A tab is removed whole even when it
// spans more than the remaining count.
function dedentChars(line, n) {
  let i = 0;
  while (i < n && i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return line.slice(i);
}

function parseIndentedCode(lines, i, b) {
  const content = [];
  let j = i;
  while (j < b) {
    const line = lines[j];
    if (isBlankLine(line)) { content.push(dedentLine(line, 4)); j++; continue; }
    const ind = indentOf(line);
    if (ind.cols < 4) break;
    content.push(dedentLine(line, 4));
    j++;
  }
  while (content.length && isBlankLine(content[content.length - 1])) content.pop();
  const text = content.length ? content.join('\n') + '\n' : '';
  return { html: '<pre><code>' + escapeHtmlFull(text) + '</code></pre>\n', next: j };
}

function parseFencedCode(lines, i, b, fence) {
  const content = [];
  let j = i + 1;
  while (j < b) {
    const line = lines[j];
    const ind = indentOf(line);
    if (ind.cols <= 3) {
      const c = line.slice(ind.pos);
      const ch = c.charCodeAt(0);
      if (ch === fence.char.charCodeAt(0)) {
        let len = 0;
        while (len < c.length && c.charCodeAt(len) === ch) len++;
        if (len >= fence.len && /^[ \t]*$/.test(c.slice(len))) {
          j++;
          break;
        }
      }
    }
    content.push(dedentChars(line, fence.indent));
    j++;
  }
  // Fenced code keeps all content lines except exactly one trailing
  // empty line (a whitespace-only last line is kept verbatim).
  if (content.length && content[content.length - 1] === '') content.pop();
  const lang = unescapeBackslash(fence.info.trim().split(/\s+/)[0] || '');
  const text = content.length ? content.join('\n') + '\n' : '';
  const cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : '';
  return { html: '<pre><code' + cls + '>' + escapeHtmlFull(text) + '</code></pre>\n', next: j };
}

// --- HTML blocks ---

function parseHtmlBlock(lines, i, b, info, st, isTop) {
  let end = i;
  if (info.type === 1) {
    const needle = '</' + info.tag;
    while (end < b) {
      const low = lines[end].toLowerCase();
      const idx = low.indexOf(needle);
      if (idx >= 0) {
        const after = low.charCodeAt(idx + needle.length);
        if (after === undefined || after === 62 || after === 32 || after === 9) { end++; break; }
      }
      end++;
    }
  } else if (info.type === 2) {
    while (end < b && lines[end].indexOf('-->') < 0) end++;
    if (end < b) end++;
  } else if (info.type === 3) {
    while (end < b && lines[end].indexOf('?>') < 0) end++;
    if (end < b) end++;
  } else if (info.type === 4) {
    while (end < b && lines[end].indexOf('>') < 0) end++;
    if (end < b) end++;
  } else if (info.type === 5) {
    while (end < b && lines[end].indexOf(']]>') < 0) end++;
    if (end < b) end++;
  } else {
    // types 6 and 7: continue while lines are non-blank
    end = i + 1;
    while (end < b && !isBlankLine(lines[end])) end++;
  }
  if (end > b) end = b;
  let text = lines.slice(i, end).join('\n');
  // Trailing newline: the source has one after the block's last line, and
  // the next line within this container is not blank (or, at the top level,
  // the block runs to the end of the document and the source ends with \n).
  // A nested block that ends its container never gets the trailing newline.
  const nextLine = end < b ? lines[end] : undefined;
  const hadNL = nextLine !== undefined || (isTop && st.endsNL);
  if (hadNL && (nextLine === undefined || !isBlankLine(nextLine))) text += '\n';
  return { html: text, next: end };
}

// --- blockquote ---

function parseBlockquote(lines, i, b, st, isTop) {
  const inner = [];
  let j = i;
  let inPara = false;
  let prevLazy = false; // the last line added was a lazy line
  let fence = null; // {char, len} while inside a fenced code block
  while (j < b) {
    const line = lines[j];
    const ind = indentOf(line);
    const content = matchBQ(line, ind);
    if (content !== null) {
      inner.push(content);
      prevLazy = false;
      if (fence) {
        if (isFenceClose(content, fence)) fence = null;
        inPara = false;
      } else {
        const f = matchFence(content, indentOf(content));
        if (f && f.indent <= 3) { fence = f; inPara = false; }
        else inPara = isParaLine(content, inPara, false, false);
      }
      j++;
      continue;
    }
    if (isBlankLine(line)) {
      // A blank line with no '>' marker ends the blockquote (a later '>'
      // line starts a new one); a blank line WITH the marker is handled
      // above via matchBQ.
      break;
    }
    // A lazy setext line (= run or --, but not --- which is an hr) is a
    // lazy line too; it is paragraph text, and when it follows another
    // lazy line it is indented by 4 (so it is not a setext underline).
    const li0 = indentOf(line);
    const lazySetext = isSetextLine(line, li0) && !isHrLine(line, li0);
    if (inPara && !fence && (isParaLine(line, true, false, true) || lazySetext)) {
      // lazy line: dedent by 4 columns when indented that far, remainder
      // verbatim (a tab survives as a tab).
      const li = indentOf(line);
      let lazy = li.cols >= 4 ? dedentLine(line, 4) : line;
      if (lazySetext && prevLazy) lazy = '    ' + lazy;
      inner.push(lazy);
      inPara = true;
      prevLazy = true;
      j++;
      continue;
    }
    break;
  }
  const sub = renderBlocks(inner, 0, inner.length, st, false, false);
  return { parts: ['<blockquote>\n', sub.parts, '</blockquote>\n'], next: j };
}

// --- lists ---

function sameListKind(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'bullet') return a.bullet === b.bullet;
  return a.delim === b.delim;
}

function parseList(lines, i, b, st, isTop) {
  const first = parseMarker(lines[i], indentOf(lines[i]));
  const baseIndent = first.indentCols;
  const items = [];
  let blankBetween = false;
  let j = i;
  let cur = null; // {lines, contentIndent}
  let pending = [];
  let inPara = false; // the current item's content ends with an open paragraph
  let fence = null; // {char, len} while inside a fenced code block
  const flushItem = () => {
    if (cur && cur.lines.length) {
      // strip trailing blank lines from the item
      while (cur.lines.length && cur.lines[cur.lines.length - 1] === '') cur.lines.pop();
      if (cur.lines.length) items.push(cur);
    }
    cur = null;
  };
  while (j < b) {
    const line = lines[j];
    if (isBlankLine(line)) { pending.push(''); j++; continue; }
    const ind = indentOf(line);
    const mk = parseMarker(line, ind);
    // A marker is a sibling item when its indent is below the current
    // item's content indent (the content indent moves with each item, so
    // items at indents 0..3 can share one list). At or above the content
    // indent it is content of the current item (a nested list).
    if (mk && sameListKind(mk, first) && !isHrLine(line, ind) && (!cur || mk.indentCols < cur.contentIndent)) {
      if (cur) {
        if (pending.length) blankBetween = true;
        flushItem();
      }
      cur = { lines: [mk.content], contentIndent: mk.contentIndent };
      fence = null;
      const mf = matchFence(mk.content, indentOf(mk.content));
      if (mf && mf.indent <= 3) { fence = mf; inPara = false; }
      else inPara = isParaLine(mk.content, false, true, false);
      pending = [];
      j++;
      continue;
    }
    if (!cur) break; // no item yet and not a marker: shouldn't happen
    // indented content line? (leading tabs expanded to spaces)
    if (ind.cols >= cur.contentIndent) {
      const dedented = dedentExpand(line, 0, cur.contentIndent);
      const hadBlank = pending.length > 0;
      cur.lines.push(...pending, dedented);
      if (fence) {
        if (isFenceClose(dedented, fence)) fence = null;
        inPara = false;
      } else {
        const f = matchFence(dedented, indentOf(dedented));
        if (f && f.indent <= 3) { fence = f; inPara = false; }
        else inPara = isParaLine(dedented, hadBlank ? false : inPara, true, false);
      }
      pending = [];
      j++;
      continue;
    }
    // Inside a fenced code block, a line is code content regardless of
    // indent (a fence close is recognised by its dedented form).
    if (fence) {
      const dedented = dedentExpand(line, 0, cur.contentIndent);
      cur.lines.push(...pending, dedented);
      if (isFenceClose(dedented, fence)) fence = null;
      inPara = false;
      pending = [];
      j++;
      continue;
    }
    // lazy continuation? Only when no blank line intervened (a blank line
    // closes the item's paragraph) and the item ends in an open paragraph.
    // A lazy line is dedented by the content indent, and by 4 more columns
    // when at least 4 remain.
    const lsi = indentOf(line);
    const lazySetext = isSetextLine(line, lsi) && !isHrLine(line, lsi);
    if (pending.length === 0 && inPara && (isParaLine(line, true, true, true) || lazySetext)) {
      let lazy = dedentExpand(line, 0, cur.contentIndent);
      if (indentOf(lazy).cols >= 4) lazy = lazy.slice(4);
      cur.lines.push(lazy);
      inPara = true;
      j++;
      continue;
    }
    break;
  }
  flushItem();
  // Trailing blank lines consumed into `pending` are not part of the list;
  // rewind so the caller sees them (they separate the list from the next
  // block, which decides the parent list's looseness).
  const next = j - pending.length;
  // render items
  let loose = blankBetween;
  const itemParts = [];
  for (const item of items) {
    const sub = renderBlocks(item.lines, 0, item.lines.length, st, false, true);
    if (sub.blankSeparated) loose = true;
    // task checkbox: the item is a task when its first line (the marker's
    // content) starts with [ ]/[x]/[X] + space/tab. The checkbox is stripped
    // from the first paragraph's text AFTER block parsing, so `[x] # head`
    // stays literal text and `[x] \`\`\` stays a paragraph; the <input>
    // is prepended to that paragraph's content.
    const firstLine = item.lines[0] || '';
    const tm = /^\[( |x|X)\][ \t]/.exec(firstLine);
    if (tm) {
      const checkbox = tm[1] === ' ' ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ';
      const strip = (parts) => {
        for (const p of parts) {
          if (typeof p === 'string') continue;
          if (Array.isArray(p)) { if (strip(p)) return true; continue; }
          if (p.kind === 'para') {
            const sm = /^\[( |x|X)\][ \t]+/.exec(p.text);
            if (sm) {
              const rest = p.text.slice(sm[0].length);
              if (rest === '') return false; // [x] + only whitespace: not a task
              p.text = rest; p.checkbox = checkbox; return true;
            }
          }
          return false;
        }
        return false;
      };
      strip(sub.parts);
    }
    const parts = ['<li>'];
    parts.push(sub.parts);
    parts.push('</li>\n');
    itemParts.push({ parts, directJobs: sub.directJobs });
  }
  if (!loose) {
    for (const it of itemParts) {
      for (const job of it.directJobs) job.tight = true;
    }
  }
  const tag = first.type === 'bullet'
    ? '<ul>\n'
    : first.num === 1 ? '<ol>\n' : '<ol start="' + first.num + '">\n';
  const parts = [tag];
  for (const it of itemParts) parts.push(it.parts);
  parts.push(first.type === 'bullet' ? '</ul>\n' : '</ol>\n');
  return { parts, next };
}

// --- paragraph / table ---

function parseParagraph(lines, i, b, st, inList) {
  // table? header line + delimiter row; the header must have exactly as
  // many cells as the delimiter row, else this is not a table at all.
  if (i + 1 < b && hasUnescapedPipe(lines[i])) {
    const aligns = parseDelimiterRow(lines[i + 1]);
    if (aligns) {
      const headerCells = splitTableRow(lines[i]);
      if (headerCells.length === aligns.length) {
      const cols = aligns.length;
      const rows = [];
      let j = i + 2;
      while (j < b) {
        const line = lines[j];
        if (isBlankLine(line)) break;
        const ind = indentOf(line);
        if (ind.cols <= 3 && line.slice(ind.pos).charCodeAt(0) === 62) break; // '>'
        let cells = splitTableRow(line);
        while (cells.length < cols) cells.push('');
        cells = cells.slice(0, cols);
        rows.push(cells);
        j++;
      }
      return { parts: [{ kind: 'table', header: headerCells, aligns, rows }], next: j };
      }
    }
  }
  // paragraph lines; a setext underline ends the paragraph as a heading
  const textLines = [lines[i]];
  let j = i + 1;
  while (j < b) {
    const line = lines[j];
    if (isBlankLine(line)) break;
    const lv = isSetextLine(line, indentOf(line));
    if (lv) {
      const text = textLines.join('\n').trim();
      return { parts: [{ kind: 'heading', level: lv, text }], next: j + 1 };
    }
    if (interruptsParagraph(line, inList)) break;
    textLines.push(line);
    j++;
  }
  return { parts: [{ kind: 'para', text: textLines.join('\n'), tight: false }], next: j };
}

// --- the block renderer ---

function renderBlocks(lines, a, b, st, isTop, inList) {
  const parts = [];
  const directJobs = [];
  let blankSeparated = false;
  let seenBlock = false;
  let lastWasBlank = false;
  let i = a;
  const pushBlock = (p) => {
    if (seenBlock && lastWasBlank) blankSeparated = true;
    seenBlock = true;
    lastWasBlank = false;
    parts.push(p);
  };
  const pushJob = (job) => {
    if (seenBlock && lastWasBlank) blankSeparated = true;
    seenBlock = true;
    lastWasBlank = false;
    parts.push(job);
    directJobs.push(job);
  };
  while (i < b) {
    const line = lines[i];
    if (isBlankLine(line)) { lastWasBlank = true; i++; continue; }
    const ind = indentOf(line);
    if (ind.cols >= 4) {
      const code = parseIndentedCode(lines, i, b);
      pushBlock(code.html);
      i = code.next;
      continue;
    }
    const defN = parseDef(lines, i, b, st);
    if (defN > 0) { i += defN; continue; }
    const atx = matchAtx(line, ind);
    if (atx) {
      pushJob({ kind: 'heading', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    const fence = matchFence(line, ind);
    if (fence) {
      const code = parseFencedCode(lines, i, b, fence);
      pushBlock(code.html);
      i = code.next;
      continue;
    }
    if (isHrLine(line, ind)) {
      pushBlock('<hr>\n');
      i++;
      continue;
    }
    if (matchBQ(line, ind) !== null) {
      const bq = parseBlockquote(lines, i, b, st, isTop);
      pushBlock(bq.parts);
      i = bq.next;
      continue;
    }
    const mk = parseMarker(line, ind);
    if (mk) {
      const list = parseList(lines, i, b, st, isTop);
      pushBlock(list.parts);
      i = list.next;
      continue;
    }
    const hb = matchHtmlBlock(line, ind);
    if (hb) {
      const html = parseHtmlBlock(lines, i, b, hb, st, isTop);
      pushBlock(html.html);
      i = html.next;
      continue;
    }
    const para = parseParagraph(lines, i, b, st, inList);
    for (const p of para.parts) pushJob(p);
    i = para.next;
  }
  return { parts, directJobs, blankSeparated };
}

function renderTable(job, st) {
  let out = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < job.header.length; k++) {
    const al = job.aligns[k];
    out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inlineParse(job.header[k], st, 0) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  if (job.rows.length) {
    out += '<tbody>';
    for (const row of job.rows) {
      out += '<tr>\n';
      for (let k = 0; k < row.length; k++) {
        const al = job.aligns[k];
        out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inlineParse(row[k], st, 0) + '</td>\n';
      }
      out += '</tr>\n';
    }
    out += '</tbody></table>\n';
  } else {
    out += '</table>\n';
  }
  return out;
}

function renderParts(parts, st, out) {
  for (const p of parts) {
    if (typeof p === 'string') out.push(p);
    else if (Array.isArray(p)) renderParts(p, st, out);
    else if (p.kind === 'para') {
      const html = inlineParse(p.text, st, 0);
      const cb = p.checkbox ? p.checkbox : '';
      out.push(p.tight ? cb + html : '<p>' + cb + html + '</p>\n');
    } else if (p.kind === 'heading') {
      out.push('<h' + p.level + '>' + inlineParse(p.text, st, 0) + '</h' + p.level + '>\n');
    } else if (p.kind === 'table') {
      out.push(renderTable(p, st));
    }
  }
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const endsNL = src.endsWith('\n');
  const lineCount = endsNL ? lines.length - 1 : lines.length;
  const st = { refs: new Map(), inA: false, links: 0, lineCount, endsNL };
  const top = renderBlocks(lines, 0, lineCount, st, true, false);
  const out = [];
  renderParts(top.parts, st, out);
  return out.join('');
}
