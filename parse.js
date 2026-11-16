// parse.js — dependency-free Markdown renderer matching marked 18.1.3 defaults
// (gfm: true, breaks: false, pedantic: false, async: false).
// Written from scratch as a single-pass parser (block + inline).

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------
const HEX = "0123456789ABCDEF";

function isAsciiAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAsciiDigitCode(c) {
  return c >= 48 && c <= 57;
}
function isAlnumCode(c) {
  return isAsciiAlphaCode(c) || isAsciiDigitCode(c);
}
function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isAsciiPunct(c) {
  return isAsciiPunctCode(c.charCodeAt(0));
}
const NONASCII_PUNCT = /[\p{P}\p{S}]/u;
function isPunctCode(c) {
  if (c < 128) return isAsciiPunctCode(c);
  return NONASCII_PUNCT.test(String.fromCharCode(c));
}
function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 133;
}

// Unicode whitespace for emphasis flanking: JS \s plus U+0085.
function isUnicodeSpaceCode(c) {
  if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 133) return true;
  if (c === 160 || c === 5760 || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) return true;
  return c >= 8192 && c <= 8202;
}

// Escape text content: & < > " '
function escapeHtml(s) {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = "&amp;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Length of the entity starting at s[i] === '&' (named or numeric), or 0.
// Named entities are NOT decoded by marked (passed through verbatim), but
// they still count as entities for attribute escaping.
function entityLenAt(s, i) {
  const n = s.length;
  if (i + 1 >= n) return 0;
  const c = s.charCodeAt(i + 1);
  if (c === 35) {
    // numeric: &#...; or &#x...;
    let j = i + 2;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) {
      j++;
      const start = j;
      while (j < n && (isAsciiDigitCode(s.charCodeAt(j)) ||
          (s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 70) ||
          (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 102))) j++;
      if (j === start || j - start > 6 || j >= n || s.charCodeAt(j) !== 59) return 0;
      return j + 1 - i;
    }
    const start = j;
    while (j < n && isAsciiDigitCode(s.charCodeAt(j))) j++;
    if (j === start || j - start > 7 || j >= n || s.charCodeAt(j) !== 59) return 0;
    return j + 1 - i;
  }
  if (!isAlnumCode(c)) return 0;
  let j = i + 1;
  while (j < n && isAlnumCode(s.charCodeAt(j))) j++;
  if (j >= n || s.charCodeAt(j) !== 59) return 0;
  return j + 1 - i;
}

// Decode a numeric entity whose full text is s.slice(i, i + len).
// Invalid code points (0, surrogates, > 0x10FFFF) become U+FFFD.
function decodeNumeric(s, i, len) {
  const body = s.slice(i + 2, i + len - 1);
  let cp;
  if (body.charCodeAt(0) === 120 || body.charCodeAt(0) === 88) {
    cp = parseInt(body.slice(1), 16);
  } else {
    cp = parseInt(body, 10);
  }
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return "\uFFFD";
  return String.fromCodePoint(cp);
}

// Attribute escaping that is entity-aware: a valid entity (&name;, &#...;,
// &#x...;) passes through verbatim; a bare & becomes &amp;.
function escapeAttr(s) {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      const el = entityLenAt(s, i);
      if (el > 0) { i += el - 1; continue; }
      out += s.slice(start, i) + "&amp;";
      start = i + 1;
    } else if (c === 34) {
      out += s.slice(start, i) + "&quot;";
      start = i + 1;
    } else if (c === 39) {
      out += s.slice(start, i) + "&#39;";
      start = i + 1;
    } else if (c === 60) {
      out += s.slice(start, i) + "&lt;";
      start = i + 1;
    } else if (c === 62) {
      out += s.slice(start, i) + "&gt;";
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Plain attribute escaping (no entity awareness): every & becomes &amp;.
function escapeAttrPlain(s) {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = "&amp;";
    else if (c === 34) rep = "&quot;";
    else if (c === 39) rep = "&#39;";
    else if (c === 60) rep = "&lt;";
    else if (c === 62) rep = "&gt;";
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// encodeURI behaviour for hrefs: percent-encode " space < > ` { } | ^ [ ] \
// and non-ASCII (UTF-8); keep ' ~ ( ) ; , / ? : @ & = + $ - _ . ! * # %.
function encodeHref(s) {
  let out = "";
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 34) rep = "%22";
    else if (c === 32) rep = "%20";
    else if (c === 60) rep = "%3C";
    else if (c === 62) rep = "%3E";
    else if (c === 96) rep = "%60";
    else if (c === 123) rep = "%7B";
    else if (c === 125) rep = "%7D";
    else if (c === 124) rep = "%7C";
    else if (c === 94) rep = "%5E";
    else if (c === 91) rep = "%5B";
    else if (c === 93) rep = "%5D";
    else if (c === 92) rep = "%5C";
    else if (c > 127) {
      // UTF-8 percent-encoding
      const cp = s.codePointAt(i);
      if (cp > 0xFFFF) i++; // surrogate pair
      if (cp < 0x800) {
        const b1 = 0xC0 | (cp >> 6);
        const b2 = 0x80 | (cp & 0x3F);
        rep = "%" + HEX[b1 >> 4] + HEX[b1 & 15] + "%" + HEX[b2 >> 4] + HEX[b2 & 15];
      } else if (cp < 0x10000) {
        const b1 = 0xE0 | (cp >> 12);
        const b2 = 0x80 | ((cp >> 6) & 0x3F);
        const b3 = 0x80 | (cp & 0x3F);
        rep = "%" + HEX[b1 >> 4] + HEX[b1 & 15] + "%" + HEX[b2 >> 4] + HEX[b2 & 15] +
          "%" + HEX[b3 >> 4] + HEX[b3 & 15];
      } else {
        const b1 = 0xF0 | (cp >> 18);
        const b2 = 0x80 | ((cp >> 12) & 0x3F);
        const b3 = 0x80 | ((cp >> 6) & 0x3F);
        const b4 = 0x80 | (cp & 0x3F);
        rep = "%" + HEX[b1 >> 4] + HEX[b1 & 15] + "%" + HEX[b2 >> 4] + HEX[b2 & 15] +
          "%" + HEX[b3 >> 4] + HEX[b3 & 15] + "%" + HEX[b4 >> 4] + HEX[b4 & 15];
      }
    }
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
      // for a surrogate pair the second half was consumed by codePointAt;
      // the loop's i++ moves past it, and start must skip it too
      if (c > 127 && s.charCodeAt(i) >= 0xD800 && s.charCodeAt(i) <= 0xDBFF) {
        start = i + 2;
        i++;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Clean a link destination for use as an href.
function cleanHref(href) {
  return encodeHref(href);
}

// Normalise a link label: collapse whitespace runs to one space, trim,
// lowercase, with Unicode case folding for sharp s and final sigma.
function normalizeLabel(label) {
  return label.replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/\u00df/g, "ss").replace(/\u03c2/g, "\u03c3");
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------
// Node types (t):
//  0 text (escaped on render)  1 raw verbatim  2 code  3 br
//  4 delimiter {ch:'*'|'_'|'~', n, o:canOpen, c:canClose}
//  5 bracket {img}  6 link {href,title,img,ch}  7 autolink {href,text}
//  8 wrapper {tag:'em'|'strong'|'del', ch}  9 failed bracket (']' / '' in alt)

const EMAIL_LOCAL = "!#$%&'*+-/=?^_`{|}~";
function isEmailLocalCode(c) {
  return isAlnumCode(c) || c === 46 || EMAIL_LOCAL.indexOf(String.fromCharCode(c)) !== -1;
}
function isDomainCode(c) {
  return isAlnumCode(c) || c === 45 || c === 95;
}

// Scan a code span starting at s[i] === '`'. Returns {end, content} or null.
function scanCodeSpan(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && s.charCodeAt(j) === 96) j++;
  const run = j - i;
  let k = j;
  while (k < n) {
    if (s.charCodeAt(k) === 96) {
      let m = k;
      while (m < n && s.charCodeAt(m) === 96) m++;
      if (m - k === run) {
        let content = s.slice(j, k);
        // newlines become single spaces
        if (content.indexOf("\n") !== -1) content = content.replace(/\n/g, " ");
        // strip one leading + one trailing space if both present and not all spaces
        if (content.length >= 2 && content.charCodeAt(0) === 32 &&
            content.charCodeAt(content.length - 1) === 32 && content.trim() !== "") {
          content = content.slice(1, -1);
        }
        return { end: m, content };
      }
      k = m;
    } else {
      k++;
    }
  }
  return null;
}

// Try to parse an autolink or inline HTML tag starting at s[i] === '<'.
// Returns {end, kind:'auto'|'html', href, text} or null.
function tryAngle(s, i) {
  const n = s.length;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) {
    // comment / declaration / CDATA
    if (s.startsWith("<!--", i)) {
      let j = i + 4;
      if (s.startsWith(">", j)) return { end: j + 1, kind: "html" };
      if (s.startsWith("->", j)) return { end: j + 2, kind: "html" };
      const e = s.indexOf("-->", j);
      if (e !== -1) return { end: e + 3, kind: "html" };
      return null;
    }
    if (s.startsWith("<![CDATA[", i)) {
      const e = s.indexOf("]]>", i + 9);
      if (e !== -1) return { end: e + 3, kind: "html" };
      return null;
    }
    // declaration: <! + 1+ letters + 1+ whitespace + ... >
    let j = i + 2;
    if (j < n && isAsciiAlphaCode(s.charCodeAt(j))) {
      while (j < n && isAsciiAlphaCode(s.charCodeAt(j))) j++;
      if (j < n && isSpaceCode(s.charCodeAt(j))) {
        const e = s.indexOf(">", j);
        if (e !== -1) return { end: e + 1, kind: "html" };
      }
    }
    return null;
  }
  if (c1 === 63) {
    const e = s.indexOf("?>", i + 2);
    if (e !== -1) return { end: e + 2, kind: "html" };
    return null;
  }
  // tag: < /? name ...
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n || !isAsciiAlphaCode(s.charCodeAt(j))) {
    // not a tag: try autolink <scheme:...> or <email>
    return tryBracketAutolink(s, i);
  }
  while (j < n && (isAsciiAlphaCode(s.charCodeAt(j)) || isAsciiDigitCode(s.charCodeAt(j)) || s.charCodeAt(j) === 45)) j++;
  if (closing) {
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 62) return { end: j + 1, kind: "html" };
    return tryBracketAutolink(s, i);
  }
  // open tag: attributes (each preceded by whitespace, or '>' / '/>' to close)
  while (true) {
    if (j >= n) return tryBracketAutolink(s, i);
    const cj = s.charCodeAt(j);
    if (cj === 62) return { end: j + 1, kind: "html" };
    if (cj === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return { end: j + 2, kind: "html" };
      return tryBracketAutolink(s, i);
    }
    if (!isSpaceCode(cj)) return tryBracketAutolink(s, i);
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
    if (j >= n) return tryBracketAutolink(s, i);
    const cj2 = s.charCodeAt(j);
    if (cj2 === 62) return { end: j + 1, kind: "html" };
    if (cj2 === 47) {
      if (j + 1 < n && s.charCodeAt(j + 1) === 62) return { end: j + 2, kind: "html" };
      return tryBracketAutolink(s, i);
    }
    // attribute name
    if (!(isAsciiAlphaCode(cj2) || cj2 === 95 || cj2 === 58)) return tryBracketAutolink(s, i);
    j++;
    while (j < n) {
      const ca = s.charCodeAt(j);
      if (isAsciiAlphaCode(ca) || isAsciiDigitCode(ca) || ca === 95 || ca === 46 || ca === 58 || ca === 45) j++;
      else break;
    }
    // a value follows only if '=' comes after optional whitespace;
    // otherwise leave j at the whitespace for the next attribute
    let k = j;
    while (k < n && isSpaceCode(s.charCodeAt(k))) k++;
    if (k < n && s.charCodeAt(k) === 61) {
      j = k + 1;
      while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
      if (j >= n) return tryBracketAutolink(s, i);
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) {
        const e = s.indexOf(String.fromCharCode(q), j + 1);
        if (e === -1) return tryBracketAutolink(s, i);
        j = e + 1;
      } else {
        // unquoted value
        if (j >= n) return tryBracketAutolink(s, i);
        const v0 = s.charCodeAt(j);
        if (v0 === 34 || v0 === 39 || v0 === 61 || v0 === 60 || v0 === 62 || v0 === 96 || isSpaceCode(v0)) return tryBracketAutolink(s, i);
        while (j < n) {
          const cv = s.charCodeAt(j);
          if (isSpaceCode(cv) || cv === 34 || cv === 39 || cv === 61 || cv === 60 || cv === 62 || cv === 96) break;
          j++;
        }
      }
    }
  }
}

