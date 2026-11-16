// A dependency-free Markdown parser that renders exactly the HTML marked
// 18.1.3 produces with its defaults (GFM on, breaks off, pedantic off).
// Written from scratch against the CommonMark 0.31.2 and GFM 0.29 specs.
// Single pass over blocks, single pass over inline text; no regexes in the
// hot loops, no per-token objects, output built in plain string arrays.



function isPunct(cc) {
  return (cc >= 33 && cc <= 47) || (cc >= 58 && cc <= 64) ||
    (cc >= 91 && cc <= 96) || (cc >= 123 && cc <= 126);
}
function isSpace(cc) { return cc === 32 || cc === 9 || cc === 10 || cc === 13; }
function isDigit(cc) { return cc >= 48 && cc <= 57; }
function isAlpha(cc) {
  return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
}
function isAlnum(cc) { return isAlpha(cc) || isDigit(cc); }
function isAsciiPunct(cc) { return isPunct(cc); }

// Unicode whitespace and punctuation, used ONLY for emphasis flanking
// (marked follows Unicode categories there; blocks keep the ASCII rules).
// Whitespace: tab, LF, FF, CR plus the Unicode Zs category.
function isUniSpace(cc) {
  if (cc === 32 || cc === 9 || cc === 10 || cc === 12 || cc === 13) return true;
  if (cc === 0xA0 || cc === 0x1680 || cc === 0x202F || cc === 0x205F || cc === 0x3000) return true;
  return cc >= 0x2000 && cc <= 0x200A;
}
const UNI_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUniPunct(s, i) {
  const cc = s.charCodeAt(i);
  if (cc < 128) return isPunct(cc);
  if (cc >= 0xD800 && cc <= 0xDBFF && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xDC00 && lo <= 0xDFFF) return UNI_PUNCT_RE.test(s.slice(i, i + 2));
  }
  return UNI_PUNCT_RE.test(s[i]);
}

// Escape text content: & < > " '  (marked's escape set).
function escText(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// If a valid entity reference starts at s[i] === '&', return the index just
// past it, else -1. Named: '&' + alphanumerics + ';' (any name, real or not).
// Numeric: '&#' + 1-7 decimal digits + ';', or '&#[xX]' + 1-6 hex digits + ';'.
function entityEnd(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  const c = s.charCodeAt(i + 1);
  if (c === 35) {
    let j = i + 2, hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (hex ? (isDigit(d) || (d >= 65 && d <= 70) || (d >= 97 && d <= 102)) : isDigit(d)) j++;
      else break;
    }
    const digits = j - ds;
    if (digits === 0 || digits > (hex ? 6 : 7)) return -1;
    if (j >= n || s.charCodeAt(j) !== 59) return -1;
    return j + 1;
  }
  if (!isAlnum(c)) return -1;
  let j = i + 1;
  while (j < n && isAlnum(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 59) return -1;
  return j + 1;
}

// Encode a link href the way marked does: spaces, quotes, backslashes,
// angle brackets, control characters and non-ASCII become %XX (UTF-8);
// a '%' that starts a valid %XX escape is left alone, as are the URI
// characters encodeURI leaves alone. Entities are NOT decoded here.
const URL_OK = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;,/?:@&=+$_.!~*'()#%-";
function encodeUrl(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c < 128 && URL_OK.indexOf(raw[i]) >= 0) { out += raw[i]; continue; }
    if (c === 37 && i + 2 < raw.length && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) { out += raw.slice(i, i + 3); i += 2; continue; }
    if (c < 128) { out += '%' + c.toString(16).toUpperCase().padStart(2, '0'); continue; }
    // non-ASCII: UTF-8 percent-encoding
    let cp = raw.codePointAt(i);
    if (cp > 0xFFFF) i++;
    const bytes = [];
    if (cp < 0x800) bytes.push(0xC0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xE0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// Attribute escape that preserves entity references (&word;, &#123;, &#xAB;)
// and escapes a bare '&' and < > " '.
function escAttrNoEncode(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (entityEnd(s, i) < 0) rep = '&amp;';
    }
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) { out += s.slice(start, i) + rep; start = i + 1; }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Strip a trailing/leading run of spaces; collapse internal runs of
// whitespace (space, tab, newline) to a single space.
function collapseWs(s) {
  let out = '', start = 0, i = 0, n = s.length;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  start = i;
  let pending = false;
  for (; i < n; i++) {
    const c = s.charCodeAt(i);
    if (isSpace(c)) {
      if (!pending) { out += s.slice(start, i); pending = true; }
    } else if (pending) {
      out += ' ';
      start = i; pending = false;
    }
  }
  if (!pending) out += s.slice(start, n);
  return out;
}

// ---- inline parsing -------------------------------------------------------

const DISALLOWED = new Set(['title', 'textarea', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'script', 'plaintext']);
const SCHEME_OK = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+.-';
function normLabel(s) {
  // Unicode case folding: ß/ẞ fold to "ss" (toLowerCase alone gives ß),
  // plus the Latin ligatures.
  return collapseWs(s).toLowerCase()
    .replace(/ß/g, 'ss').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi')
    .replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Parse a link destination at src[i]. Returns [dest, next] or null.
// An empty destination is valid only for inline links (allowEmpty).
function parseDest(src, i, allowEmpty) {
  const n = src.length;
  if (i >= n) return null;
  if (src.charCodeAt(i) === 60) { // <
    let j = i + 1;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (c === 62) return [src.slice(i + 1, j), j + 1];
      if (c === 10 || c === 60) return null;
      if (c === 92 && j + 1 < n && isPunct(src.charCodeAt(j + 1))) j += 2;
      else j++;
    }
    return null;
  }
  let j = i, depth = 0;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 92 && j + 1 < n && isPunct(src.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 40) depth++;
    else if (c === 41) {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j === i) return allowEmpty ? ['', i] : null;
  return [src.slice(i, j), j];
}

// Parse a link title at src[i]. Returns [title, next] or null.
function parseTitle(src, i) {
  const n = src.length;
  if (i >= n) return null;
  const c = src.charCodeAt(i);
  let open, close;
  if (c === 34 || c === 39) { open = c; close = c; }
  else if (c === 40) { open = 40; close = 41; }
  else return null;
  let j = i + 1;
  while (j < n) {
    const ch = src.charCodeAt(j);
    if (ch === 92 && j + 1 < n) { j += 2; continue; }
    if (ch === close) return [src.slice(i + 1, j), j + 1];
    if (open === 40 && ch === 40) return null;
    j++;
  }
  return null;
}

// Unescape backslash escapes (punct only) in a raw destination/title.
function unescapeRaw(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isPunct(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++; start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

function skipWs(src, i) {
  while (i < src.length) {
    const c = src.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Try to parse an inline link "(...)" starting at src[i] === '('.
// Returns {href, title, next} or null.
function parseInlineLink(src, i, refs) {
  let j = skipWs(src, i + 1);
  const d = parseDest(src, j, true);
  if (!d) return null;
  j = d[1];
  let title = null;
  const k = skipWs(src, j);
  if (k < src.length && src.charCodeAt(k) !== 41) {
    const t = parseTitle(src, k);
    if (!t) return null;
    title = t[0];
    j = t[1];
  } else j = k;
  j = skipWs(src, j);
  if (j >= src.length || src.charCodeAt(j) !== 41) return null;
  return { href: d[0], title, next: j + 1 };
}

function renderLinkOpen(href, title) {
  let s = '<a href="' + escAttrNoEncode(encodeUrl(unescapeRaw(href))) + '"';
  if (title !== null && title !== undefined) s += ' title="' + escAttrNoEncode(unescapeRaw(title)) + '"';
  return s + '>';
}

// Is src[i] at a word boundary where an extended autolink may start?
// The previous character must not be an alphanumeric or one of . + -
// (the characters that continue a word or an email local part).
function extBoundary(src, i) {
  if (i === 0) return true;
  const c = src.charCodeAt(i - 1);
  if (c === 32 || c === 9 || c === 10) return true;
  if (isAlnum(c)) return false;
  return c !== 46 && c !== 43 && c !== 45;
}


// ---- extended autolinks ---------------------------------------------------

// Scan a bare email starting at src[i]. Returns [email, end] or null.
// Local part: [A-Za-z0-9._+-]+. Domain: labels of [A-Za-z0-9_-] separated
// by single dots, at least one dot. A '+' or '%' inside the domain run
// invalidates the candidate; a trailing '-' invalidates it; a trailing
// '_' is trimmed only when an unmatched '_' opener exists in the
// delimiter stack, otherwise it invalidates the candidate.
const EMAIL_LOCAL = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._+-';
function tryBareEmail(src, i, delims) {
  const n = src.length;
  let j = i;
  while (j < n && EMAIL_LOCAL.indexOf(src[j]) >= 0) j++;
  if (j === i || j >= n || src.charCodeAt(j) !== 64) return null;
  j++;
  const dstart = j;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAlnum(c) || c === 45 || c === 46 || c === 95 || c === 37 || c === 43) j++;
    else break;
  }
  if (j === dstart) return null;
  let end = j;
  while (end > dstart && src.charCodeAt(end - 1) === 46) end--;
  if (end === dstart) return null;
  if (src.charCodeAt(end - 1) === 45) return null;
  if (src.charCodeAt(end - 1) === 95) {
    let hasOpener = false;
    for (let k = 0; k < delims.length; k++) {
      const d = delims[k];
      if (d.ch === 95 && d.active && d.open && d.len > 0) { hasOpener = true; break; }
    }
    if (hasOpener) end--;
    else return null;
  }
  const domain = src.slice(dstart, end);
  let hasDot = false, hasAlnum = false;
  let labelStart = 0;
  for (let k = 0; k <= domain.length; k++) {
    if (k === domain.length || domain.charCodeAt(k) === 46) {
      const lab = domain.slice(labelStart, k);
      if (lab.length === 0) return null;
      for (let m = 0; m < lab.length; m++) {
        const cc = lab.charCodeAt(m);
        if (isAlnum(cc)) hasAlnum = true;
        else if (cc !== 45 && cc !== 95) return null;
      }
      if (k < domain.length) hasDot = true;
      labelStart = k + 1;
    }
  }
  if (!hasDot || !hasAlnum) return null;
  return [src.slice(i, end), end];
}

// Trim a URL candidate: trailing punctuation (?, !, ., ,, :, ;, *, _, ~),
// unbalanced trailing ')', a trailing ';' that is not part of a valid
// entity (the whole &...; is dropped then), and truncation at the first
// unmatched '('.
function trimUrl(s) {
  let end = s.length;
  for (;;) {
    let changed = false;
    while (end > 0) {
      const c = s.charCodeAt(end - 1);
      if (c === 41) {
        let open = 0, close = 0;
        for (let k = 0; k < end; k++) {
          if (s.charCodeAt(k) === 40) open++;
          else if (s.charCodeAt(k) === 41) close++;
        }
        if (close > open) { end--; changed = true; continue; }
        break;
      }
      if (c === 59) {
        // A trailing ';' that closes an entity-like '&name;' removes
        // the whole entity from the URL; any other ';' is just dropped.
        const amp = s.lastIndexOf('&', end - 2);
        if (amp >= 0) {
          const ent = s.slice(amp, end);
          if (entityEnd(ent, 0) === ent.length) { end = amp; changed = true; continue; }
        }
        end--; changed = true; continue;
      }
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 42 || c === 95 || c === 126) { end--; changed = true; continue; }
      break;
    }
    // truncate at the first unmatched '('
    let depth = 0, cut = -1;
    const stack = [];
    for (let k = 0; k < end; k++) {
      if (s.charCodeAt(k) === 40) stack.push(k);
      else if (s.charCodeAt(k) === 41) { if (stack.length) stack.pop(); }
    }
    if (stack.length) { end = stack[0]; changed = true; }
    if (!changed) break;
  }
  return s.slice(0, end);
}

// Case-insensitive prefix check (lower is all lowercase).
function startsWithCI(src, i, lower) {
  if (i + lower.length > src.length) return false;
  for (let k = 0; k < lower.length; k++) {
    let c = src.charCodeAt(i + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lower.charCodeAt(k)) return false;
  }
  return true;
}

// Scan a www./scheme:// URL run starting at src[i].
// Returns [href, display, end] or null. Validation is loose: the first
// character after the prefix must be alphanumeric or '-', the rest is a
// run of non-space characters.
function tryUrlAutolink(src, i, brackets, refs) {
  const n = src.length;
  let prefixLen, addScheme;
  if (src.startsWith('www.', i)) { prefixLen = 4; addScheme = 'http://'; }
  else if (startsWithCI(src, i, 'https://')) { prefixLen = 8; addScheme = ''; }
  else if (startsWithCI(src, i, 'http://')) { prefixLen = 7; addScheme = ''; }
  else if (startsWithCI(src, i, 'ftp://')) { prefixLen = 6; addScheme = ''; }
  else return null;
  const first = i + prefixLen;
  if (first >= n) return null;
  const fc = src.charCodeAt(first);
  if (!isAlnum(fc) && fc !== 45) return null;
  let j = first + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 34) break;
    if (c === 93) { // ']': stop only when the nearest '[' can still form a link
      if (bracketCanLink(src, j, brackets, refs)) break;
    }
    j++;
  }
  const url = trimUrl(src.slice(i, j));
  if (url.length <= prefixLen) return null;
  return [addScheme + url, url, i + url.length];
}