// <scheme:...> or <email> autolink. Returns {end, kind:'auto', href, text} or null.
function tryBracketAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  if (j < n && isAsciiAlphaCode(s.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && (isAsciiAlphaCode(s.charCodeAt(k)) || isAsciiDigitCode(s.charCodeAt(k)) ||
        s.charCodeAt(k) === 43 || s.charCodeAt(k) === 46 || s.charCodeAt(k) === 45)) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
      // path: non-empty, no space/control/'<'
      let p = k + 1;
      while (p < n) {
        const cp = s.charCodeAt(p);
        if (cp === 62) {
          if (p === k + 1) return null;
          const raw = s.slice(i + 1, p);
          return { end: p + 1, kind: "auto", href: encodeHref(raw), text: raw };
        }
        if (cp <= 32 || cp === 60) return null;
        p++;
      }
      return null;
    }
  }
  // email: scan local part then '@' then domain with a dot
  let k = j;
  while (k < n && isEmailLocalCode(s.charCodeAt(k))) k++;
  if (k > j && k < n && s.charCodeAt(k) === 64) {
    let d = k + 1;
    let dots = 0;
    let lastLabelEnd = -1;
    while (d < n) {
      const ls = d;
      while (d < n && isDomainCode(s.charCodeAt(d))) d++;
      if (d === ls) return null;
      lastLabelEnd = d;
      if (d < n && s.charCodeAt(d) === 46) {
        dots++;
        d++;
        if (d >= n || s.charCodeAt(d) === 62) return null;
        continue;
      }
      break;
    }
    if (dots >= 1 && d < n && s.charCodeAt(d) === 62) {
      const raw = s.slice(i + 1, d);
      return { end: d + 1, kind: "auto", href: "mailto:" + encodeHref(raw), text: raw };
    }
  }
  return null;
}

// Extended autolink: www. or scheme URL at position i.
// Returns {end, href, text} or null. i points at the start.
function scanExtendedUrl(s, i) {
  const n = s.length;
  let j;
  let prefix = "";
  if (s.startsWith("www.", i)) {
    j = i + 4;
    // first label must be non-empty
    const ls = j;
    while (j < n && isDomainCode(s.charCodeAt(j))) j++;
    if (j === ls) return null;
    // further labels (a trailing '.' ends the domain)
    while (j < n && s.charCodeAt(j) === 46) {
      if (j + 1 < n && isDomainCode(s.charCodeAt(j + 1))) {
        j++;
        while (j < n && isDomainCode(s.charCodeAt(j))) j++;
      } else break;
    }
    prefix = "http://";
  } else {
    // scheme: http:// https:// ftp:// (case-insensitive)
    let sl = 0;
    if (s.slice(i, i + 7).toLowerCase() === "http://") sl = 7;
    else if (s.slice(i, i + 8).toLowerCase() === "https://") sl = 8;
    else if (s.slice(i, i + 6).toLowerCase() === "ftp://") sl = 6;
    else return null;
    j = i + sl;
    // first char after :// must be a domain char
    if (j >= n || !isDomainCode(s.charCodeAt(j))) return null;
  }
  // raw run: chars until whitespace or '<'
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 60 || isSpaceCode(c)) break;
    j++;
  }
  let url = s.slice(i, j);
  url = trimUrl(url);
  if (url.length === 0) return null;
  const href = prefix + encodeHref(url);
  return { end: i + url.length, href, text: url };
}

// Post-process a raw extended-autolink run:
//  1. cut at the first '(' that has no ')' after it
//  2. trim trailing punctuation (?!.,:;*_~'") — a ';' also eats a trailing &name entity
//  3. trim trailing ')'s: keep at most 1 after the last '(' (0 if no '(')
function trimUrl(url) {
  // 1. first '(' with no ')' after it
  const lastClose = url.lastIndexOf(")");
  let firstOpen = -1;
  for (let i = 0; i < url.length; i++) {
    if (url.charCodeAt(i) === 40) { firstOpen = i; break; }
  }
  if (firstOpen !== -1 && firstOpen > lastClose) {
    url = url.slice(0, firstOpen);
  }
  // 2. trailing punctuation
  const PUNCT = "?!.,:;*_~'\"";
  while (url.length > 0) {
    const last = url.charCodeAt(url.length - 1);
    if (PUNCT.indexOf(String.fromCharCode(last)) === -1) break;
    const wasSemi = last === 59;
    url = url.slice(0, -1);
    if (wasSemi) {
      // remove a trailing &name entity (letters/digits only after &)
      let k = url.length - 1;
      while (k >= 0 && isAlnumCode(url.charCodeAt(k))) k--;
      if (k >= 0 && url.charCodeAt(k) === 38 && k < url.length - 1) {
        url = url.slice(0, k);
      }
    }
  }
  // 3. trailing ')'s
  if (url.length > 0 && url.charCodeAt(url.length - 1) === 41) {
    const lastOpen = url.lastIndexOf("(");
    const keep = lastOpen === -1 ? 0 : 1;
    let t = 0;
    const after = lastOpen === -1 ? url : url.slice(lastOpen + 1);
    while (t < after.length && after.charCodeAt(after.length - 1 - t) === 41) t++;
    if (t > keep) url = url.slice(0, url.length - (t - keep));
  }
  return url;
}

// Email autolink starting at i (i is the first char of the local part).
// The extended autolink local part is restricted to [A-Za-z0-9._+-].
// Returns the end index (exclusive) or 0.
function scanEmail(s, i) {
  const n = s.length;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (!isAlnumCode(c) && c !== 46 && c !== 43 && c !== 95 && c !== 45) break;
    j++;
  }
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return 0;
  let k = j + 1;
  let dots = 0;
  while (true) {
    const ls = k;
    while (k < n && isDomainCode(s.charCodeAt(k))) k++;
    if (k === ls) return 0;
    if (k < n && s.charCodeAt(k) === 46) {
      // '.' only counts if a non-empty label follows
      if (k + 1 < n && isDomainCode(s.charCodeAt(k + 1))) {
        dots++;
        k++;
        continue;
      }
      break;
    }
    break;
  }
  if (dots === 0) return 0;
  // last label must end with an alphanumeric
  if (!isAlnumCode(s.charCodeAt(k - 1))) return 0;
  return k;
}

// Parse a link reference label starting at s[i] === '['.
// Returns {end, label} (end = index after ']') or null.
function parseRefLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let label = "";
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) {
      // backslash escape: keep both chars for label matching
      label += s[j] + s[j + 1];
      j += 2;
    } else if (c === 93) {
      if (label.length === 0 || label.length > 999) return null;
      return { end: j + 1, label };
    } else if (c === 91) {
      // unescaped '[' inside a label makes it invalid
      return null;
    } else {
      label += s[j];
      j++;
    }
  }
  return null;
}

// Parse an inline link destination starting at s[i] === '('.
// Returns {end, href, title} (end = index after ')') or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  let href = "";
  if (s.charCodeAt(j) === 60) {
    // <...> destination (no newline inside)
    j++;
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 10) return null;
      if (c === 62) {
        href = s.slice(start, j);
        // process backslash escapes inside <...>
        href = href.replace(/\\([!-/:-@\[-`{-~])/g, "$1");
        j++;
        break;
      }
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) j += 2;
      else j++;
    }
    if (j > n || s.charCodeAt(j - 1) !== 62) return null;
  } else {
    // bare destination: balanced parens, no spaces/controls
    const start = j;
    let depth = 0;
    let ok = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) { depth++; j++; continue; }
      if (c === 41) {
        if (depth === 0) { ok = true; break; }
        depth--;
        j++;
        continue;
      }
      j++;
    }
    if (!ok && j >= n) return null;
    href = s.slice(start, j);
    href = href.replace(/\\([!-/:-@\[-`{-~])/g, "$1");
  }
  // optional title — must be preceded by whitespace after the destination
  let skipped = 0;
  while (j < n && isSpaceCode(s.charCodeAt(j))) { j++; skipped++; }
  let title = null;
  if (skipped > 0 && j < n && (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39 || s.charCodeAt(j) === 40)) {
    const q = s.charCodeAt(j);
    j++;
    const start = j;
    if (q === 40) {
      // parenthesised title: no unescaped ( or ) inside
      let found = false;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
        if (c === 41) { found = true; break; }
        if (c === 40) return null;
        j++;
      }
      if (!found) return null;
      title = s.slice(start, j);
      j++;
    } else {
      let found = false;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92 && j + 1 < n) { j += 2; continue; }
        if (c === q) { found = true; break; }
        j++;
      }
      if (!found) return null;
      title = s.slice(start, j);
      j++;
    }
    title = title.replace(/\\([!-/:-@\[-`{-~])/g, "$1");
    // after a title, only whitespace and ')' may follow
    while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
  }
  if (j >= n || s.charCodeAt(j) !== 41) return null;
  return { end: j + 1, href: cleanHref(href), title: title === null ? null : title };
}

// ---------------------------------------------------------------------------
// Inline scanner
// ---------------------------------------------------------------------------

// Compute left/right flanking for a delimiter run starting at s[i] (length run).
function delimFlanking(s, i, run) {
  const n = s.length;
  const before = i > 0 ? s.charCodeAt(i - 1) : 10;
  const after = i + run < n ? s.charCodeAt(i + run) : 10;
  const beforeSpace = isUnicodeSpaceCode(before);
  const afterSpace = isUnicodeSpaceCode(after);
  const beforePunct = isPunctCode(before);
  const afterPunct = isPunctCode(after);
  const leftFlanking = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const rightFlanking = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  return { leftFlanking, rightFlanking };
}

// Does any node in the list (recursively) contain a link (not an image)?
function containsLink(nodes) {
  for (const node of nodes) {
    if (node.t === 6 && !node.img) return true;
    if (node.t === 6 || node.t === 8) {
      if (containsLink(node.ch)) return true;
    }
  }
  return false;
}

// Plain-text rendering of a node list (used for image alt text and ref labels).
function plainText(nodes) {
  let out = "";
  for (const node of nodes) {
    switch (node.t) {
      case 0: case 1: case 2: out += node.s; break;
      case 4: out += node.ch.repeat(node.n); break;
      case 6: case 8: out += plainText(node.ch); break;
      case 7: out += node.text; break;
      case 9: out += node.s; break;
      default: break;
    }
  }
  return out;
}

// Render a node list to HTML.
function renderInline(nodes) {
  let out = "";
  for (const node of nodes) {
    switch (node.t) {
      case 0: out += escapeHtml(node.s); break;
      case 1: out += node.s; break;
      case 2: out += "<code>" + escapeHtml(node.s) + "</code>"; break;
      case 3: out += "<br>"; break;
      case 4: out += escapeHtml(node.ch.repeat(node.n)); break;
      case 5: out += node.img ? "![" : "["; break;
      case 6:
        if (node.img) {
          out += '<img src="' + escapeAttr(node.href) + '" alt="' +
            escapeAttr(plainText(node.ch)) + '"';
          if (node.title !== null && node.title !== "") {
            out += ' title="' + escapeAttr(node.title) + '"';
          }
          out += ">";
        } else {
          out += '<a href="' + escapeAttr(node.href) + '"';
          if (node.title !== null && node.title !== "") {
            out += ' title="' + escapeAttr(node.title) + '"';
          }
          out += ">" + renderInline(node.ch) + "</a>";
        }
        break;
      case 7:
        out += '<a href="' + escapeAttrPlain(node.href) + '">' +
          escapeHtml(node.text) + "</a>";
        break;
      case 8:
        out += "<" + node.tag + ">" + renderInline(node.ch) + "</" + node.tag + ">";
        break;
      case 9: out += escapeHtml(node.s); break;
    }
  }
  return out;
}

// Emphasis / strong / strikethrough processing (delimiter-stack algorithm).
function processEmphasis(nodes) {
  for (const node of nodes) {
    if (node.t === 6 || node.t === 8) processEmphasis(node.ch);
  }
  // collect top-level delimiters
  let delims = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].t === 4) delims.push({ idx: i, node: nodes[i] });
  }
  if (delims.length === 0) return;
  // process closers left to right; restart after each match
  let guard = 0;
  while (guard++ < 100000) {
    let matched = false;
    for (let di = 0; di < delims.length; di++) {
      const closer = delims[di];
      if (!closer.node.c || closer.node.n === 0) continue;
      // look backwards for the nearest usable opener
      let found = -1;
      for (let oi = di - 1; oi >= 0; oi--) {
        const opener = delims[oi];
        if (opener.node.n === 0 || !opener.node.o || opener.node.ch !== closer.node.ch) continue;
        if (opener.node.c || closer.node.o) {
          // an opener longer than the closer can never be fully consumed
          // by it, so it cannot match this closer
          if (opener.node.n > closer.node.n) continue;
          // odd-match rule: skip when the run lengths are 1 and 2 (in
          // either order) modulo 3; runs both divisible by 3 do match
          const om = opener.node.n % 3, cm = closer.node.n % 3;
          if ((om === 1 && cm === 2) || (om === 2 && cm === 1)) continue;
        }
        found = oi;
        break;
      }
      if (found === -1) continue;
      const opener = delims[found];
      const use = (opener.node.n >= 2 && closer.node.n >= 2) ? 2 : 1;
      const tag = closer.node.ch === "~" ? "del" : (use === 2 ? "strong" : "em");
      const inner = nodes.slice(opener.idx + 1, closer.idx);
      processEmphasis(inner);
      const wrapper = { t: 8, tag, ch: inner };
      opener.node.n -= use;
      closer.node.n -= use;
      // replace the range [opener.idx, closer.idx] with
      // [opener leftover?, wrapper, closer leftover?]
      const repl = [];
      if (opener.node.n > 0) repl.push({ t: 4, ch: opener.node.ch, n: opener.node.n, o: opener.node.o, c: opener.node.c });
      repl.push(wrapper);
      if (closer.node.n > 0) repl.push({ t: 4, ch: closer.node.ch, n: closer.node.n, o: closer.node.o, c: closer.node.c });
      nodes.splice(opener.idx, closer.idx - opener.idx + 1, ...repl);
      matched = true;
      break;
    }
    if (!matched) break;
    // re-collect delimiters and restart
    delims = [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].t === 4) delims.push({ idx: i, node: nodes[i] });
    }
    if (delims.length === 0) break;
  }
}

// Parse inline content into HTML. refs is a Map of normalised label -> {href, title}.
function parseInline(s, refs) {
  const nodes = [];
  let text = "";
  const n = s.length;
  let i = 0;
  const flush = () => {
    if (text.length > 0) { nodes.push({ t: 0, s: text }); text = ""; }
  };
  // Try an extended-autolink email starting at pos (0 if none, or if the
  // previous char is an email-local char so the email starts earlier).
  const tryEmail = (pos) => {
    const prev = pos > 0 ? s.charCodeAt(pos - 1) : -1;
    if (prev !== -1 && (isAlnumCode(prev) || prev === 46 || prev === 43 || prev === 95 || prev === 45)) return 0;
    return scanEmail(s, pos);
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      // backslash
      const d = i + 1 < n ? s.charCodeAt(i + 1) : -1;
      if (d === 10) {
        flush();
        nodes.push({ t: 3 });
        i += 2;
        // a hard break strips leading spaces/tabs on the next line
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      }
      else if (d !== -1 && isAsciiPunctCode(d)) { text += s[i + 1]; i += 2; }
      else { text += "\\"; i += 1; }
    } else if (c === 96) {
      // backtick run: code span; an unmatched run is literal text
      const cs = scanCodeSpan(s, i);
      if (cs) { flush(); nodes.push({ t: 2, s: cs.content }); i = cs.end; }
      else {
        let j = i;
        while (j < n && s.charCodeAt(j) === 96) j++;
        text += s.slice(i, j);
        i = j;
      }
    } else if (c === 60) {
      // < : autolink or inline HTML
      const a = tryAngle(s, i);
      if (a) {
        flush();
        if (a.kind === "auto") nodes.push({ t: 7, href: a.href, text: a.text });
        else nodes.push({ t: 1, s: s.slice(i, a.end) });
        i = a.end;
      } else { text += "<"; i += 1; }
    } else if (c === 38) {
      // & : entity
      const el = entityLenAt(s, i);
      if (el > 0) {
        if (s.charCodeAt(i + 1) === 35) {
          text += decodeNumeric(s, i, el);
        } else {
          flush();
          nodes.push({ t: 1, s: s.slice(i, i + el) });
        }
        i += el;
      } else { text += "&"; i += 1; }
    } else if (c === 32) {
      // spaces: 2+ spaces followed by a newline is a hard break
      let j = i;
      while (j < n && s.charCodeAt(j) === 32) j++;
      if (j - i >= 2 && j < n && s.charCodeAt(j) === 10) {
        flush();
        nodes.push({ t: 3 });
        i = j + 1;
        // a hard break strips leading spaces/tabs on the next line
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
      } else {
        text += s.slice(i, j);
        i = j;
      }
    } else if (c === 42 || c === 95 || c === 126) {
      // delimiter run
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const run = j - i;
      if (c === 126 && run >= 3) {
        text += s.slice(i, j);
        i = j;
      } else {
        const fl = delimFlanking(s, i, run);
        let canOpen, canClose;
        if (c === 95) {
          canOpen = fl.leftFlanking && (!fl.rightFlanking || isPunctCode(i > 0 ? s.charCodeAt(i - 1) : 10));
          canClose = fl.rightFlanking && (!fl.leftFlanking || isPunctCode(i + run < n ? s.charCodeAt(i + run) : 10));
        } else {
          canOpen = fl.leftFlanking;
          canClose = fl.rightFlanking;
        }
        flush();
        nodes.push({ t: 4, ch: String.fromCharCode(c), n: run, o: canOpen, c: canClose });
        i = j;
      }
    } else if (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91) {
      // ![
      flush();
      nodes.push({ t: 5, img: true, start: i + 2 });
      i += 2;
    } else if (c === 91) {
      // [
      flush();
      nodes.push({ t: 5, img: false, start: i + 1 });
      i += 1;
    } else if (c === 93) {
      // ] : try to form a link / image
      flush();
      i = resolveBracket(nodes, refs, s, i);
    } else if (c === 119 && s.startsWith("www.", i)) {
      const u = scanExtendedUrl(s, i);
      if (u) { flush(); nodes.push({ t: 7, href: u.href, text: u.text }); i = u.end; }
      else {
        const e = tryEmail(i);
        if (e > 0) {
          flush();
          const raw = s.slice(i, e);
          nodes.push({ t: 7, href: "mailto:" + encodeHref(raw), text: raw });
          i = e;
        } else { text += "w"; i += 1; }
      }
    } else if (c === 104 || c === 72 || c === 102 || c === 70) {
      const u = scanExtendedUrl(s, i);
      if (u) {
        flush();
        nodes.push({ t: 7, href: u.href, text: u.text });
        i = u.end;
      } else {
        const e = tryEmail(i);
        if (e > 0) {
          flush();
          const raw = s.slice(i, e);
          nodes.push({ t: 7, href: "mailto:" + encodeHref(raw), text: raw });
          i = e;
        } else { text += s[i]; i += 1; }
      }
    } else if (c === 109 && s.startsWith("mailto:", i)) {
      const e = scanEmail(s, i + 7);
      if (e > 0) {
        flush();
        const raw = s.slice(i, e);
        nodes.push({ t: 7, href: "mailto:" + encodeHref(raw.slice(7)), text: raw });
        i = e;
      } else { text += "m"; i += 1; }
    } else if (c === 120 && s.startsWith("xmpp:", i)) {
      // xmpp: + email + optional single path segment
      const e = scanEmail(s, i + 5);
      if (e > 0) {
        let end = e;
        if (end < n && s.charCodeAt(end) === 47) {
          let k = end + 1;
          while (k < n) {
            const cc = s.charCodeAt(k);
            if (cc === 47 || cc === 60 || isSpaceCode(cc)) break;
            k++;
          }
          end = k;
        }
        const raw = trimUrl(s.slice(i, end));
        if (raw.length > 0) {
          flush();
          nodes.push({ t: 7, href: encodeHref(raw), text: raw });
          i = i + raw.length;
        } else { text += "x"; i += 1; }
      } else { text += "x"; i += 1; }
    } else if (isAlnumCode(c) || c === 46 || c === 43 || c === 95 || c === 45) {
      // possible email start
      const e = tryEmail(i);
      if (e > 0) {
        flush();
        const raw = s.slice(i, e);
        nodes.push({ t: 7, href: "mailto:" + encodeHref(raw), text: raw });
        i = e;
      } else { text += s[i]; i += 1; }
    } else {
      text += s[i];
      i += 1;
    }
  }
  flush();
  processEmphasis(nodes);
  return renderInline(nodes);
}

// Handle a ']' at position i in s. Returns the index to continue scanning from.
function resolveBracket(nodes, refs, s, i) {
  // find the nearest active bracket (link nodes are siblings, not
  // blockers: a link inside the bracket's text is handled below)
  let k = -1;
  for (let j = nodes.length - 1; j >= 0; j--) {
    const node = nodes[j];
    if (node.t === 5) { k = j; break; }
  }
  if (k === -1) {
    // no bracket: the ']' is literal
    nodes.push({ t: 9, s: "]" });
    return i + 1;
  }
  const bracket = nodes[k];
  const children = nodes.slice(k + 1);
  // a link's text may not contain a link; an image's description may
  if (!bracket.img && containsLink(children)) {
    // the link text contains a link: deactivate the bracket
    nodes[k] = { t: 9, s: bracket.img ? "![" : "[" };
    nodes.push({ t: 9, s: "]" });
    return i + 1;
  }
  const n = s.length;
  let href = null;
  let title = null;
  let end = -1;
  const after = i + 1 < n ? s.charCodeAt(i + 1) : -1;
  if (after === 40) {
    // inline link: if it fails, fall back to a shortcut reference
    const link = parseInlineLink(s, i + 1);
    if (link) { href = link.href; title = link.title; end = link.end; }
    else {
      const label = normalizeLabel(s.slice(bracket.start, i));
      if (label !== "") {
        const ref = refs.get(label);
        if (ref) { href = ref.href; title = ref.title; end = i + 1; }
      }
    }
  } else if (after === 91) {
    // full or collapsed reference: if it fails, no shortcut fallback
    if (i + 2 < n && s.charCodeAt(i + 2) === 93) {
      // collapsed: label is the raw link text
      const label = normalizeLabel(s.slice(bracket.start, i));
      if (label !== "") {
        const ref = refs.get(label);
        if (ref) { href = ref.href; title = ref.title; end = i + 3; }
      }
    } else {
      const rl = parseRefLabel(s, i + 1);
      if (rl) {
        const normLabel = normalizeLabel(rl.label);
        if (normLabel !== "") {
          const ref = refs.get(normLabel);
          if (ref) { href = ref.href; title = ref.title; end = rl.end; }
        }
      }
    }
  } else {
    // shortcut reference: label is the raw link text
    const label = normalizeLabel(s.slice(bracket.start, i));
    if (label !== "") {
      const ref = refs.get(label);
      if (ref) { href = ref.href; title = ref.title; end = i + 1; }
    }
  }
  if (href === null) {
    // not a link: deactivate the bracket
    nodes[k] = { t: 9, s: bracket.img ? "![" : "[" };
    nodes.push({ t: 9, s: "]" });
    return i + 1;
  }
  // form the link / image
  nodes.length = k;
  nodes.push({ t: 6, href, title, img: bracket.img, ch: children });
  return end;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Column of the char at index idx in line (tab-aware: tab advances to the
// next multiple of 4).
function colAt(line, idx) {
  let col = 0;
  for (let i = 0; i < idx; i++) {
    if (line.charCodeAt(i) === 9) col = (col + 4) & ~3;
    else col++;
  }
  return col;
}

// Scan indent from index idx: returns {col, next, absCol} where col is the
// indent in columns relative to idx, next is the index of the first
// non-space/tab char, and absCol is the absolute column of that char.
// Tab advances are computed from the absolute column.
function scanIndent(line, idx) {
  let absCol = colAt(line, idx);
  let relCol = 0;
  let i = idx;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32) { relCol++; absCol++; i++; }
    else if (c === 9) {
      const nextAbs = (absCol + 4) & ~3;
      relCol += nextAbs - absCol;
      absCol = nextAbs;
      i++;
    } else break;
  }
  return { col: relCol, next: i, absCol };
}

// Advance from index idx by `cols` columns (tab-aware, using the absolute
// column). Returns {idx, partial} where partial is the number of columns of
// a straddling tab that were consumed (0 if no tab was straddled).
function advanceCols(line, idx, cols) {
  const startCol = colAt(line, idx);
  const target = startCol + cols;
  let col = startCol;
  let i = idx;
  while (col < target && i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 9) {
      const next = (col + 4) & ~3;
      if (next > target) {
        return { idx: i, partial: target - col };
      }
      col = next;
      i++;
    } else if (c === 32) {
      col++;
      i++;
    } else break;
  }
  return { idx: i, partial: 0 };
}

// Is the line blank (only spaces/tabs)?
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ATX heading at index idx. Returns {level, text} or null.
function parseATX(line, idx) {
  const ind = scanIndent(line, idx);
  if (ind.col > 3) return null;
  let i = ind.next;
  let level = 0;
  while (i < line.length && line.charCodeAt(i) === 35 && level < 7) { level++; i++; }
  if (level === 0 || level > 6) return null;
  if (i >= line.length) return { level, text: "" };
  const c = line.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  // skip the space/tab after the hashes
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  let text = line.slice(i);
  // strip trailing spaces/tabs, then a closing sequence of #'s preceded by a space
  // (the closing sequence may be the whole content: '### ###' -> <h3></h3>)
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
  if (end > 0 && text.charCodeAt(end - 1) === 35) {
    let h = end;
    while (h > 0 && text.charCodeAt(h - 1) === 35) h--;
    if (h === 0 || (text.charCodeAt(h - 1) === 32 || text.charCodeAt(h - 1) === 9)) {
      end = h;
      while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end--;
    }
  }
  return { level, text: text.slice(0, end) };
}

// Fenced code start at index idx. Returns {fence, len, indent, info} or null.
function parseFence(line, idx) {
  const ind = scanIndent(line, idx);
  if (ind.col > 3) return null;
  let i = ind.next;
  const fence = line.charCodeAt(i);
  if (fence !== 96 && fence !== 126) return null;
  let len = 0;
  while (i < line.length && line.charCodeAt(i) === fence) { len++; i++; }
  if (len < 3) return null;
  const info = line.slice(i);
  if (fence === 96 && info.indexOf("`") !== -1) return null;
  return { fence, len, indent: ind.col, info };
}

// Thematic break at index idx?
function isHR(line, idx) {
  const ind = scanIndent(line, idx);
  if (ind.col > 3) return null;
  let i = ind.next;
  if (i >= line.length) return false;
  const ch = line.charCodeAt(i);
  if (ch !== 42 && ch !== 45 && ch !== 95) return false;
  let count = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === ch) { count++; i++; }
    else if (c === 32 || c === 9) i++;
    else return false;
  }
  return count >= 3;
}

// Setext underline at index idx. Returns 1 (=) or 2 (-) or 0.
function setextLevel(line, idx) {
  const ind = scanIndent(line, idx);
  if (ind.col > 3) return 0;
  let i = ind.next;
  if (i >= line.length) return 0;
  const ch = line.charCodeAt(i);
  if (ch !== 61 && ch !== 45) return 0;
  // a contiguous run of the char, then only trailing spaces/tabs
  while (i < line.length && line.charCodeAt(i) === ch) i++;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  if (i < line.length) return 0;
  return ch === 61 ? 1 : 2;
}

// List marker at index idx. Returns
// {ordered, bullet, delim, start, markerLen, contentIndent, empty} or null.
function parseListMarker(line, idx) {
  const ind = scanIndent(line, idx);
  if (ind.col > 3) return null;
  let i = ind.next;
  if (i >= line.length) return null;
  const c = line.charCodeAt(i);
  let ordered = false;
  let bullet = 0;
  let delim = 0;
  let start = 1;
  let markerLen = 0;
  if (c === 45 || c === 43 || c === 42) {
    bullet = c;
    markerLen = 1;
    i++;
  } else if (c >= 48 && c <= 57) {
    let num = 0;
    let digits = 0;
    while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57 && digits < 9) {
      num = num * 10 + (line.charCodeAt(i) - 48);
      digits++;
      i++;
    }
    if (digits === 0 || digits > 9) return null;
    if (i >= line.length) return null;
    const d = line.charCodeAt(i);
    if (d !== 46 && d !== 41) return null;
    delim = d;
    ordered = true;
    start = num;
    markerLen = digits + 1;
    i++;
  } else return null;
  // the marker must be followed by a space/tab/EOL
  if (i < line.length) {
    const nc = line.charCodeAt(i);
    if (nc !== 32 && nc !== 9) return null;
  }
  // content indent: marker width + following spaces (1-4; if >= 5, marker + 1)
  let contentIndent;
  let empty = false;
  if (i >= line.length) {
    empty = true;
    contentIndent = ind.col + markerLen + 1;
  } else {
    // count the spaces/tabs after the marker (tab-aware, absolute columns)
    const baseCol = colAt(line, idx);
    let absCol = baseCol + ind.col + markerLen;
    let j = i;
    let spaces = 0;
    while (j < line.length) {
      const cc = line.charCodeAt(j);
      if (cc === 32) { spaces++; absCol++; j++; }
      else if (cc === 9) { const nc2 = (absCol + 4) & ~3; spaces += nc2 - absCol; absCol = nc2; j++; }
      else break;
    }
    if (j >= line.length) {
      empty = true;
      contentIndent = ind.col + markerLen + 1;
    } else if (spaces >= 5) {
      contentIndent = ind.col + markerLen + 1;
    } else {
      contentIndent = absCol - baseCol;
    }
  }
  return { ordered, bullet, delim, start, markerLen, contentIndent, empty, indent: ind.col };
}