// Can the nearest active '[' opener form a link at the ']' at src[j]?
// True if s contains an unescaped '[' (which invalidates a link label).
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92) { i++; continue; }
    if (s.charCodeAt(i) === 91) return true;
  }
  return false;
}

function bracketCanLink(src, j, brackets, refs) {
  let bi = brackets.length - 1;
  while (bi >= 0 && !brackets[bi].active) bi--;
  if (bi < 0) return false;
  const br = brackets[bi];
  let k = skipWs(src, j + 1);
  if (k < src.length && src.charCodeAt(k) === 40) return true;
  if (k < src.length && src.charCodeAt(k) === 91) {
    const close = src.indexOf(']', k + 1);
    if (close < 0) return false;
    const lab = src.slice(k + 1, close);
    // A label cannot contain an unescaped '['.
    if (hasUnescapedBracket(lab)) return false;
    if (lab.length === 0) return refs.has(normLabel(src.slice(br.srcPos + 1, j)));
    return refs.has(normLabel(lab));
  }
  return refs.has(normLabel(src.slice(br.srcPos + 1, j)));
}

// Try a scheme:email[/seg] autolink (mailto:, xmpp:) at src[i].
function trySchemeAutolink(src, i, delims) {
  const n = src.length;
  if (!isAlpha(src.charCodeAt(i))) return null;
  let j = i + 1;
  while (j < n && SCHEME_OK.indexOf(src[j]) >= 0) j++;
  const schemeLen = j - i;
  if (schemeLen < 2 || schemeLen > 32) return null;
  if (j >= n || src.charCodeAt(j) !== 58) return null;
  const em = tryBareEmail(src, j + 1, delims);
  if (!em) return null;
  let end = em[1];
  let text = src.slice(i, end);
  if (end < n && src.charCodeAt(end) === 47) {
    let k = end + 1;
    while (k < n) {
      const c = src.charCodeAt(k);
      if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c === 47 || c === 93 || c === 34) break;
      k++;
    }
    if (k > end + 1) { text = trimUrl(src.slice(i, k)); end = i + text.length; }
  }
  return [text, end];
}


// ---- the inline scanner ---------------------------------------------------

// Whether the inline parser is currently inside an <a> element
// (document-wide; extended autolinks are suppressed while set).
let inA = false;

function inlineParse(src, refs) {
  const n = src.length;
  const out = [];
  const kind = []; // 0 text, 1 delimiter, 2 markup, 3 bracket
  let buf = '';
  const delims = [];
  const brackets = [];
  const tickUnmatched = [];
  const tickSpans = []; // code spans {start,end} whose content holds a backtick
  const images = []; // {idx, marker, href, title}
  const autoSpans = []; // extended autolinks, to revert if a link forms around them
  let linkSeq = 0; // ids for link/image spans, for emphasis boundaries
  let spanSeq = 0; // ids for emphasis spans, for nesting boundaries
  let i = 0;

  function flush() { if (buf !== '') { out.push(escText(buf)); kind.push(0); buf = ''; } }

  function flanking(i0, runLen) {
    const prev = i0 > 0 ? src.charCodeAt(i0 - 1) : -1;
    const next = i0 + runLen < n ? src.charCodeAt(i0 + runLen) : -1;
    // The start/end of the text count as whitespace for flanking.
    const prevWs = prev < 0 || isUniSpace(prev);
    const nextWs = next < 0 || isUniSpace(next);
    const prevPunct = prev >= 0 && isUniPunct(src, i0 - 1);
    const nextPunct = next >= 0 && isUniPunct(src, i0 + runLen);
    const left = !nextWs && (!nextPunct || prevWs || prevPunct);
    const right = !prevWs && (!prevPunct || nextWs || nextPunct);
    return [left, right, prev, next];
  }

  function addDelim(ch, runLen, open, close, pos) {
    flush();
    out.push(ch.repeat(runLen));
    kind.push(1);
    delims.push({ ch: ch.charCodeAt(0), len: runLen, idx: out.length - 1, open, close, active: true, lit: ch.repeat(runLen), tags: '', pos, link: 0, span: 0 });
  }

  // Find a closing backtick run of exactly k starting the scan at j.
  function findCodeClose(j, k) {
    while (j < n) {
      if (src.charCodeAt(j) === 96) {
        let m = j;
        while (m < n && src.charCodeAt(m) === 96) m++;
        if (m - j === k) return j;
        j = m;
      } else j++;
    }
    return -1;
  }

  function inLinkText(pos) {
    for (let b = brackets.length - 1; b >= 0; b--) {
      if (brackets[b].active && brackets[b].srcPos < pos) return brackets[b];
    }
    return null;
  }

  function tryCodeSpan(pos) {
    let k = pos;
    while (k < n && src.charCodeAt(k) === 96) k++;
    const run = k - pos;
    const br = inLinkText(pos);
    if (br) {
      for (let t = 0; t < tickUnmatched.length; t++) {
        if (tickUnmatched[t] > br.srcPos && tickUnmatched[t] < pos) {
          tickUnmatched.push(pos);
          buf += src.slice(pos, k);
          return k;
        }
      }
    }
    const close = findCodeClose(k, run);
    if (close < 0) {
      tickUnmatched.push(pos);
      buf += src.slice(pos, k);
      return k;
    }
    let content = src.slice(k, close);
    if (br && run >= 2) {
      const li = content.indexOf('](');
      if (li >= 0) {
        const L = parseInlineLink(content, li + 1, refs);
        if (L) {
          tickUnmatched.push(pos);
          buf += src.slice(pos, k);
          return k;
        }
      }
    }
    if (content.indexOf('\n') >= 0) content = content.split('\n').join(' ');
    if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32) {
      let nonSpace = false;
      for (let m = 1; m < content.length - 1; m++) if (content.charCodeAt(m) !== 32) { nonSpace = true; break; }
      if (nonSpace) content = content.slice(1, -1);
    }
    if (content.indexOf('`') >= 0) tickSpans.push({ start: pos, end: close + run });
    flush();
    out.push('<code>' + escText(content) + '</code>');
    kind.push(2);
    return close + run;
  }

  // Parse an HTML tag / comment / PI / declaration / CDATA at src[i] === '<'.
  // Returns [raw, end, name, isClose] or null.
  function parseHtmlAt(pos) {
    if (src.startsWith('<!--', pos)) {
      // '<!-->' and '<!--->' are complete (empty) comments.
      if (src.startsWith('<!-->', pos)) return [src.slice(pos, pos + 5), pos + 5, '', false];
      if (src.startsWith('<!--->', pos)) return [src.slice(pos, pos + 6), pos + 6, '', false];
      const e = src.indexOf('-->', pos + 4);
      if (e < 0) return null;
      return [src.slice(pos, e + 3), e + 3, '', false];
    }
    if (src.startsWith('<?', pos)) {
      const e = src.indexOf('?>', pos + 2);
      if (e < 0) return null;
      return [src.slice(pos, e + 2), e + 2, '', false];
    }
    if (src.startsWith('<![CDATA[', pos)) {
      const e = src.indexOf(']]>', pos + 9);
      if (e < 0) return null;
      return [src.slice(pos, e + 3), e + 3, '', false];
    }
    if (src.startsWith('<!', pos)) {
      let j = pos + 2;
      if (j >= n || !isAlpha(src.charCodeAt(j))) return null;
      while (j < n && src.charCodeAt(j) !== 62) j++;
      if (j >= n) return null;
      return [src.slice(pos, j + 1), j + 1, '', false];
    }
    let j = pos + 1;
    let close = false;
    if (j < n && src.charCodeAt(j) === 47) { close = true; j++; }
    if (j >= n || !isAlpha(src.charCodeAt(j))) return null;
    const ns = j;
    while (j < n && (isAlnum(src.charCodeAt(j)) || src.charCodeAt(j) === 45)) j++;
    const name = src.slice(ns, j).toLowerCase();
    // The tag name must be followed by whitespace, '/', or '>'.
    if (j >= n) return null;
    {
      const ac = src.charCodeAt(j);
      if (ac !== 32 && ac !== 9 && ac !== 10 && ac !== 47 && ac !== 62) return null;
    }
    if (close) {
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
      if (j >= n || src.charCodeAt(j) !== 62) return null;
      return [src.slice(pos, j + 1), j + 1, name, true];
    }
    let firstAttr = true;
    for (;;) {
      const wsStart = j;
      while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
      const hadWs = j > wsStart;
      if (j >= n) return null;
      const c = src.charCodeAt(j);
      if (c === 62) return [src.slice(pos, j + 1), j + 1, name, false];
      if (c === 47) {
        if (j + 1 < n && src.charCodeAt(j + 1) === 62) return [src.slice(pos, j + 2), j + 2, name, false];
        return null;
      }
      // Attributes must be separated from each other by whitespace.
      if (!firstAttr && !hadWs) return null;
      // Attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
      const as = j;
      const ac = src.charCodeAt(j);
      if (!(isAlpha(ac) || ac === 95 || ac === 58)) return null;
      j++;
      while (j < n) {
        const d = src.charCodeAt(j);
        if (isAlnum(d) || d === 95 || d === 46 || d === 58 || d === 45) j++;
        else break;
      }
      if (j === as) return null;
      firstAttr = false;
      // Only consume following whitespace if an '=' follows it (a value);
      // otherwise leave it so the next attribute sees the separator.
      const nameEnd = j;
      let k = j;
      while (k < n && (src.charCodeAt(k) === 32 || src.charCodeAt(k) === 9 || src.charCodeAt(k) === 10)) k++;
      if (k < n && src.charCodeAt(k) === 61) {
        j = k + 1;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9 || src.charCodeAt(j) === 10)) j++;
        if (j >= n) return null;
        const q = src.charCodeAt(j);
        if (q === 34 || q === 39) {
          j++;
          while (j < n && src.charCodeAt(j) !== q) j++;
          if (j >= n) return null;
          j++;
        } else {
          const vs = j;
          while (j < n) {
            const d = src.charCodeAt(j);
            if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
            j++;
          }
          if (j === vs) return null;
        }
      }
    }
  }

  // Try to form a link at the ']' at closePos. Returns the next index or -1.
  function tryLink(closePos) {
    let bi = brackets.length - 1;
    while (bi >= 0 && !brackets[bi].active) bi--;
    if (bi < 0) return -1;
    const br = brackets[bi];
    // A link's text cannot contain another link.
    if (!br.img && br.hasLink) { br.active = false; return -1; }
    for (let t = 0; t < tickSpans.length; t++) {
      const cs = tickSpans[t];
      if (cs.start > br.srcPos && cs.end < closePos) {
        let more = false;
        for (let k = cs.end; k < closePos; k++) {
          const c = src.charCodeAt(k);
          if (c !== 32 && c !== 10 && c !== 9) { more = true; break; }
        }
        if (more) {
          br.active = false;
          for (let d = 0; d < delims.length; d++) {
            if (delims[d].idx > br.idx) delims[d].active = false;
          }
          return -1;
        }
      }
    }
    let href = null, title = null, next = -1;
    const j = closePos + 1;
    if (j < n && src.charCodeAt(j) === 40) {
      const L = parseInlineLink(src, j, refs);
      if (L) { href = L.href; title = L.title; next = L.next; }
      else {
        // An invalid inline link falls back to a shortcut reference.
        const ref = refs.get(normLabel(src.slice(br.srcPos + 1, closePos)));
        if (!ref) { br.active = false; return -1; }
        href = ref.href; title = ref.title; next = closePos + 1;
      }
    } else if (j < n && src.charCodeAt(j) === 91) {
      // Full/collapsed reference: the label ends at the first ']' and
      // cannot contain an unescaped '['.
      let k = j + 1, bad = false;
      while (k < n) {
        const c = src.charCodeAt(k);
        if (c === 92 && k + 1 < n) { k += 2; continue; }
        if (c === 91) { bad = true; break; }
        if (c === 93) break;
        k++;
      }
      if (k >= n || bad) { br.active = false; return -1; }
      const lab = src.slice(j + 1, k);
      let ref = null;
      if (lab.length === 0) ref = refs.get(normLabel(src.slice(br.srcPos + 1, closePos)));
      else ref = refs.get(normLabel(lab));
      if (!ref) { br.active = false; return -1; }
      href = ref.href; title = ref.title; next = k + 1;
    } else {
      const ref = refs.get(normLabel(src.slice(br.srcPos + 1, closePos)));
      if (!ref) { br.active = false; return -1; }
      href = ref.href; title = ref.title; next = closePos + 1;
    }
    flush();
    if (br.img) {
      out[br.bangIdx] = '';
      out[br.idx] = '\u0001';
      images.push({ idx: br.idx, marker: out.length, href, title });
      out.push('');
      kind.push(2);
    } else {
      out[br.idx] = renderLinkOpen(href, title);
      out.push('</a>');
      kind.push(2);
    }
    // A link cannot contain another link: revert any extended autolink
    // formed inside this link/image's text back to plain text.
    for (let a = 0; a < autoSpans.length; a++) {
      const au = autoSpans[a];
      if (au.idx > br.idx && au.idx < out.length - 1) {
        out[au.idx] = au.text;
        kind[au.idx] = 0;
        autoSpans.splice(a, 1);
        a--;
      }
    }
    for (let b = brackets.length - 1; b > bi; b--) brackets[b].active = false;
    br.active = false;
    // Emphasis cannot cross a link boundary: mark the delimiters inside
    // this link/image with its id (innermost wins -- only unmarked ones).
    linkSeq++;
    for (let d = 0; d < delims.length; d++) {
      const dm = delims[d];
      if (!dm.link && dm.pos > br.srcPos && dm.pos < closePos) dm.link = linkSeq;
    }
    // A link inside a bracket blocks that bracket from forming a link
    // (images may contain links, so only links set this).
    if (!br.img) {
      for (let b = 0; b < bi; b++) {
        if (brackets[b].active) brackets[b].hasLink = true;
      }
    }
    return next;
  }

  while (i < n) {
    const c = src.charCodeAt(i);
    if (c === 10) {
      let k = buf.length;
      while (k > 0 && buf.charCodeAt(k - 1) === 32) k--;
      const spaces = buf.length - k;
      if (spaces >= 2) {
        // hard break: the next line's leading spaces are skipped
        buf = buf.slice(0, k);
        flush();
        out.push('<br>');
        let q = i + 1;
        while (q < n && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
        i = q;
      } else {
        flush();
        out.push('\n');
        i++;
      }
      kind.push(2);
      continue;
    }
    if (c === 92) {
      if (i + 1 < n && src.charCodeAt(i + 1) === 10) {
        // backslash hard break: the next line's leading spaces are skipped
        flush();
        out.push('<br>');
        kind.push(2);
        let q = i + 2;
        while (q < n && (src.charCodeAt(q) === 32 || src.charCodeAt(q) === 9)) q++;
        i = q;
        continue;
      }
      if (i + 1 < n && isPunct(src.charCodeAt(i + 1))) { buf += src[i + 1]; i += 2; continue; }
      buf += '\\';
      i++;
      continue;
    }
    if (c === 96) { i = tryCodeSpan(i); continue; }
    if (c === 42 || c === 95) {
      const ch = c === 42 ? '*' : '_';
      let k = i;
      while (k < n && src.charCodeAt(k) === c) k++;
      const fl = flanking(i, k - i);
      let open, close;
      if (c === 42) { open = fl[0]; close = fl[1]; }
      else {
        open = fl[0] && (!fl[1] || fl[2] >= 0 && isPunct(fl[2]));
        close = fl[1] && (!fl[0] || fl[3] >= 0 && isPunct(fl[3]));
      }
      addDelim(ch, k - i, open, close, i);
      i = k;
      continue;
    }
    if (c === 126) {
      let k = i;
      while (k < n && src.charCodeAt(k) === 126) k++;
      // Only runs of 1 or 2 tildes are strikethrough delimiters.
      if (k - i <= 2) {
        const fl = flanking(i, k - i);
        addDelim('~', k - i, fl[0], fl[1], i);
      } else buf += src.slice(i, k);
      i = k;
      continue;
    }
    if (c === 91) {
      flush();
      out.push('[');
      kind.push(3);
      brackets.push({ idx: out.length - 1, bangIdx: -1, srcPos: i, img: false, active: true, hasLink: false });
      i++;
      continue;
    }
    if (c === 93) {
      const next = tryLink(i);
      if (next >= 0) { i = next; continue; }
      buf += ']';
      i++;
      continue;
    }
    if (c === 33) {
      if (i + 1 < n && src.charCodeAt(i + 1) === 91) {
        flush();
        out.push('!');
        kind.push(3);
        const bangIdx = out.length - 1;
        out.push('[');
        kind.push(3);
        brackets.push({ idx: out.length - 1, bangIdx, srcPos: i + 1, img: true, active: true, hasLink: false });
        i += 2;
        continue;
      }
      buf += '!';
      i++;
      continue;
    }
    if (c === 60) {
      // <...> autolink or raw HTML
      let handled = false;
      const gt = src.indexOf('>', i + 1);
      if (gt > i + 1) {
        const inner = src.slice(i + 1, gt);
        let ok = false, isMail = false;
        if (inner.indexOf(' ') < 0 && inner.indexOf('\n') < 0 && inner.indexOf('<') < 0) {
          const ci = inner.indexOf(':');
          if (ci >= 2 && ci <= 32 && isAlpha(inner.charCodeAt(0))) {
            let sch = true;
            for (let m = 0; m < ci; m++) if (SCHEME_OK.indexOf(inner[m]) < 0) { sch = false; break; }
            if (sch && inner.length > ci + 1) ok = true;
          } else {
            const em = tryBareEmail(inner, 0, delims);
            if (em && em[1] === inner.length) { ok = true; isMail = true; }
          }
        }
        if (ok) {
          flush();
          const href = isMail ? 'mailto:' + inner : inner;
          out.push('<a href="' + escAttrNoEncode(encodeUrl(href)) + '">' + escText(inner) + '</a>');
          kind.push(2);
          i = gt + 1;
          handled = true;
        }
      }
      if (!handled) {
        const tag = parseHtmlAt(i);
        if (tag) {
          flush();
          // An <a> tag suppresses extended autolinks only while inside
          // it, and only if it is not the bare '<a>' or '<a/>'; a
          // closing '</a>' ends the suppression.
          if (tag[2] === 'a') {
            if (tag[3]) inA = false;
            else if (tag[0] !== '<a>' && tag[0] !== '<a/>') inA = true;
          }
          out.push(tag[0]);
          kind.push(4);
          i = tag[1];
          handled = true;
        }
      }
      if (!handled) { buf += '<'; i++; }
      continue;
    }
    if (c === 38) {
      const e = entityEnd(src, i);
      if (e > 0) {
        if (src.charCodeAt(i + 1) === 35) {
          // numeric: decode to the character (0 / surrogate / >0x10FFFF -> U+FFFD)
          const hex = src.charCodeAt(i + 2) === 120 || src.charCodeAt(i + 2) === 88;
          const ds = i + (hex ? 3 : 2);
          const num = parseInt(src.slice(ds, e - 1), hex ? 16 : 10);
          const cp = (num === 0 || num > 0x10FFFF || (num >= 0xD800 && num <= 0xDFFF)) ? 0xFFFD : num;
          buf += String.fromCodePoint(cp);
        } else {
          // named: pass the reference through raw
          flush();
          out.push(src.slice(i, e));
          kind.push(0);
        }
        i = e;
        continue;
      }
      buf += '&';
      i++;
      continue;
    }
    // Extended autolinks (suppressed after an inline <a>).
    if (!inA) {
      if (c === 119 && src.startsWith('www.', i)) {
        const u = tryUrlAutolink(src, i, brackets, refs);
        if (u) {
          flush();
          const disp = escText(u[1]);
          out.push('<a href="' + escAttrNoEncode(encodeUrl(u[0])) + '">' + disp + '</a>');
          kind.push(2);
          autoSpans.push({ idx: out.length - 1, text: disp });
          i = u[2];
          continue;
        }
      } else if (((c === 104 || c === 72) && (startsWithCI(src, i, 'http://') || startsWithCI(src, i, 'https://'))) ||
        ((c === 102 || c === 70) && startsWithCI(src, i, 'ftp://'))) {
        const u = tryUrlAutolink(src, i, brackets, refs);
        if (u) {
          flush();
          const disp = escText(u[1]);
          out.push('<a href="' + escAttrNoEncode(encodeUrl(u[0])) + '">' + disp + '</a>');
          kind.push(2);
          autoSpans.push({ idx: out.length - 1, text: disp });
          i = u[2];
          continue;
        }
      } else if (extBoundary(src, i) && (isAlnum(c) || c === 46 || c === 43 || c === 45 || c === 37)) {
        const s = trySchemeAutolink(src, i, delims);
        if (s) {
          flush();
          const disp = escText(s[0]);
          out.push('<a href="' + escAttrNoEncode(encodeUrl(s[0])) + '">' + disp + '</a>');
          kind.push(2);
          autoSpans.push({ idx: out.length - 1, text: disp });
          i = s[1];
          continue;
        }
        const em = tryBareEmail(src, i, delims);
        if (em) {
          flush();
          const disp = escText(em[0]);
          out.push('<a href="mailto:' + escAttrNoEncode(encodeUrl(em[0])) + '">' + disp + '</a>');
          kind.push(2);
          autoSpans.push({ idx: out.length - 1, text: disp });
          i = em[1];
          continue;
        }
      }
    }
    // Plain text run.
    const start = i;
    i++;
    while (i < n) {
      const d = src.charCodeAt(i);
      if (d === 10 || d === 92 || d === 96 || d === 42 || d === 95 || d === 126 || d === 91 || d === 93 || d === 33 || d === 60 || d === 38) break;
      if (!inA && d === 119 && src.startsWith('www.', i)) break;
      if (!inA && ((d === 104 || d === 72) && (startsWithCI(src, i, 'http://') || startsWithCI(src, i, 'https://')) || ((d === 102 || d === 70) && startsWithCI(src, i, 'ftp://')))) break;
      if (!inA && extBoundary(src, i) && (isAlnum(d) || d === 46 || d === 43 || d === 45 || d === 37)) break;
      i++;
    }
    buf += src.slice(start, i);
  }
  flush();

  // Emphasis / strikethrough resolution over the delimiter stack.
  for (let ci = 0; ci < delims.length; ci++) {
    const cl = delims[ci];
    if (!cl.active || cl.len === 0 || !cl.close) continue;
    while (cl.len > 0) {
      let opener = null;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const op = delims[oi];
        if (!op.active || op.len === 0 || op.ch !== cl.ch || !op.open) continue;
        // Emphasis cannot cross a link/image boundary or an emphasis
        // span boundary (a delimiter inside a formed span cannot match
        // one outside it).
        if (op.link !== cl.link || op.span !== cl.span) continue;
        if (cl.ch === 42 && cl.len === 1 && op.len === 2) {
          let later = false;
          for (let k = ci + 1; k < delims.length; k++) {
            const d2 = delims[k];
            if (d2.ch === 42 && d2.len >= 2 && d2.close && d2.active) { later = true; break; }
          }
          if (later) continue;
        }
        // The odd-match rule: when either side is ambiguous (the opener
        // can close or the closer can open) and the sum of the lengths
        // is divisible by 3, the match is skipped -- but only when
        // neither length is itself divisible by 3 (residues 1 and 2);
        // runs of 3, 6, ... do match each other.
        if ((op.close || cl.open) && (op.len + cl.len) % 3 === 0 && op.len % 3 !== 0) continue;
        // Tildes match only equal-length runs (1 with 1, 2 with 2).
        if (cl.ch === 126 && op.len !== cl.len) continue;
        opener = op;
        break;
      }
      if (!opener) break;
      const use = cl.ch === 126 ? opener.len : (opener.len >= 2 && cl.len >= 2 ? 2 : 1);
      const tag = cl.ch === 126 ? 'del' : (use === 2 ? 'strong' : 'em');
      // Delimiters between the opener and closer are now inside this
      // span; they cannot match a delimiter outside it (innermost wins).
      spanSeq++;
      for (let d = 0; d < delims.length; d++) {
        const dm = delims[d];
        if (!dm.span && dm.pos > opener.pos && dm.pos < cl.pos) dm.span = spanSeq;
      }
      opener.lit = opener.lit.slice(0, opener.len - use);
      opener.tags = '<' + tag + '>' + opener.tags;
      opener.len -= use;
      out[opener.idx] = opener.lit + opener.tags;
      cl.lit = cl.lit.slice(use);
      cl.tags = cl.tags + '</' + tag + '>';
      cl.len -= use;
      out[cl.idx] = cl.tags + cl.lit;
      if (opener.len === 0) opener.active = false;
      if (cl.len === 0) { cl.active = false; break; }
    }
  }

  // Image alt text is the plain text of the link text: rendered text
  // pieces as-is (already escaped), delimiter literals, literal brackets,
  // and raw HTML tags as literal escaped text; generated tags are dropped;
  // a soft break contributes a newline, a hard break nothing. A nested
  // image contributes its own alt text (images are formed innermost
  // first, so the inner alt is already computed).
  const altByIdx = new Map();
  for (let m = 0; m < images.length; m++) {
    const im = images[m];
    const delimByIdx = new Map();
    for (let d = 0; d < delims.length; d++) delimByIdx.set(delims[d].idx, delims[d]);
    let alt = '';
    for (let k = im.idx + 1; k < im.marker; k++) {
      const kd = kind[k];
      if (kd === 0) alt += out[k];
      else if (kd === 1) { const dr = delimByIdx.get(k); if (dr) alt += dr.lit; }
      else if (kd === 2) { if (out[k] === '\n') alt += '\n'; }
      else if (kd === 3) {
        const innerAlt = altByIdx.get(k);
        if (innerAlt !== undefined) alt += innerAlt;
        else if (out[k].charCodeAt(0) !== 60) alt += out[k];
      }
      else if (kd === 4) alt += escAttr(out[k]);
    }
    altByIdx.set(im.idx, alt);
    let tag = '<img src="' + escAttrNoEncode(encodeUrl(unescapeRaw(im.href))) + '" alt="' + alt + '"';
    if (im.title !== null && im.title !== undefined) tag += ' title="' + escAttrNoEncode(unescapeRaw(im.title)) + '"';
    out[im.idx] = tag + '>';
    out[im.marker] = '';
    // The link text is the alt text only; it does not render as content.
    for (let k = im.idx + 1; k < im.marker; k++) out[k] = '';
  }

  return out.join('');
}