const BLOCK_TAGS = new Set(("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul").split(" "));

// HTML block start at index idx. Returns the type (1-7) or 0.
function htmlBlockType(line, idx) {
  const ind = scanIndent(line, idx);
  if (ind.col > 3) return 0;
  let i = ind.next;
  if (i >= line.length || line.charCodeAt(i) !== 60) return 0;
  const s = line.slice(i);
  const lower = s.toLowerCase();
  // type 1: pre/script/style/textarea
  if (/^<(pre|script|style|textarea)([ \t>]|$)/.test(lower)) return 1;
  // type 2: comment
  if (lower.startsWith("<!--")) return 2;
  // type 3: processing instruction
  if (lower.startsWith("<?")) return 3;
  // type 4: declaration (<! + letter)
  if (lower.startsWith("<!") && lower.length > 2 && /[a-z]/.test(lower[2])) return 4;
  // type 5: CDATA
  if (lower.startsWith("<![cdata[")) return 5;
  // type 6: block tag
  const m6 = /^<\/?([a-z][a-z0-9-]*)([\s>\/]|$)/.exec(lower);
  if (m6 && BLOCK_TAGS.has(m6[1])) return 6;
  // type 7: a complete open or closing tag alone on the line
  // (a closing tag takes no attributes)
  if (lower.startsWith("</")) {
    if (/^<\/[a-z][a-z0-9-]*\s*>$/.test(lower)) return 7;
  } else {
    const m7 = /^<[a-z][a-z0-9-]*(\s+[a-z_:][a-z0-9_.:-]*(\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>$/.exec(lower);
    if (m7) return 7;
  }
  return 0;
}

// Does the line at index idx end an HTML block of the given type?
function htmlBlockEnds(type, line) {
  const lower = line.toLowerCase();
  switch (type) {
    case 1: {
      // ends at a line containing the matching closing tag
      const m = /<\/(pre|script|style|textarea)\s*>/.exec(lower);
      return m !== null;
    }
    case 2: return lower.indexOf("-->") !== -1;
    case 3: return lower.indexOf("?>") !== -1;
    case 4: return lower.indexOf(">") !== -1;
    case 5: return lower.indexOf("]]>") !== -1;
    default: return false;
  }
}

// Split a table row line into cells (split on unescaped |, trim each cell).
function splitTableRow(line) {
  const cells = [];
  let cur = "";
  let i = 0;
  const n = line.length;
  // leading pipe
  if (i < n && line.charCodeAt(i) === 124) i++;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && line.charCodeAt(i + 1) === 124) {
      cur += "|";
      i += 2;
    } else if (c === 92 && i + 1 < n && line.charCodeAt(i + 1) === 92) {
      cur += "\\\\";
      i += 2;
    } else if (c === 124) {
      cells.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += line[i];
      i++;
    }
  }
  // trailing pipe: the last cell after it is empty and dropped
  if (line.length > 0 && line.charCodeAt(line.length - 1) === 124) {
    // the last cell was already pushed at the final pipe; nothing extra
  } else {
    cells.push(cur.trim());
  }
  return cells;
}