// ---- block parsing --------------------------------------------------------
// A line is {s, c}: s is the text after container prefixes were stripped,
// c is the absolute column of s[0] in the original source line.

function blankLine(ln) {
  const s = ln.s;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch !== 32 && ch !== 9) return false;
  }
  return true;
}

// A line that terminates a paragraph: empty, or whitespace-only with a
// trailing newline (i.e. followed by more content). A whitespace-only
// line at the very end of the text is a paragraph continuation.
function paraBlank(ln) {
  if (ln.s.length === 0) return true;
  let i = 0;
  while (i < ln.s.length && (ln.s.charCodeAt(i) === 32 || ln.s.charCodeAt(i) === 9)) i++;
  return i === ln.s.length && ln.eol;
}

// Strip up to n columns of leading whitespace. A tab straddling the
// boundary is replaced by spaces for the remainder, unless dropPad.
function stripCols(ln, n, dropPad) {
  const s = ln.s;
  let col = ln.c, pos = 0, pad = 0;
  while (pos < s.length && col - ln.c < n) {
    const ch = s.charCodeAt(pos);
    if (ch === 32) { col++; pos++; }
    else if (ch === 9) {
      const nt = col + 4 - (col % 4);
      if (nt <= ln.c + n) { col = nt; pos++; }
      else { pad = dropPad ? 0 : nt - (ln.c + n); col = ln.c + n; pos++; }
    } else break;
  }
  return { s: ' '.repeat(pad) + s.slice(pos), c: col, used: col - ln.c, eol: ln.eol };
}

function lineIndent(ln) {
  const s = ln.s;
  let col = ln.c, pos = 0;
  while (pos < s.length) {
    const ch = s.charCodeAt(pos);
    if (ch === 32) { col++; pos++; }
    else if (ch === 9) { col += 4 - (col % 4); pos++; }
    else break;
  }
  return { indent: col - ln.c, pos };
}

// Prose text of a line: the leading whitespace run is expanded to spaces
// (by absolute column); everything after the first non-whitespace char is
// kept verbatim, tabs included.
function lineText(ln) {
  const s = ln.s;
  let pos = 0, col = ln.c;
  while (pos < s.length) {
    const ch = s.charCodeAt(pos);
    if (ch === 32) { col++; pos++; }
    else if (ch === 9) { col += 4 - (col % 4); pos++; }
    else break;
  }
  if (pos === 0) return s;
  return ' '.repeat(col - ln.c) + s.slice(pos);
}

// Find the closing ']' of a link label starting at s[i] === '['.
// Returns the index of ']' or -1. Handles escapes and nested brackets.
// Parse a link title starting at (paraLines[lineIdx], col). The title may
// span several lines. Returns [title, linesUsed] or null.
function parseTitleFrom(paraLines, lineIdx, col) {
  const first = paraLines[lineIdx].s;
  const c = first.charCodeAt(col);
  let open, close;
  if (c === 34 || c === 39) { open = c; close = c; }
  else if (c === 40) { open = 40; close = 41; }
  else return null;
  let content = '';
  let line = lineIdx, j = col + 1;
  while (line < paraLines.length) {
    const s = paraLines[line].s;
    while (j < s.length) {
      const ch = s.charCodeAt(j);
      if (ch === 92 && j + 1 < s.length) { content += s[j] + s[j + 1]; j += 2; continue; }
      if (ch === close) {
        let ae = j + 1;
        while (ae < s.length && (s.charCodeAt(ae) === 32 || s.charCodeAt(ae) === 9)) ae++;
        if (ae !== s.length) return null;
        return [content, line - lineIdx + 1];
      }
      if (open === 40 && ch === 40) return null;
      content += s[j];
      j++;
    }
    line++;
    if (line >= paraLines.length) return null;
    content += '\n';
    j = 0;
  }
  return null;
}

// Find the matching ']' for a '[' at (paraLines[k], col), scanning across
// lines. Returns [labelText, endLine, endCol] or null. The label text has
// '\n' between lines. A label cannot contain an unescaped '['.
function findLabelAcross(paraLines, k, col) {
  let text = '';
  let line = k, j = col + 1; // skip the opening '[' itself
  while (line < paraLines.length) {
    const s = paraLines[line].s;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < s.length) { text += s[j] + s[j + 1]; j += 2; continue; }
      if (c === 91) return null;
      if (c === 93) return [text, line, j];
      text += s[j];
      j++;
    }
    line++;
    if (line >= paraLines.length) return null;
    text += '\n';
    j = 0;
  }
  return null;
}

// Try to parse a link reference definition starting at paraLines[k].
// Returns the number of lines consumed or 0. The label may span lines;
// the destination and title follow a (line, col) cursor.
function tryDefinition(paraLines, k, refs) {
  const first = paraLines[k];
  const ind = lineIndent(first);
  if (ind.indent > 3) return 0;
  const pos = ind.pos;
  if (first.s.charCodeAt(pos) !== 91) return 0;
  const lab = findLabelAcross(paraLines, k, pos);
  if (!lab) return 0;
  const label = normLabel(lab[0]);
  if (label.length === 0 || label.length > 999) return 0;
  const endLine = lab[1], endCol = lab[2];
  const endS = paraLines[endLine].s;
  if (endCol + 1 >= endS.length || endS.charCodeAt(endCol + 1) !== 58) return 0;
  // Skip whitespace after ':' (possibly to the next line) to the dest.
  let dLine = endLine, dCol = endCol + 2;
  while (true) {
    const s = paraLines[dLine].s;
    while (dCol < s.length && (s.charCodeAt(dCol) === 32 || s.charCodeAt(dCol) === 9)) dCol++;
    if (dCol < s.length) break;
    dLine++;
    if (dLine >= paraLines.length) return 0;
    dCol = 0;
  }
  const d = parseDest(paraLines[dLine].s, dCol);
  if (!d) return 0;
  const dest = d[0];
  const used = dLine - k + 1;
  // Skip whitespace after the dest to a possible title.
  let tLine = dLine, tCol = d[1];
  let skipped = false;
  while (true) {
    const s = paraLines[tLine].s;
    let c = tCol;
    while (c < s.length && (s.charCodeAt(c) === 32 || s.charCodeAt(c) === 9)) { c++; skipped = true; }
    if (c < s.length) { tCol = c; break; }
    tLine++;
    if (tLine >= paraLines.length) { tLine = -1; break; }
    tCol = 0;
    skipped = true;
  }
  if (tLine >= 0) {
    // A title on the same line as the dest must be separated from it by
    // whitespace and be well-formed; a title on a later line is optional
    // (a malformed one is ignored).
    if (tLine === dLine && !skipped) return 0;
    const t = parseTitleFrom(paraLines, tLine, tCol);
    if (t) {
      if (!refs.has(label)) refs.set(label, { href: dest, title: t[0] });
      return tLine - k + t[1];
    }
    if (tLine === dLine) return 0;
  }
  if (!refs.has(label)) refs.set(label, { href: dest, title: null });
  return used;
}

// Split a table row on unescaped '|' outside code spans.
function splitTableRow(text) {
  const cells = [];
  let cur = '', i = 0, n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 96) {
      let j = i;
      while (j < n && text.charCodeAt(j) === 96) j++;
      const run = j - i;
      let close = -1, k = j;
      while (k < n) {
        if (text.charCodeAt(k) === 96) {
          let m = k;
          while (m < n && text.charCodeAt(m) === 96) m++;
          if (m - k === run) { close = k; break; }
          k = m;
        } else k++;
      }
      if (close < 0) { cur += text.slice(i, j); i = j; }
      // A '\|' inside a code span is still a table escape and becomes '|'.
      else { cur += text.slice(i, close + run).replaceAll('\\|', '|'); i = close + run; }
      continue;
    }
    if (c === 92 && i + 1 < n && text.charCodeAt(i + 1) === 124) { cur += '|'; i += 2; continue; }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += text[i];
    i++;
  }
  cells.push(cur);
  // drop empty leading/trailing cells from outer pipes
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map(x => x.trim());
}

function isDelimCell(cell) {
  let i = 0, n = cell.length;
  while (i < n && cell.charCodeAt(i) === 32) i++;
  if (i < n && cell.charCodeAt(i) === 58) i++;
  let dashes = 0;
  while (i < n && cell.charCodeAt(i) === 45) { i++; dashes++; }
  if (dashes === 0) return null;
  if (i < n && cell.charCodeAt(i) === 58) i++;
  while (i < n && cell.charCodeAt(i) === 32) i++;
  if (i !== n) return null;
  const left = cell.trimStart().charCodeAt(0) === 58;
  const right = cell.trimEnd().charCodeAt(cell.trimEnd().length - 1) === 58;
  return left && right ? 'center' : left ? 'left' : right ? 'right' : '';
}


// ---- block starts --------------------------------------------------------

function parseATX(ln) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return null;
  const s = ln.s;
  let pos = ind.pos, level = 0;
  while (pos < s.length && s.charCodeAt(pos) === 35) { level++; pos++; }
  if (level === 0 || level > 6) return null;
  if (pos >= s.length) return { level, text: '' };
  const c = s.charCodeAt(pos);
  if (c !== 32 && c !== 9) return null;
  let start = pos;
  while (start < s.length && (s.charCodeAt(start) === 32 || s.charCodeAt(start) === 9)) start++;
  let end = s.length;
  while (end > start && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
  let closeStart = end;
  while (closeStart > start && s.charCodeAt(closeStart - 1) === 35) closeStart--;
  if (closeStart < end && closeStart > ind.pos + level) {
    const before = s.charCodeAt(closeStart - 1);
    if (before === 32 || before === 9) {
      end = closeStart;
      while (end > start && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
    }
  }
  return { level, text: s.slice(start, end) };
}

function parseFence(ln) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return null;
  const s = ln.s;
  let pos = ind.pos;
  const ch = s.charCodeAt(pos);
  if (ch !== 96 && ch !== 126) return null;
  let len = 0;
  while (pos < s.length && s.charCodeAt(pos) === ch) { len++; pos++; }
  if (len < 3) return null;
  const info = s.slice(pos).trim();
  if (ch === 96 && info.indexOf('`') >= 0) return null;
  return { ch: String.fromCharCode(ch), chCode: ch, len, info, indent: ind.indent };
}