// Parse a table delimiter line. Returns an array of alignments
// ('left'|'right'|'center'|null) or null if the line is not a delimiter.
function parseTableDelimiter(line) {
  // the delimiter line must contain a '|' (else it is a setext underline)
  if (line.indexOf("|") === -1) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const t = cell.trim();
    if (!/^:?-+:?$/.test(t)) return null;
    if (t.startsWith(":") && t.endsWith(":")) aligns.push("center");
    else if (t.endsWith(":")) aligns.push("right");
    else if (t.startsWith(":")) aligns.push("left");
    else aligns.push(null);
  }
  return aligns;
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

// Parse a link destination + optional title starting at s[i].
// Returns {end, href, title} or null.
function parseDestTitle(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && isSpaceCode(s.charCodeAt(j))) j++;
  if (j >= n) return null;
  let href = "";
  if (s.charCodeAt(j) === 60) {
    j++;
    const start = j;
    let found = false;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 10) return null;
      if (c === 62) { found = true; break; }
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) j += 2;
      else j++;
    }
    if (!found) return null;
    href = s.slice(start, j).replace(/\\([!-/:-@\[-`{-~])/g, "$1");
    j++;
  } else {
    const start = j;
    let depth = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 32 || c === 9 || c === 10 || c < 32) break;
      if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) { depth++; j++; continue; }
      if (c === 41) {
        if (depth === 0) break;
        depth--;
        j++;
        continue;
      }
      j++;
    }
    if (j === start) return null;
    href = s.slice(start, j).replace(/\\([!-/:-@\[-`{-~])/g, "$1");
  }
  // (afterDest is the position right after the destination, before any
  // whitespace skipped while looking for a title)
  const afterDest = j;
  let skipped = 0;
  while (j < n && isSpaceCode(s.charCodeAt(j))) { j++; skipped++; }
  let title = null;
  if (skipped > 0 && j < n && (s.charCodeAt(j) === 34 || s.charCodeAt(j) === 39 || s.charCodeAt(j) === 40)) {
    const q = s.charCodeAt(j);
    const titleStart = j;
    j++;
    const start = j;
    if (q === 40) {
      let found = false;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92 && j + 1 < n && isAsciiPunctCode(s.charCodeAt(j + 1))) { j += 2; continue; }
        if (c === 41) { found = true; break; }
        if (c === 40) return null;
        j++;
      }
      if (!found) return null;
      title = s.slice(start, j);
      j++;
    } else {
      let found = false;
      while (j < n) {
        const c = s.charCodeAt(j);
        if (c === 92 && j + 1 < n) { j += 2; continue; }
        if (c === q) { found = true; break; }
        j++;
      }
      if (!found) return null;
      title = s.slice(start, j);
      j++;
    }
    title = title.replace(/\\([!-/:-@\[-`{-~])/g, "$1");
    // after the title only whitespace may follow on its line; if there is
    // more content, the title is dropped when it is on a later line than
    // the destination, otherwise the whole definition fails
    let e = j;
    while (e < n && s.charCodeAt(e) !== 10) {
      const c = s.charCodeAt(e);
      if (c !== 32 && c !== 9) {
        const nlBetween = s.indexOf("\n", afterDest);
        if (nlBetween !== -1 && nlBetween < titleStart) {
          return { end: afterDest, href: cleanHref(href), title: null, afterDest };
        }
        return null;
      }
      e++;
    }
  }
  return { end: title === null ? afterDest : j, href: cleanHref(href), title, afterDest };
}

// Try to parse a link reference definition starting at `firstLine`, index idx.
// `lines`/`ln` give the following raw lines. The definition may span lines
// (label, destination and title on following lines) but never a blank line.
// Returns {consumed, label, href, title} or null.
function parseRefDef(firstLine, idx, lines, ln) {
  const line0 = firstLine.slice(idx);
  let p = 0;
  while (p < line0.length && (line0.charCodeAt(p) === 32 || line0.charCodeAt(p) === 9)) p++;
  if (p >= line0.length || line0.charCodeAt(p) !== 91) return null;
  // build the window: the first line plus following non-blank lines
  let window = line0;
  for (let k = ln + 1; k < lines.length && k < ln + 30; k++) {
    if (isBlankLine(lines[k])) break;
    window += "\n" + lines[k];
  }
  const rl = parseRefLabel(window, p);
  if (!rl) return null;
  if (normalizeLabel(rl.label) === "") return null;
  let q = rl.end;
  if (q >= window.length || window.charCodeAt(q) !== 58) return null;
  q++;
  const dt = parseDestTitle(window, q);
  if (!dt) return null;
  // the rest of the line after the dest/title must be only whitespace
  let e = dt.end;
  while (e < window.length && window.charCodeAt(e) !== 10) {
    const c = window.charCodeAt(e);
    if (c !== 32 && c !== 9) return null;
    e++;
  }
  let consumed = 1;
  for (let k = 0; k < dt.end; k++) if (window.charCodeAt(k) === 10) consumed++;
  return { consumed, label: rl.label, href: dt.href, title: dt.title };
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, refs) {
  let out = "";
  for (const b of blocks) out += renderBlock(b, refs);
  return out;
}

function renderBlock(b, refs) {
  switch (b.t) {
    case "para": {
      const text = b.lines.join("\n");
      return "<p>" + parseInline(text, refs) + "</p>\n";
    }
    case "h":
      return "<h" + b.level + ">" + parseInline(b.text, refs) + "</h" + b.level + ">\n";
    case "code": {
      let out = "<pre><code";
      if (b.info) out += ' class="language-' + escapeAttr(b.info) + '"';
      let content = b.content;
      // a fenced code block drops its final trailing blank line
      if (!b.indented && (content === "\n" || content.endsWith("\n\n"))) {
        content = content.slice(0, -1);
      }
      out += ">" + escapeHtml(content) + "</code></pre>\n";
      return out;
    }
    case "html":
      return b.raw;
    case "hr":
      return "<hr>\n";
    case "bq": {
      let out = "<blockquote>\n";
      out += renderBlocks(b.children, refs);
      out += "</blockquote>\n";
      return out;
    }
    case "list": {
      let out = b.ordered ? "<ol" : "<ul";
      if (b.ordered && b.start !== 1) out += ' start="' + b.start + '"';
      out += ">\n";
      for (const item of b.items) out += renderItem(item, b, refs);
      out += b.ordered ? "</ol>\n" : "</ul>\n";
      return out;
    }
    case "table": {
      let out = "<table>\n<thead>\n<tr>\n";
      for (let c = 0; c < b.header.length; c++) {
        const a = b.aligns[c];
        out += "<th" + (a ? ' align="' + a + '"' : "") + ">" +
          parseInline(b.header[c], refs) + "</th>\n";
      }
      out += "</tr>\n</thead>\n";
      if (b.rows.length > 0) {
        out += "<tbody>";
        for (const row of b.rows) {
          out += "<tr>\n";
          for (let c = 0; c < b.header.length; c++) {
            const a = b.aligns[c];
            out += "<td" + (a ? ' align="' + a + '"' : "") + ">" +
              parseInline(row[c] || "", refs) + "</td>\n";
          }
          out += "</tr>\n";
        }
        out += "</tbody></table>\n";
      } else {
        out += "</table>\n";
      }
      return out;
    }
    default:
      return "";
  }
}

// Render a list item. `list` is the parent list (for tight/loose).
function renderItem(item, list, refs) {
  let out = "<li>";
  const children = item.children;
  if (children.length === 0) { out += "</li>\n"; return out; }
  const bare = !list.loose;
  const first = children[0];
  if (first.t === "para") {
    // the first paragraph gets the task-list treatment; in a tight list
    // every paragraph renders without <p> tags
    out += renderParaContent(first, refs, bare);
    for (let k = 1; k < children.length; k++) {
      const child = children[k];
      if (child.t === "para") out += renderParaBare(child, refs, bare);
      else out += renderBlock(child, refs);
    }
  } else {
    for (const child of children) {
      if (child.t === "para") out += renderParaBare(child, refs, bare);
      else out += renderBlock(child, refs);
    }
  }
  out += "</li>\n";
  return out;
}

// Render a paragraph that is not the first child of its item: in a tight
// list it has no <p> tags and no task-list checkbox.
function renderParaBare(para, refs, bare) {
  const text = para.lines.join("\n");
  const inner = parseInline(text, refs);
  return bare ? inner : "<p>" + inner + "</p>\n";
}

// Render a paragraph's content, applying the task-list checkbox if present.
// `bare` means no <p> tags (tight list item).
function renderParaContent(para, refs, bare) {
  let text = para.lines.join("\n");
  let prefix = "";
  if (text.startsWith("[ ] ")) {
    prefix = '<input disabled="" type="checkbox"> ';
    text = text.slice(4);
  } else if (text.startsWith("[x] ") || text.startsWith("[X] ")) {
    prefix = '<input checked="" disabled="" type="checkbox"> ';
    text = text.slice(4);
  }
  const inner = prefix + parseInline(text, refs);
  return bare ? inner : "<p>" + inner + "</p>\n";
}

// ---------------------------------------------------------------------------
// Main block loop
// ---------------------------------------------------------------------------

// Replace the tab at index idx (starting at column col) with spaces, and
// return the new line plus the index after consuming `consume` columns of it.
function expandPartialTab(line, idx, col, consume) {
  const next = (col + 4) & ~3;
  const width = next - col;
  const newLine = line.slice(0, idx) + " ".repeat(width) + line.slice(idx + 1);
  return { line: newLine, idx: idx + consume };
}

function markerMatchesList(m, list) {
  if (list.ordered !== m.ordered) return false;
  if (m.ordered) return m.delim === list.delim;
  return m.bullet === list.bullet;
}

// Match the open containers against a line. Returns
// {line, idx, firstFailure, failIdx, sibling} where `line` is the (possibly
// tab-expanded) line, `idx` is the cursor after the matched markers,
// `firstFailure` is the stack depth of the first failed container (-1),
// `failIdx` is the cursor at the failure point, and `sibling` is set when a
// sibling list item marker was found ({depth, marker}).
function matchContainers(stack, line) {
  let idx = 0;
  let firstFailure = -1;
  let failIdx = 0;
  let sibling = null;
  for (let d = 1; d < stack.length; d++) {
    const cont = stack[d];
    if (cont.t === "bq") {
      if (firstFailure !== -1) break;
      const saveIdx = idx;
      const ind = scanIndent(line, idx);
      if (ind.col <= 3 && ind.next < line.length && line.charCodeAt(ind.next) === 62) {
        idx = ind.next + 1;
        if (idx < line.length) {
          const c = line.charCodeAt(idx);
          if (c === 32) idx++;
          else if (c === 9) {
            const col = colAt(line, idx);
            const r = expandPartialTab(line, idx, col, 1);
            line = r.line;
            idx = r.idx;
          }
        }
      } else {
        firstFailure = d;
        failIdx = saveIdx;
        break;
      }
    } else if (cont.t === "item") {
      if (firstFailure !== -1) break;
      const saveIdx = idx;
      const ind = scanIndent(line, idx);
      if (ind.col >= cont.contentIndent) {
        // an empty item that saw a blank line is closed: no more content
        if (cont.children.length === 0 && cont.sawBlank) {
          firstFailure = d;
          failIdx = saveIdx;
          break;
        }
        const adv = advanceCols(line, idx, cont.contentIndent);
        if (adv.partial > 0) {
          const col = colAt(line, adv.idx);
          const r = expandPartialTab(line, adv.idx, col, adv.partial);
          line = r.line;
          idx = r.idx;
        } else {
          idx = adv.idx;
        }
      } else {
        // sibling check (an HR beats a sibling list item)
        const list = stack[d - 1];
        const m = parseListMarker(line, idx);
        if (m && ind.col <= 3 && !isHR(line, idx) && markerMatchesList(m, list)) {
          sibling = { depth: d, marker: m };
          break;
        }
        // an empty item that saw a blank line is closed: no more content
        if (cont.children.length === 0 && cont.sawBlank) {
          firstFailure = d;
          failIdx = saveIdx;
          break;
        }
        firstFailure = d;
        failIdx = saveIdx;
        break;
      }
    }
  }
  return { line, idx, firstFailure, failIdx, sibling };
}

// Is the line (from idx) a block start that interrupts a paragraph?
// Returns the kind or null. `orderedStart1` handling is done by the caller.
function interruptKind(line, idx, paraOpen) {
  if (parseATX(line, idx)) return "atx";
  if (parseFence(line, idx)) return "fence";
  if (isHR(line, idx)) return "hr";
  const ht = htmlBlockType(line, idx);
  if (ht >= 1 && ht <= 6) return "html";
  if (line.charCodeAt(idx) === 62 || (scanIndent(line, idx).col <= 3 &&
      scanIndent(line, idx).next < line.length && line.charCodeAt(scanIndent(line, idx).next) === 62)) return "bq";
  const m = parseListMarker(line, idx);
  if (m) {
    if (!m.ordered) {
      if (!m.empty) return "list";
      // an empty bullet item cannot interrupt a paragraph
      return null;
    }
    // an ordered list interrupts a paragraph only if it starts with 1
    // and is not empty
    if (m.start === 1 && !m.empty) return "list";
    return null;
  }
  return null;
}

// Parse the blocks of the document (lines without trailing \n).
// lastNL: whether the last line ended with a newline. refs: the link ref map.
function parseBlocks(lines, lastNL, refs) {
  const doc = { t: "doc", children: [] };
  const stack = [doc];
  let leaf = null; // the current open leaf block
  const children = () => stack[stack.length - 1].children;
  const closeLeaf = () => { leaf = null; };
  const closeTo = (depth) => {
    // an HTML block closed by an interrupt loses its trailing newline
    if (leaf && leaf.t === "html" && leaf.raw.endsWith("\n")) leaf.raw = leaf.raw.slice(0, -1);
    while (stack.length > depth) stack.pop();
    leaf = null;
  };
  // Close the containers from `depth` up; if the failed container was an
  // item, its parent list is over too.
  const closeFailed = (depth) => {
    closeTo(depth);
    while (stack.length > 1 && stack[stack.length - 1].t === "list") stack.pop();
    leaf = null;
  };
  // does line ln have a trailing newline in the source?
  const lineHasNL = (ln) => ln < lines.length - 1 || lastNL;

  // append a line to a fenced/indented code block's content
  const codeAppend = (block, text, ln) => {
    block.content += text + (lineHasNL(ln) ? "\n" : "");
  };
  // append a line to an HTML block's raw text
  const htmlAppend = (block, text, ln) => {
    block.raw += text + (lineHasNL(ln) ? "\n" : "");
  };

  // start a new block at lines[ln], index idx. Returns the leaf (or null).
  // `container` is the current innermost container (for ref-def scoping).
  const startBlock = (ln, idx, line, paraStart) => {
    const ch = children();
    // looseness: a new block inside an item that saw a blank line (or
    // whose previous line was blank) and already has a child makes the
    // item's list loose
    const top = stack[stack.length - 1];
    if (top.t === "item" && (top.sawBlank || lastBlankLn === ln - 1) && top.children.length >= 1) {
      const list = stack[stack.length - 2];
      if (list && list.t === "list") list.loose = true;
      top.sawBlank = false;
    }
    // blockquote: '>' with <= 3 indent, optional one space/tab after
    const ind0 = scanIndent(line, idx);
    if (ind0.col <= 3 && ind0.next < line.length && line.charCodeAt(ind0.next) === 62) {
      closeLeaf();
      const block = { t: "bq", children: [] };
      ch.push(block);
      stack.push(block);
      let nidx = ind0.next + 1;
      let nline = line;
      if (nidx < line.length) {
        const c = line.charCodeAt(nidx);
        if (c === 32) nidx++;
        else if (c === 9) {
          const col = colAt(line, nidx);
          const r = expandPartialTab(line, nidx, col, 1);
          nline = r.line;
          nidx = r.idx;
        }
      }
      if (nidx >= nline.length) return null;
      return startBlock(ln, nidx, nline, false);
    }
    // ATX heading
    const atx = parseATX(line, idx);
    if (atx) {
      closeLeaf();
      ch.push({ t: "h", level: atx.level, text: atx.text });
      return null;
    }
    // fenced code
    const fence = parseFence(line, idx);
    if (fence) {
      closeLeaf();
      // first word of the info string, with backslash escapes unescaped
      const info = (fence.info.trim().split(/\s+/)[0] || "").replace(/\\([!-/:-@\[-`{-~])/g, "$1");
      const block = { t: "code", info, content: "", fence: fence.fence, fenceLen: fence.len, fenceIndent: fence.indent };
      ch.push(block);
      return block;
    }
    // thematic break
    if (isHR(line, idx)) {
      closeLeaf();
      ch.push({ t: "hr" });
      return null;
    }
    // HTML block (types 1-6 can interrupt; type 7 only when no paragraph)
    const ht = htmlBlockType(line, idx);
    if (ht >= 1 && (ht <= 6 || !paraStart)) {
      closeLeaf();
      const block = { t: "html", raw: "", type: ht };
      ch.push(block);
      htmlAppend(block, line.slice(idx), ln);
      if (ht >= 1 && ht <= 5 && htmlBlockEnds(ht, line.slice(idx))) {
        // ends on the same line; a following blank line drops the trailing \n
        if (ln + 1 < lines.length && isBlankLine(lines[ln + 1]) && block.raw.endsWith("\n")) {
          block.raw = block.raw.slice(0, -1);
        }
        return null;
      }
      return block;
    }
    // list
    const m = parseListMarker(line, idx);
    if (m) {
      closeLeaf();
      const list = {
        t: "list", ordered: m.ordered, delim: m.delim, bullet: m.bullet,
        start: m.start, loose: false, items: []
      };
      ch.push(list);
      stack.push(list);
      const item = { t: "item", children: [], contentIndent: m.contentIndent, sawBlank: false };
      list.items.push(item);
      stack.push(item);
      // the content after the marker
      const contentIdx = contentStart(line, idx, m);
      if (!m.empty) {
        return startItemContent(ln, contentIdx.line, contentIdx.idx);
      }
      return null;
    }
    // table (header + delimiter on the next line)
    if (ln + 1 < lines.length) {
      const headerCells = splitTableRow(line.slice(idx));
      const aligns = parseTableDelimiter(lines[ln + 1]);
      if (aligns && aligns.length === headerCells.length) {
        closeLeaf();
        const block = { t: "table", header: headerCells, aligns, rows: [] };
        ch.push(block);
        return { tablePending: block, skipLines: 1 };
      }
    }
    // indented code (only when no paragraph is open)
    if (!paraStart) {
      const ind = scanIndent(line, idx);
      if (ind.col >= 4) {
        closeLeaf();
        const adv = advanceCols(line, idx, 4);
        let text = line.slice(adv.idx);
        if (adv.partial > 0) {
          const col = colAt(line, adv.idx);
          const r = expandPartialTab(line, adv.idx, col, adv.partial);
          text = r.line.slice(r.idx);
        }
        const block = { t: "code", info: "", content: "", indented: true, pendingBlanks: [] };
        ch.push(block);
        codeAppend(block, text, ln);
        return block;
      }
    }
    // paragraph (with link reference definitions at the start)
    closeLeaf();
    const pr = startPara(ln, idx, line);
    if (pr.defsOnly) return { defsOnly: true, nextLn: pr.nextLn };
    ch.push(pr.para);
    return { leaf: pr.para, nextLn: pr.nextLn };
  };

  // Compute the content start after a list marker. Returns {line, idx}:
  // the (possibly modified) line and the content position. When >= 5
  // columns of whitespace follow the marker, the content indent is
  // marker width + 1 and the first-line content is prefixed with
  // (contentCol - contentIndent) spaces.
  const contentStart = (line, idx, m) => {
    const ind = scanIndent(line, idx);
    const baseCol = colAt(line, idx);
    let absCol = baseCol + ind.col + m.markerLen;
    let i = ind.next + m.markerLen;
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 32) { absCol++; i++; }
      else if (c === 9) { absCol = (absCol + 4) & ~3; i++; }
      else break;
    }
    if (i >= line.length) return { line, idx: i };
    const extra = absCol - (baseCol + m.contentIndent);
    if (extra > 0) {
      return { line: " ".repeat(extra) + line.slice(i), idx: 0 };
    }
    return { line, idx: i };
  };

  // Start (or continue) a paragraph at lines[ln], index idx.
  // Parses leading link reference definitions; returns {para, nextLn} where
  // `para` is the new paragraph (not yet pushed) and `nextLn` is the line
  // its first content line came from, or {defsOnly, nextLn} if only defs
  // were consumed (or the next line starts a non-paragraph block).
  const startPara = (ln, idx, line) => {
    let curLn = ln;
    let curLine = line;
    let curIdx = idx;
    while (true) {
      const def = parseRefDef(curLine, curIdx, lines, curLn);
      if (!def) break;
      const key = normalizeLabel(def.label);
      if (!refs.has(key)) refs.set(key, { href: def.href, title: def.title });
      curLn += def.consumed;
      if (curLn >= lines.length) return { defsOnly: true, nextLn: curLn };
      curLine = lines[curLn];
      curIdx = 0;
      if (isBlankLine(curLine)) return { defsOnly: true, nextLn: curLn };
    }
    // after the definitions, the next line may start a non-paragraph block
    // (blockquote, heading, code, hr, html, list, table, indented code):
    // in that case no paragraph starts here
    if (curLn !== ln) {
      const ind = scanIndent(curLine, curIdx);
      let blockStart = false;
      if (ind.col <= 3 && ind.next < curLine.length && curLine.charCodeAt(ind.next) === 62) blockStart = true;
      else if (parseATX(curLine, curIdx) || parseFence(curLine, curIdx) || isHR(curLine, curIdx)) blockStart = true;
      else if (htmlBlockType(curLine, curIdx) >= 1) blockStart = true;
      else if (parseListMarker(curLine, curIdx)) blockStart = true;
      else if (ind.col >= 4) blockStart = true;
      else if (curLn + 1 < lines.length) {
        const headerCells = splitTableRow(curLine.slice(curIdx));
        const aligns = parseTableDelimiter(lines[curLn + 1]);
        if (aligns && aligns.length === headerCells.length) blockStart = true;
      }
      if (blockStart) return { defsOnly: true, nextLn: curLn };
    }
    const para = { t: "para", lines: [curLine.slice(curIdx)], hasLazy: false, lastLazyIdx: -1 };
    return { para, nextLn: curLn };
  };

  // Start the content of a list item (the first line after the marker).
  // Full block dispatch: the content may be a heading, hr, code, list,
  // table, html block, or paragraph. Returns whatever startBlock returns.
  const startItemContent = (ln, line, idx) => {
    return startBlock(ln, idx, line, false);
  };

  // Continue a paragraph with a lazy line.
  const lazyAppend = (para, text) => {
    para.lines.push(text);
    para.hasLazy = true;
    para.lastLazyIdx = para.lines.length - 1;
  };

  // Convert a startBlock/startItemContent result into the next line number.
  const handleStart = (r) => {
    if (!r) { leaf = null; return ln + 1; }
    if (r.tablePending) { leaf = r.tablePending; return ln + r.skipLines + 1; }
    if (r.defsOnly) { leaf = null; return r.nextLn; }
    if (r.leaf) { leaf = r.leaf; return r.nextLn + 1; }
    leaf = r;
    return ln + 1;
  };

  // ---- main loop ----
  let ln = 0;
  // line number of the most recent blank line (raw or content-blank)
  let lastBlankLn = -1;
  while (ln < lines.length) {
    const rawLine = lines[ln];
    if (isBlankLine(rawLine)) {
      lastBlankLn = ln;
      // blank line: close the paragraph / table
      if (leaf && leaf.t === "para") closeLeaf();
      if (leaf && leaf.t === "table") closeLeaf();
      // a blank line inside a fenced/indented code block or a type 1-5
      // HTML block is content, not a separator: it does not loosen a list
      // (unless it also closes a blockquote, in which case it does)
      let hasBq = false;
      for (let d = 1; d < stack.length; d++) {
        if (stack[d].t === "bq") { hasBq = true; break; }
      }
      const inCodeOrHtml = leaf && ((leaf.t === "code") ||
        (leaf.t === "html" && leaf.type <= 5)) && !hasBq;
      if (!inCodeOrHtml) {
        // mark looseness on the innermost item
        for (let d = stack.length - 1; d >= 1; d--) {
          if (stack[d].t === "item") { stack[d].sawBlank = true; break; }
        }
      }
      // a blank line closes all blockquotes (and everything inside them)
      let bqDepth = -1;
      for (let d = 1; d < stack.length; d++) {
        if (stack[d].t === "bq") { bqDepth = d; break; }
      }
      if (bqDepth !== -1) {
        // the leaf inside the blockquote ends (HTML loses trailing \n)
        if (leaf && leaf.t === "html" && leaf.raw.endsWith("\n")) leaf.raw = leaf.raw.slice(0, -1);
        stack.length = bqDepth;
        leaf = null;
      } else if (leaf && leaf.t === "code" && !leaf.indented) {
        // blank line inside a fenced code block is content, dedented
        const adv = advanceCols(rawLine, 0, leaf.fenceIndent);
        let text = rawLine.slice(adv.idx);
        if (adv.partial > 0) {
          const col = colAt(rawLine, adv.idx);
          const r = expandPartialTab(rawLine, adv.idx, col, adv.partial);
          text = r.line.slice(r.idx);
        }
        codeAppend(leaf, text, ln);
      } else if (leaf && leaf.t === "code" && leaf.indented) {
        // blank line inside indented code: keep its (dedented) text pending
        const adv = advanceCols(rawLine, 0, 4);
        let text = rawLine.slice(adv.idx);
        if (adv.partial > 0) {
          const col = colAt(rawLine, adv.idx);
          const r = expandPartialTab(rawLine, adv.idx, col, adv.partial);
          text = r.line.slice(r.idx);
        }
        leaf.pendingBlanks.push(text);
      } else if (leaf && leaf.t === "html" && leaf.type <= 5) {
        // a blank line inside a type 1-5 HTML block is content
        htmlAppend(leaf, rawLine, ln);
      } else if (leaf && leaf.t === "html" && leaf.type >= 6) {
        // a blank line ends type 6/7 HTML blocks (drop the trailing \n)
        if (leaf.raw.endsWith("\n")) leaf.raw = leaf.raw.slice(0, -1);
        closeLeaf();
      }
      ln++;
      continue;
    }

    const m = matchContainers(stack, rawLine);
    let line = m.line;
    let idx = m.idx;

    // sibling list item
    if (m.sibling) {
      const { depth, marker } = m.sibling;
      // close the old item (and deeper containers); the list is at depth-1
      closeTo(depth);
      const list = stack[stack.length - 1];
      const prevItem = list.items[list.items.length - 1];
      if (prevItem && (prevItem.sawBlank || lastBlankLn === ln - 1)) list.loose = true;
      const item = { t: "item", children: [], contentIndent: marker.contentIndent, sawBlank: false };
      list.items.push(item);
      stack.push(item);
      const cs = contentStart(line, idx, marker);
      line = cs.line;
      idx = cs.idx;
      if (!marker.empty) {
        ln = handleStart(startItemContent(ln, line, idx));
      } else {
        leaf = null;
        ln++;
      }
      continue;
    }

    // a line whose content (after container matching) is blank: an empty
    // content closes the paragraph/table; a whitespace-only content is
    // appended to an open paragraph, otherwise ignored (it never starts
    // a paragraph on its own)
    if (m.firstFailure === -1) {
      let blank = true;
      let empty = idx >= line.length;
      for (let k = idx; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) { blank = false; break; }
      }
      if (blank) {
        if (leaf && leaf.t === "para" && !empty) {
          // whitespace-only content continues the paragraph as a line
          lazyAppend(leaf, line.slice(idx));
          ln++;
          continue;
        }
        if (leaf && leaf.t === "para") closeLeaf();
        if (leaf && leaf.t === "table") closeLeaf();
        // a blank line inside a nested container does not loosen the item;
        // it only counts when the innermost container is the item itself
        if (stack[stack.length - 1].t === "item") {
          stack[stack.length - 1].sawBlank = true;
          lastBlankLn = ln;
        }
        if (leaf && leaf.t === "code" && !leaf.indented) {
          const adv = advanceCols(line, idx, leaf.fenceIndent);
          let text = line.slice(adv.idx);
          if (adv.partial > 0) {
            const col = colAt(line, adv.idx);
            const r = expandPartialTab(line, adv.idx, col, adv.partial);
            text = r.line.slice(r.idx);
          }
          codeAppend(leaf, text, ln);
        } else if (leaf && leaf.t === "code" && leaf.indented) {
          const adv = advanceCols(line, idx, 4);
          let text = line.slice(adv.idx);
          if (adv.partial > 0) {
            const col = colAt(line, adv.idx);
            const r = expandPartialTab(line, adv.idx, col, adv.partial);
            text = r.line.slice(r.idx);
          }
          leaf.pendingBlanks.push(text);
        } else if (leaf && leaf.t === "html" && leaf.type <= 5) {
          htmlAppend(leaf, line.slice(idx), ln);
        } else if (leaf && leaf.t === "html" && leaf.type >= 6) {
          if (leaf.raw.endsWith("\n")) leaf.raw = leaf.raw.slice(0, -1);
          closeLeaf();
        }
        ln++;
        continue;
      }
    }

    if (m.firstFailure !== -1) {
      // some containers failed to match
      const failIdx = m.failIdx;
      // a blank line from the failure cursor closes the failed containers
      // (but not a list item) and the open paragraph/table
      let failBlank = true;
      for (let k = failIdx; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) { failBlank = false; break; }
      }
      if (failBlank) {
        if (leaf && leaf.t === "para") closeLeaf();
        if (leaf && leaf.t === "table") closeLeaf();
        for (let d = stack.length - 1; d >= 1; d--) {
          if (stack[d].t === "item") { stack[d].sawBlank = true; break; }
        }
        lastBlankLn = ln;
        const failed = stack[m.firstFailure];
        if (failed.t === "item" || failed.t === "list") {
          // keep the item/list, drop anything inside it
          while (stack.length > m.firstFailure + 1) stack.pop();
        } else {
          // drop the failed container and everything inside it
          while (stack.length > m.firstFailure) stack.pop();
        }
        leaf = null;
        ln++;
        continue;
      }
      // lazy continuation?
      if (leaf && leaf.t === "para") {
        const ik = interruptKind(line, failIdx, true);
        // an ordered list marker with start != 1 at the failure cursor
        // still starts a new list (the paragraph's container has failed)
        const lm = !ik ? parseListMarker(line, failIdx) : null;
        const newList = lm && lm.ordered && !lm.empty && !isHR(line, failIdx);
        if (!ik && !newList) {
          // lazy line: the FIRST lazy line strips 4 columns if its indent
          // is >= 4; later lazy lines are verbatim, except a setext
          // underline inside a blockquote gets 4 spaces (replacing its
          // leading whitespace) when the paragraph already has a lazy line
          let text = line.slice(failIdx);
          const ind = scanIndent(line, failIdx);
          if (!leaf.hasLazy) {
            if (ind.col >= 4) {
              const adv = advanceCols(line, failIdx, 4);
              text = line.slice(adv.idx);
              if (adv.partial > 0) {
                const col = colAt(line, adv.idx);
                const r = expandPartialTab(line, adv.idx, col, adv.partial);
                text = r.line.slice(r.idx);
              }
            }
          } else if (setextLevel(line, failIdx) > 0) {
            let hasBq = false;
            for (let d = 1; d < stack.length; d++) {
              if (stack[d].t === "bq") { hasBq = true; break; }
            }
            if (hasBq) text = "    " + line.slice(ind.next);
          }
          lazyAppend(leaf, text);
          ln++;
          continue;
        }
      }
      // close the failed containers and dispatch a new block at the fail cursor
      closeFailed(m.firstFailure);
      ln = handleStart(startBlock(ln, failIdx, line, false));
      continue;
    }

    // all containers matched; idx is the content cursor
    if (leaf) {
      if (leaf.t === "code" && !leaf.indented) {
        // fenced code: check for the closing fence
        const ind = scanIndent(line, idx);
        if (ind.col <= 3 && ind.next < line.length &&
            line.charCodeAt(ind.next) === leaf.fence) {
          let j = ind.next;
          let len = 0;
          while (j < line.length && line.charCodeAt(j) === leaf.fence) { len++; j++; }
          let onlySpaces = true;
          while (j < line.length) {
            const c = line.charCodeAt(j);
            if (c !== 32 && c !== 9) { onlySpaces = false; break; }
            j++;
          }
          if (len >= leaf.fenceLen && onlySpaces) {
            closeLeaf();
            ln++;
            continue;
          }
        }
        // content line: dedent by the fence indent
        const adv = advanceCols(line, idx, leaf.fenceIndent);
        let text = line.slice(adv.idx);
        if (adv.partial > 0) {
          const col = colAt(line, adv.idx);
          const r = expandPartialTab(line, adv.idx, col, adv.partial);
          text = r.line.slice(r.idx);
        }
        codeAppend(leaf, text, ln);
        ln++;
        continue;
      }
      if (leaf.t === "code" && leaf.indented) {
        const ind = scanIndent(line, idx);
        if (ind.col >= 4) {
          const adv = advanceCols(line, idx, 4);
          let text = line.slice(adv.idx);
          if (adv.partial > 0) {
            const col = colAt(line, adv.idx);
            const r = expandPartialTab(line, adv.idx, col, adv.partial);
            text = r.line.slice(r.idx);
          }
          while (leaf.pendingBlanks.length > 0) { leaf.content += leaf.pendingBlanks.shift() + "\n"; }
          codeAppend(leaf, text, ln);
          ln++;
          continue;
        }
        // not indented enough: close the code block and re-dispatch
        leaf.pendingBlanks = [];
        closeLeaf();
        // fall through to the new-block dispatch below
      } else if (leaf.t === "html") {
        if (leaf.type >= 1 && leaf.type <= 5 && htmlBlockEnds(leaf.type, line.slice(idx))) {
          htmlAppend(leaf, line.slice(idx), ln);
          // a following blank line drops the trailing \n
          if (ln + 1 < lines.length && isBlankLine(lines[ln + 1]) && leaf.raw.endsWith("\n")) {
            leaf.raw = leaf.raw.slice(0, -1);
          }
          closeLeaf();
          ln++;
          continue;
        }
        if (leaf.type >= 1 && leaf.type <= 5) {
          htmlAppend(leaf, line.slice(idx), ln);
          ln++;
          continue;
        }
        // type 6/7: a non-blank line continues; a blank line ends it
        htmlAppend(leaf, line.slice(idx), ln);
        ln++;
        continue;
      } else if (leaf.t === "table") {
        // a block start ends the table
        if (interruptKind(line, idx, true) || parseATX(line, idx)) {
          closeLeaf();
          // fall through to the new-block dispatch below
        } else {
          const cells = splitTableRow(line.slice(idx));
          // pad / trim to the header count
          while (cells.length < leaf.header.length) cells.push("");
          leaf.rows.push(cells.slice(0, leaf.header.length));
          ln++;
          continue;
        }
      } else if (leaf.t === "para") {
        // setext underline?
        const sl = setextLevel(line, idx);
        if (sl > 0) {
          const ch = children();
          // inside a blockquote, a setext underline after lazy lines
          // splits the paragraph: the heading starts at the LAST lazy
          // line, the earlier lines stay a paragraph
          let hasBq = false;
          for (let d = 1; d < stack.length; d++) {
            if (stack[d].t === "bq") { hasBq = true; break; }
          }
          const lastLazy = leaf.lastLazyIdx;
          if (hasBq && lastLazy >= 1) {
            const headText = leaf.lines.slice(lastLazy).join("\n").trim();
            const h = { t: "h", level: sl, text: headText };
            ch[ch.length - 1] = { t: "para", lines: leaf.lines.slice(0, lastLazy), hasLazy: leaf.hasLazy, lastLazyIdx: leaf.lastLazyIdx };
            ch.push(h);
          } else {
            const text = leaf.lines.join("\n").trim();
            const h = { t: "h", level: sl, text };
            ch[ch.length - 1] = h;
          }
          closeLeaf();
          ln++;
          continue;
        }
        // table split: this line + the next line form a table header/delimiter
        if (ln + 1 < lines.length) {
          const headerCells = splitTableRow(line.slice(idx));
          const aligns = parseTableDelimiter(lines[ln + 1]);
          if (aligns && aligns.length === headerCells.length) {
            // the paragraph's lines before this one become a paragraph
            const prevLines = leaf.lines;
            const ch = children();
            if (prevLines.length > 0) {
              ch[ch.length - 1] = { t: "para", lines: prevLines };
            } else {
              ch.pop();
            }
            const block = { t: "table", header: headerCells, aligns, rows: [] };
            ch.push(block);
            leaf = block;
            ln += 2;
            continue;
          }
        }
        // interrupting block?
        if (interruptKind(line, idx, true)) {
          closeLeaf();
          // fall through to the new-block dispatch below
        } else {
          leaf.lines.push(line.slice(idx));
          ln++;
          continue;
        }
      }
    }

    // no open leaf, or the leaf was just closed: dispatch a new block
    ln = handleStart(startBlock(ln, idx, line, leaf !== null && leaf.t === "para"));
  }
  return doc.children;
}

export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, "\n");
  const parts = src.split("\n");
  let lastNL = false;
  if (parts.length > 0 && parts[parts.length - 1] === "" && src.endsWith("\n")) {
    parts.pop();
    lastNL = true;
  }
  const refs = new Map();
  const blocks = parseBlocks(parts, lastNL, refs);
  return renderBlocks(blocks, refs);
}