function setextLevel(ln) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return 0;
  const s = ln.s;
  let pos = ind.pos;
  if (pos >= s.length) return 0;
  const c = s.charCodeAt(pos);
  if (c !== 61 && c !== 45) return 0;
  while (pos < s.length && s.charCodeAt(pos) === c) pos++;
  while (pos < s.length && (s.charCodeAt(pos) === 32 || s.charCodeAt(pos) === 9)) pos++;
  if (pos !== s.length) return 0;
  return c === 61 ? 1 : 2;
}

function isThematicBreak(ln) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return false;
  const s = ln.s;
  let pos = ind.pos;
  if (pos >= s.length) return false;
  const c = s.charCodeAt(pos);
  if (c !== 45 && c !== 95 && c !== 42) return false;
  let count = 0;
  while (pos < s.length) {
    const d = s.charCodeAt(pos);
    if (d === c) { count++; pos++; }
    else if (d === 32 || d === 9) pos++;
    else return false;
  }
  return count >= 3;
}

const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul').split(' '));

// True if t is exactly one complete valid open or closing tag (the
// type-7 HTML block rule): a closing tag has no attributes, attributes
// are separated by whitespace, and quoted values must be followed by
// whitespace, '/' or '>'.
function isCompleteTag(t) {
  const n = t.length;
  if (n < 3 || t.charCodeAt(0) !== 60) return false;
  let j = 1, close = false;
  if (t.charCodeAt(j) === 47) { close = true; j++; }
  if (j >= n || !isAlpha(t.charCodeAt(j))) return false;
  while (j < n && (isAlnum(t.charCodeAt(j)) || t.charCodeAt(j) === 45)) j++;
  if (j >= n) return false;
  {
    const ac = t.charCodeAt(j);
    if (ac !== 32 && ac !== 9 && ac !== 47 && ac !== 62) return false;
  }
  if (close) {
    while (j < n && (t.charCodeAt(j) === 32 || t.charCodeAt(j) === 9)) j++;
    return j === n - 1 && t.charCodeAt(j) === 62;
  }
  let firstAttr = true;
  for (;;) {
    const wsStart = j;
    while (j < n && (t.charCodeAt(j) === 32 || t.charCodeAt(j) === 9)) j++;
    const hadWs = j > wsStart;
    if (j >= n) return false;
    const c = t.charCodeAt(j);
    if (c === 62) return j === n - 1;
    if (c === 47) return j === n - 2 && t.charCodeAt(j + 1) === 62;
    if (!firstAttr && !hadWs) return false;
    const ac = t.charCodeAt(j);
    if (!(isAlpha(ac) || ac === 95 || ac === 58)) return false;
    j++;
    while (j < n) {
      const d = t.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 46 || d === 58 || d === 45) j++;
      else break;
    }
    firstAttr = false;
    // Only consume following whitespace if an '=' follows it (a value);
    // otherwise leave it so the next attribute sees the separator.
    let k = j;
    while (k < n && (t.charCodeAt(k) === 32 || t.charCodeAt(k) === 9)) k++;
    if (k < n && t.charCodeAt(k) === 61) {
      j = k + 1;
      while (j < n && (t.charCodeAt(j) === 32 || t.charCodeAt(j) === 9)) j++;
      if (j >= n) return false;
      const q = t.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && t.charCodeAt(j) !== q) j++;
        if (j >= n) return false;
        j++;
      } else {
        const vs = j;
        while (j < n) {
          const d = t.charCodeAt(j);
          if (d === 32 || d === 9 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          j++;
        }
        if (j === vs) return false;
      }
    }
  }
}

function parseHtmlBlockStart(ln, paraOpen) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return null;
  const s = ln.s;
  let pos = ind.pos;
  if (s.charCodeAt(pos) !== 60) return null;
  const rest = s.slice(pos);
  const low = rest.toLowerCase();
  if (low.startsWith('<pre') || low.startsWith('<script') || low.startsWith('<style') || low.startsWith('<textarea')) {
    // tag name must be followed by space, tab, EOL or '>'
    const name = low.startsWith('<pre') ? 'pre' : low.startsWith('<script') ? 'script' : low.startsWith('<style') ? 'style' : 'textarea';
    const ac = rest.charCodeAt(1 + name.length);
    if (rest.length === 1 + name.length || ac === 32 || ac === 9 || ac === 62) return { kind: 1, endTag: '</' + name + '>' };
  }
  if (rest.startsWith('<!--')) return { kind: 2, endMarker: '-->' };
  if (rest.startsWith('<?')) return { kind: 3, endMarker: '?>' };
  if (rest.startsWith('<!') && rest.length > 2 && isAlpha(rest.charCodeAt(2))) return { kind: 4, endMarker: '>' };
  if (rest.startsWith('<![CDATA[')) return { kind: 5, endMarker: ']]>' };
  // type 6: block tag
  let j = pos + 1, close = false;
  if (s.charCodeAt(j) === 47) { close = true; j++; }
  if (j < s.length && isAlpha(s.charCodeAt(j))) {
    const ns = j;
    while (j < s.length && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
    const name = s.slice(ns, j).toLowerCase();
    const ac = s.charCodeAt(j);
    if (HTML_BLOCK_TAGS.has(name) && (j >= s.length || ac === 32 || ac === 9 || ac === 62 || (ac === 47 && s.charCodeAt(j + 1) === 62))) {
      return { kind: 6, endMarker: null };
    }
  }
  // type 7: a complete open or closing tag alone on the line
  if (!paraOpen) {
    const t = rest.trim();
    if (t.indexOf('\n') < 0 && isCompleteTag(t)) {
      return { kind: 7, endMarker: null };
    }
  }
  return null;
}

function bqMatch(ln) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return null;
  const s = ln.s;
  if (s.charCodeAt(ind.pos) !== 62) return null;
  // The whitespace run after '>' is expanded to spaces (one of those
  // spaces is the optional space after the marker). Tab stops are
  // computed from the start of this line's text, so that nesting a
  // blockquote does not change the expansion.
  let col = ind.indent + 1, pos = ind.pos + 1, ws = 0;
  while (pos < s.length) {
    const ch = s.charCodeAt(pos);
    if (ch === 32) { col++; ws++; pos++; }
    else if (ch === 9) { const w = 4 - (col % 4); col += w; ws += w; pos++; }
    else break;
  }
  const remaining = ws > 0 ? ws - 1 : 0;
  return { s: ' '.repeat(remaining) + s.slice(pos), c: ln.c + ind.indent + 1, eol: ln.eol };
}

function listMatch(ln) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) return null;
  const s = ln.s;
  let pos = ind.pos;
  let bullet = null, ordered = false, delim = null, num = 0;
  const c0 = s.charCodeAt(pos);
  if (c0 === 45 || c0 === 43 || c0 === 42) { bullet = s[pos]; pos++; }
  else if (isDigit(c0)) {
    let j = pos;
    while (j < s.length && isDigit(s.charCodeAt(j))) j++;
    if (j - pos > 9) return null;
    const d = s.charCodeAt(j);
    if (d !== 46 && d !== 41) return null;
    ordered = true; delim = s[j]; num = parseInt(s.slice(pos, j), 10);
    pos = j + 1;
  } else return null;
  const markerEnd = pos;
  const mw = (markerEnd - ind.pos) + ind.indent;
  if (markerEnd >= s.length) {
    return { bullet, ordered, delim, num, markerWidth: mw, contentIndent: mw + 1, content: { s: '', c: ln.c + mw + 1, eol: ln.eol }, empty: true };
  }
  const w = s.charCodeAt(markerEnd);
  if (w !== 32 && w !== 9) return null;
  const markerCol = ln.c + ind.indent + (markerEnd - ind.pos);
  let col = markerCol;
  let p = markerEnd, ws = 0;
  while (p < s.length && (s.charCodeAt(p) === 32 || s.charCodeAt(p) === 9)) {
    if (s.charCodeAt(p) === 32) { col++; ws++; }
    else { const tw = 4 - (col % 4); col += tw; ws += tw; }
    p++;
  }
  if (p >= s.length) {
    return { bullet, ordered, delim, num, markerWidth: mw, contentIndent: mw + 1, content: { s: '', c: ln.c + mw + 1, eol: ln.eol }, empty: true };
  }
  let contentIndent, content;
  if (ws >= 5) {
    // content starts 1 column after the marker; the rest of the expanded
    // whitespace is content
    content = { s: ' '.repeat(ws - 1) + s.slice(p), c: markerCol + 1, eol: ln.eol };
    contentIndent = mw + 1;
  } else {
    content = { s: s.slice(p), c: col, eol: ln.eol };
    contentIndent = col - ln.c;
  }
  return { bullet, ordered, delim, num, markerWidth: mw, contentIndent, content, empty: false };
}

// What block (if any) starts at this line? paraOpen = a paragraph is open.
function blockStart(ln, paraOpen) {
  const ind = lineIndent(ln);
  if (ind.indent > 3) {
    if (!paraOpen) return { kind: 'code' };
    return null;
  }
  const s = ln.s;
  const c = s.charCodeAt(ind.pos);
  if (c === 62) return { kind: 'bq' };
  if (c === 35) {
    const atx = parseATX(ln);
    if (atx) return { kind: 'atx', level: atx.level, text: atx.text };
  }
  if (c === 96 || c === 126) {
    const f = parseFence(ln);
    if (f) return { kind: 'fence', ch: f.ch, chCode: f.chCode, len: f.len, info: f.info, indent: f.indent };
  }
  if (c === 60) {
    const hb = parseHtmlBlockStart(ln, paraOpen);
    if (hb) return { kind: 'html', hkind: hb.kind, endTag: hb.endTag, endMarker: hb.endMarker };
  }
  if (paraOpen) {
    const se = setextLevel(ln);
    if (se) return { kind: 'setext', level: se };
  }
  if (isThematicBreak(ln)) return { kind: 'hr' };
  const lm = listMatch(ln);
  if (lm) {
    // A list marker inside a list item's content starts a nested list
    // even when a paragraph is open (the top-level interruption rule
    // does not apply there).
    if (paraOpen && !ln.nestedList) {
      if (!lm.empty && (!lm.ordered || lm.num === 1)) return { kind: 'list', ...lm };
      return null;
    }
    return { kind: 'list', ...lm };
  }
  return null;
}

// Render a paragraph's lines (definitions already consumed by the caller
// through consumeDefinitions). Returns the inline HTML, or '' if empty.
function paragraphInline(paraLines, refs, collect) {
  if (!paraLines.length) return '';
  let text = '';
  for (let k = 0; k < paraLines.length; k++) {
    if (k) text += '\n';
    text += lineText(paraLines[k]);
  }
  if (collect) return '';
  return inlineParse(text, refs);
}

function consumeDefinitions(paraLines, refs) {
  let k = 0;
  while (k < paraLines.length) {
    const used = tryDefinition(paraLines, k, refs);
    if (!used) break;
    k += used;
  }
  return k;
}


// ---- the block parser -----------------------------------------------------

function classifyAdded(ln, lastKind) {
  if (blankLine(ln)) return 'other';
  const bs = blockStart(ln, lastKind === 'para');
  if (!bs) return 'para';
  if (bs.kind === 'list') return 'list';
  if (bs.kind === 'bq') return 'bq';
  return 'other';
}

// A line of 0-3 spaces + a single tab (then only whitespace) is a
// table row of empty cells, not a blank line.
function isTableTabRow(ln) {
  const s = ln.s;
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 32) i++;
  if (i > 3 || i >= s.length || s.charCodeAt(i) !== 9) return false;
  i++;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  return i === s.length;
}

function tryTable(rest, refs, collect) {
  if (rest.length < 2) return null;
  if (lineIndent(rest[1]).indent > 3) return null;
  const headerCells = splitTableRow(lineText(rest[0]));
  const delimCells = splitTableRow(lineText(rest[1]));
  if (headerCells.length !== delimCells.length || headerCells.length === 0) return null;
  const aligns = [];
  for (const c of delimCells) {
    const a = isDelimCell(c);
    if (a === null) return null;
    aligns.push(a);
  }
  let bodyEnd = 2;
  while (bodyEnd < rest.length && (lineIndent(rest[bodyEnd]).indent <= 3 || isTableTabRow(rest[bodyEnd]))) bodyEnd++;
  // In collect mode the inline content is not needed (and must not
  // touch document-wide inline state); only the extent matters.
  if (collect) return { html: '', consumed: bodyEnd };
  let h = '<table>\n<thead>\n<tr>\n';
  for (let k = 0; k < headerCells.length; k++) {
    const a = aligns[k];
    h += '<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(headerCells[k], refs) + '</th>\n';
  }
  h += '</tr>\n</thead>\n';
  if (bodyEnd > 2) {
    h += '<tbody>';
    for (let r = 2; r < bodyEnd; r++) {
      const cells = splitTableRow(lineText(rest[r]));
      h += '<tr>\n';
      for (let k = 0; k < headerCells.length; k++) {
        const a = aligns[k];
        const cell = k < cells.length ? cells[k] : '';
        h += '<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(cell, refs) + '</td>\n';
      }
      h += '</tr>\n';
    }
    h += '</tbody></table>\n';
  } else {
    h += '</table>\n';
  }
  return { html: h, consumed: bodyEnd };
}

// Trim the leading whitespace of the first line and the trailing
// whitespace of the last line (setext heading text).
function trimParaEdges(rest) {
  const out = rest.slice();
  const first = out[0];
  let p = 0;
  while (p < first.s.length && (first.s.charCodeAt(p) === 32 || first.s.charCodeAt(p) === 9)) p++;
  if (p > 0) out[0] = { s: first.s.slice(p), c: first.c + p, eol: first.eol };
  const last = out[out.length - 1];
  let e = last.s.length;
  while (e > 0 && (last.s.charCodeAt(e - 1) === 32 || last.s.charCodeAt(e - 1) === 9)) e--;
  if (e < last.s.length) out[out.length - 1] = { s: last.s.slice(0, e), c: last.c, eol: last.eol };
  return out;
}

function parseBlocks(lines, refs, collect, tight, taskHtml) {
  let html = '';
  let blankBetween = false;
  let seenBlock = false;
  let pendingBlank = false;
  let i = 0;
  const n = lines.length;
  let para = [];
  let task = taskHtml || null;

  function emitBlock(h) {
    if (!h) return;
    if (seenBlock && pendingBlank) blankBetween = true;
    html += h;
    seenBlock = true;
    pendingBlank = false;
    task = null;
  }

  function flushPara() {
    if (!para.length) return;
    const k = consumeDefinitions(para, refs);
    const rest = para.slice(k);
    para = [];
    if (!rest.length) {
      // A definitions-only paragraph after a blank line still separates
      // blocks (a list item holding one after a paragraph is loose).
      if (seenBlock && pendingBlank) blankBetween = true;
      return;
    }
    if (!collect) {
      const tbl = tryTable(rest, refs, collect);
      if (tbl) {
        task = null;
        emitBlock(tbl.html);
        if (tbl.consumed < rest.length) {
          const leftover = rest.slice(tbl.consumed);
          const r = parseBlocks(leftover, refs, false, tight, null);
          if (r.blankBetween) blankBetween = true;
          if (r.html) emitBlock(r.html);
        }
        return;
      }
    }
    const inline = paragraphInline(rest, refs, collect);
    if (!inline) return;
    const t = !seenBlock ? task : null;
    task = null;
    let h;
    if (tight) h = (t || '') + inline;
    else h = '<p>' + (t || '') + inline + '</p>\n';
    emitBlock(h);
  }

  while (i < n) {
    const ln = lines[i];
    // A tab-row line (0-3 spaces + tab) is a table row of empty cells,
    // not a blank line, when the open paragraph is a table.
    if (para.length && isTableTabRow(ln)) {
      const probe = tryTable(para.concat([ln]), refs, true);
      if (probe && probe.consumed === para.length + 1) {
        para.push(ln);
        i++;
        continue;
      }
    }
    if (paraBlank(ln)) { flushPara(); pendingBlank = true; i++; continue; }
    // A whitespace-only last line with no paragraph open is skipped.
    if (blankLine(ln) && !para.length) { i++; continue; }
    if (para.length) {
      // A lazy line (marked by the container collector) is always a
      // paragraph continuation, never a new block.
      if (ln.lazy) { para.push(ln); i++; continue; }
      const se = setextLevel(ln);
      if (se) {
        const k = consumeDefinitions(para, refs);
        const rest = para.slice(k);
        para = [];
        if (rest.length) {
          const trimmed = trimParaEdges(rest);
          const inline = paragraphInline(trimmed, refs, collect);
          if (!collect && inline) emitBlock('<h' + se + '>' + inline + '</h' + se + '>\n');
          task = null;
        }
        if (rest.length) { i++; continue; }
        // The paragraph was only definitions: a level-1 underline is a
        // paragraph line; a level-2 underline becomes a thematic break.
        if (se === 1) { para.push(ln); i++; continue; }
      }
      const bs = blockStart(ln, true);
      if (bs) { flushPara(); const r = handleBlock(lines, i, bs, refs, collect, tight); i = r.next; if (r.html) emitBlock(r.html); if (r.endedWithBlank) pendingBlank = true; continue; }
      para.push(ln); i++; continue;
    }
    const bs = blockStart(ln, false);
    if (bs) { const r = handleBlock(lines, i, bs, refs, collect, tight); i = r.next; if (r.html) emitBlock(r.html); if (r.endedWithBlank) pendingBlank = true; continue; }
    para.push(ln); i++;
  }
  flushPara();
  return { html, blankBetween };
}

function handleBlock(lines, i, bs, refs, collect, tight) {
  switch (bs.kind) {
    case 'atx': {
      const h = collect ? '' : '<h' + bs.level + '>' + inlineParse(bs.text, refs) + '</h' + bs.level + '>\n';
      return { html: h, next: i + 1 };
    }
    case 'hr':
      return { html: collect ? '' : '<hr>\n', next: i + 1 };
    case 'fence': {
      const content = [];
      let j = i + 1;
      while (j < lines.length) {
        const ln = lines[j];
        const ind = lineIndent(ln);
        if (ind.indent <= 3) {
          const s = ln.s;
          let pos = ind.pos, len = 0;
          while (pos < s.length && s.charCodeAt(pos) === bs.chCode) { len++; pos++; }
          if (len >= bs.len) {
            let rest = pos;
            while (rest < s.length && (s.charCodeAt(rest) === 32 || s.charCodeAt(rest) === 9)) rest++;
            if (rest === s.length) { j++; break; }
          }
        }
        content.push(ln);
        j++;
      }
      if (collect) return { html: '', next: j };
      // Join the dedented lines; a trailing newline is added only when
      // the last content line is non-empty (a whitespace-only last line
      // counts as non-empty).
      const parts = [];
      for (const ln of content) parts.push(stripCols(ln, bs.indent, true).s);
      let code = parts.join('\n');
      if (parts.length && parts[parts.length - 1].length > 0) code += '\n';
      const lang = unescapeRaw(bs.info.split(/[\s\t]/)[0] || '');
      const h = '<pre><code' + (lang ? ' class="language-' + escAttrNoEncode(lang) + '"' : '') + '>' + escText(code) + '</code></pre>\n';
      return { html: h, next: j };
    }
    case 'code': {
      let j = i, lastNonBlank = i - 1;
      const content = [];
      while (j < lines.length) {
        const ln = lines[j];
        if (blankLine(ln)) { content.push(ln); j++; continue; }
        if (lineIndent(ln).indent >= 4) { content.push(ln); lastNonBlank = j; j++; continue; }
        break;
      }
      const keep = lastNonBlank - i + 1;
      if (collect) return { html: '', next: i + keep };
      let code = '';
      for (let k = 0; k < keep; k++) {
        const stripped = stripCols(content[k], 4, false);
        code += stripped.s + '\n';
      }
      return { html: '<pre><code>' + escText(code) + '</code></pre>\n', next: i + keep };
    }
    case 'html': {
      const out = [];
      let j = i;
      let endedAtBlank = false;
      if (bs.hkind === 6 || bs.hkind === 7) {
        while (j < lines.length && !blankLine(lines[j])) { out.push(lines[j]); j++; }
        endedAtBlank = j < lines.length;
      } else {
        while (j < lines.length) {
          const ln = lines[j];
          out.push(ln);
          j++;
          if (bs.endTag ? ln.s.toLowerCase().indexOf(bs.endTag) >= 0 : ln.s.indexOf(bs.endMarker) >= 0) break;
        }
      }
      if (collect) return { html: '', next: j };
      let h = '';
      // The trailing newline of the last line is dropped when the block
      // ended at a blank line, or when the next line is truly empty.
      // (A block that is the last one in a container loses it through
      // the container's last-line eol=false instead.)
      const dropNl = endedAtBlank || (j < lines.length && lines[j].s.length === 0);
      for (let t = 0; t < out.length; t++) {
        const ln = out[t];
        h += ln.s + ((ln.eol && !(t === out.length - 1 && dropNl)) ? '\n' : '');
      }
      return { html: h, next: j };
    }
    case 'bq': {
      const sub = [];
      let j = i;
      let lastKind = 'none';
      let lastLazy = false;
      // A fenced code block cannot have lazy lines: while one is open,
      // a line without a '>' prefix ends the quote.
      let fence = null;
      while (j < lines.length) {
        const ln = lines[j];
        const m = bqMatch(ln);
        if (m) {
          sub.push(m);
          // Track fence open/close on the stripped line.
          const f = parseFence(m);
          if (fence) {
            if (f && f.chCode === fence.chCode && f.len >= fence.len) fence = null;
          } else if (f) {
            fence = { chCode: f.chCode, len: f.len };
          }
          lastKind = classifyAdded(m, lastKind);
          lastLazy = false;
          j++;
          continue;
        }
        if (blankLine(ln)) break;
        if (!fence && ((!blockStart(ln, true) || setextLevel(ln) === 1) && !listMatch(ln))) {
          if (lastKind === 'para') {
            const ind = lineIndent(ln);
            let content = ln;
            if (ind.indent >= 4) content = stripCols(ln, 4, false);
            // A lazy level-1 setext underline following a lazy line is
            // indented by 4 spaces so it cannot form a heading.
            if (lastLazy && setextLevel(content) === 1) {
              let p = 0;
              while (p < content.s.length && (content.s.charCodeAt(p) === 32 || content.s.charCodeAt(p) === 9)) p++;
              content = { s: '    ' + content.s.slice(p), c: content.c, eol: content.eol };
            }
            // Mark the line lazy (a copy, never the original): inside the
            // quote it is always a paragraph continuation, never a block.
            sub.push({ s: content.s, c: content.c, eol: content.eol, lazy: true });
            lastLazy = true;
            j++;
            continue;
          }
          if (lastKind === 'list' || lastKind === 'bq') { sub.push(ln); lastLazy = true; j++; continue; }
        }
        break;
      }
      if (sub.length) sub[sub.length - 1] = { ...sub[sub.length - 1], eol: false };
      const inner = parseBlocks(sub, refs, collect, false, null);
      return { html: collect ? '' : '<blockquote>\n' + inner.html + '</blockquote>\n', next: j };
    }
    case 'list': {
      const r = tryList(lines, i, refs, collect, tight);
      return r;
    }
  }
  return { html: '', next: i + 1 };
}

// Expand a leading tab to spaces (to the next tab stop from ln.c).
// Container sub-lines expand tabs by absolute column; top-level lines
// keep tabs verbatim.
function expandLeadingTab(ln) {
  if (ln.s.charCodeAt(0) !== 9) return ln;
  const spaces = 4 - (ln.c % 4);
  const out = { s: ' '.repeat(spaces) + ln.s.slice(1), c: ln.c + spaces, eol: ln.eol };
  if (ln.lazy) out.lazy = true;
  return out;
}

function collectItem(lines, j, lm) {
  const sub = [];
  let firstLine = lm.content;
  let task = null;
  if (!lm.empty) {
    const s = firstLine.s;
    const tm = /^\[( |x|X)\]/.exec(s);
    if (tm && s.length > 3) {
      const after = s.charCodeAt(3);
      if (after === 32 || after === 9) {
        let k = 4;
        let col = firstLine.c + 3;
        while (k < s.length && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) {
          if (s.charCodeAt(k) === 32) col++;
          else col += 4 - (col % 4);
          k++;
        }
        if (k < s.length) {
          task = tm[1] === ' ' ? '<input disabled="" type="checkbox"> ' : '<input checked="" disabled="" type="checkbox"> ';
          firstLine = { s: s.slice(k), c: col, eol: firstLine.eol };
        }
      }
    }
  }
  sub.push(firstLine);
  let lastKind = classifyAdded(firstLine, 'none');
  // An empty item is closed by the first blank line after it: no more
  // content lines belong to it (a list marker still ends the item and
  // continues the list).
  let closed = false;
  let k = j + 1;
  while (k < lines.length) {
    const ln = lines[k];
    if (blankLine(ln)) {
      if (lm.empty) closed = true;
      sub.push(ln); lastKind = 'other'; k++; continue;
    }
    const ind = lineIndent(ln);
    if (ind.indent >= lm.contentIndent) {
      if (closed) break;
      const stripped = expandLeadingTab(stripCols(ln, lm.contentIndent, false));
      // A list marker at the content indent starts a nested list even
      // when a paragraph is open.
      if (listMatch(stripped)) stripped.nestedList = true;
      sub.push(stripped);
      lastKind = classifyAdded(stripped, lastKind);
      k++;
      continue;
    }
    const nm = listMatch(ln);
    if (nm && nm.bullet === lm.bullet && nm.ordered === lm.ordered && nm.delim === lm.delim) break;
    if ((!blockStart(ln, true) || setextLevel(ln) === 1) && !listMatch(ln)) {
      if (closed) break;
      if (lastKind === 'para') {
        let content = ln;
        // A lazy line stripped by 4 columns is a paragraph continuation
        // (like in a blockquote); an unstripped one is re-parsed as a
        // block and may start a nested list or heading.
        if (ind.indent >= 4) content = { ...stripCols(ln, 4, false), lazy: true };
        sub.push(content);
        k++;
        continue;
      }
      if (lastKind === 'list' || lastKind === 'bq') { sub.push(ln); k++; continue; }
    }
    break;
  }
  let trailingBlank = false;
  // The marker line itself must not count as a trailing blank.
  for (let t = sub.length - 1; t > 0; t--) {
    if (blankLine(sub[t])) trailingBlank = true;
    else break;
  }
  // Trailing blank lines are not part of the item's content: drop them
  // (the looseness is already recorded in trailingBlank).
  while (sub.length > 1 && blankLine(sub[sub.length - 1])) sub.pop();
  if (sub.length) sub[sub.length - 1] = { ...sub[sub.length - 1], eol: false };
  return { lines: sub, next: k, trailingBlank, task };
}

function tryList(lines, i, refs, collect, tight) {
  const first = listMatch(lines[i]);
  if (!first) return { html: '', next: i + 1 };
  const items = [];
  let j = i;
  while (j < lines.length) {
    if (isThematicBreak(lines[j])) break;
    const lm = listMatch(lines[j]);
    if (!lm) break;
    if (lm.bullet !== first.bullet || lm.ordered !== first.ordered || lm.delim !== first.delim) break;
    const item = collectItem(lines, j, lm);
    items.push(item);
    j = item.next;
  }
  if (collect) {
    for (const it of items) parseBlocks(it.lines, refs, true, true, it.task);
    return { html: '', next: j };
  }
  const rendered = items.map(it => parseBlocks(it.lines, refs, false, true, it.task));
  let loose = false;
  for (let idx = 0; idx < items.length; idx++) {
    if (items[idx].trailingBlank && idx < items.length - 1) loose = true;
    if (rendered[idx].blankBetween) loose = true;
  }
  let final = rendered;
  if (loose) final = items.map(it => parseBlocks(it.lines, refs, false, false, it.task));
  let h = first.ordered
    ? '<ol' + (first.num !== 1 ? ' start="' + first.num + '"' : '') + '>\n'
    : '<ul>\n';
  for (let idx = 0; idx < items.length; idx++) h += '<li>' + final[idx].html + '</li>\n';
  h += first.ordered ? '</ol>\n' : '</ul>\n';
  // The last item ended with a blank line and more content follows: the
  // blank line still separates blocks in the enclosing container.
  const endedWithBlank = items.length > 0 && items[items.length - 1].trailingBlank && j < lines.length;
  return { html: h, next: j, endedWithBlank };
}

export function parse(markdown) {
  inA = false; // document-wide: set by an inline <a>, cleared by inline </a>
  const src = String(markdown);
  const raw = src.split('\n');
  if (src.endsWith('\n')) raw.pop();
  const lines = raw.map(s => {
    let t = s;
    if (t.endsWith('\r')) t = t.slice(0, -1);
    return { s: t, c: 0, eol: true };
  });
  if (lines.length) lines[lines.length - 1].eol = src.endsWith('\n');
  const refs = new Map();
  inA = false;
  parseBlocks(lines, refs, true, false, null);
  inA = false; // the render pass starts fresh, not with collect's state
  return parseBlocks(lines, refs, false, false, null).html;
}
