// Fast drop-in for marked 18.1.3 (default options: gfm on, breaks off).
// Written from scratch against the CommonMark 0.31.2 + GFM 0.29 specs,
// verified byte-for-byte against marked's own output on the practice set.
// Single-pass, direct-to-HTML, no token tree, minimal allocation.

// ASCII punctuation, per CommonMark.
function isPunct(cc) {
  return (cc >= 33 && cc <= 47) || (cc >= 58 && cc <= 64) || (cc >= 91 && cc <= 96) || (cc >= 123 && cc <= 126);
}
function isSpace(cc) { return cc === 32 || cc === 9 || cc === 10 || cc === 11 || cc === 12 || cc === 13; }
function isDigit(cc) { return cc >= 48 && cc <= 57; }
function isAlpha(cc) { return (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122); }
function isAlnum(cc) { return isAlpha(cc) || isDigit(cc); }
const PUNCT_RE = /[\p{P}\p{S}]/u;
// Unicode-aware punctuation test (fast path for ASCII).
function isPunctU(ch) { const c = ch.charCodeAt(0); return c < 128 ? isPunct(c) : PUNCT_RE.test(ch); }
const SPACE_RE = /\s/;
function isSpaceU(ch) { const c = ch.charCodeAt(0); return c < 128 ? isSpace(c) : SPACE_RE.test(ch); }

// Decode one NUMERIC entity starting at s[i] === '&'. Named entities are
// NOT decoded by marked (they pass through literally); only &#123; / &#x1F600;
// (1-7 decimal digits, 1-6 hex digits) decode. Returns [decoded, next] or null.
function decodeEntity(s, i, n) {
  if (s.charCodeAt(i + 1) !== 35) return null;
  let j = i + 2, hex = false;
  if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) { hex = true; j++; }
  const start = j, maxDigits = hex ? 6 : 7;
  let v = 0, count = 0;
  while (j < n && count < maxDigits) {
    const c = s.charCodeAt(j);
    if (hex ? (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70)
            : (c >= 48 && c <= 57)) {
      v = v * (hex ? 16 : 10) + (c <= 57 ? c - 48 : (c & 15) + 9);
      j++; count++;
    } else break;
  }
  if (count === 0 || j >= n || s.charCodeAt(j) !== 59) return null;
  if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return ['\uFFFD', j + 1];
  return [String.fromCodePoint(v), j + 1];
}

// Does s[i] === '&' start an entity-like reference (&name; / &#123; / &#x1F;)?
// Used to preserve such '&' when escaping text/attributes (marked's escape).
function isEntityRef(s, i, n) {
  let j = i + 1;
  if (s.charCodeAt(j) === 35) {
    j++;
    if (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88) {
      j++;
      let c = 0;
      while (j < n && c < 6) { const d = s.charCodeAt(j); if ((d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)) { j++; c++; } else break; }
      return c > 0 && j < n && s.charCodeAt(j) === 59;
    }
    let c = 0;
    while (j < n && c < 7) { const d = s.charCodeAt(j); if (d >= 48 && d <= 57) { j++; c++; } else break; }
    return c > 0 && j < n && s.charCodeAt(j) === 59;
  }
  let c = 0;
  while (j < n) { const d = s.charCodeAt(j); if (isAlnum(d) || d === 95) { j++; c++; } else break; }
  return c > 0 && j < n && s.charCodeAt(j) === 59;
}

// Escape &, <, >, ", ' in TEXT and attribute values: '&' is left alone when
// it starts an entity-like reference (marked preserves &copy; &amp; etc.).
function escInto(out, s, a, b) {
  let k = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { if (isEntityRef(s, i, b)) continue; if (k < i) out.push(s.slice(k, i)); out.push('&amp;'); k = i + 1; }
    else if (c === 60) { if (k < i) out.push(s.slice(k, i)); out.push('&lt;'); k = i + 1; }
    else if (c === 62) { if (k < i) out.push(s.slice(k, i)); out.push('&gt;'); k = i + 1; }
    else if (c === 34) { if (k < i) out.push(s.slice(k, i)); out.push('&quot;'); k = i + 1; }
    else if (c === 39) { if (k < i) out.push(s.slice(k, i)); out.push('&#39;'); k = i + 1; }
  }
  if (k < b) out.push(s.slice(k, b));
}
// Code spans/fenced code escape EVERY '&' (no entity preservation).
function escCodeInto(out, s, a, b) {
  let k = a;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) { if (k < i) out.push(s.slice(k, i)); out.push('&amp;'); k = i + 1; }
    else if (c === 60) { if (k < i) out.push(s.slice(k, i)); out.push('&lt;'); k = i + 1; }
    else if (c === 62) { if (k < i) out.push(s.slice(k, i)); out.push('&gt;'); k = i + 1; }
    else if (c === 34) { if (k < i) out.push(s.slice(k, i)); out.push('&quot;'); k = i + 1; }
    else if (c === 39) { if (k < i) out.push(s.slice(k, i)); out.push('&#39;'); k = i + 1; }
  }
  if (k < b) out.push(s.slice(k, b));
}
const escAttrInto = escInto;

// ---- URL encoding: percent-encode every char that is not unreserved,
// reserved, or '%' (RFC 3986), UTF-8 for non-ASCII. ----
const URI_KEEP = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~:/?#@!$&'()*+,;=%") URI_KEEP[ch.charCodeAt(0)] = 1;
const HEXD = '0123456789ABCDEF';
function pctByte(out, b) { out.push('%', HEXD[b >> 4], HEXD[b & 15]); }
function cleanUrl(d) {
  let out = null, k = 0;
  for (let i = 0; i < d.length; i++) {
    const c = d.charCodeAt(i);
    if (c < 128 && URI_KEEP[c]) continue;
    if (out === null) out = [];
    if (k < i) out.push(d.slice(k, i));
    if (c < 128) { pctByte(out, c); k = i + 1; continue; }
    const cp = d.codePointAt(i);
    if (cp > 0xFFFF) i++;
    if (cp < 0x800) { pctByte(out, 0xC0 | (cp >> 6)); pctByte(out, 0x80 | (cp & 63)); }
    else if (cp < 0x10000) { pctByte(out, 0xE0 | (cp >> 12)); pctByte(out, 0x80 | ((cp >> 6) & 63)); pctByte(out, 0x80 | (cp & 63)); }
    else { pctByte(out, 0xF0 | (cp >> 18)); pctByte(out, 0x80 | ((cp >> 12) & 63)); pctByte(out, 0x80 | ((cp >> 6) & 63)); pctByte(out, 0x80 | (cp & 63)); }
    k = i + 1;
  }
  if (out === null) return d;
  if (k < d.length) out.push(d.slice(k));
  return out.join('');
}

// ---- Inline HTML tag starting at s[i] === '<'. Returns end index (after '>') or -1. ----
function parseHtmlTag(s, i, n) {
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 33) { // ! -- comment, declaration, CDATA
    if (s.charCodeAt(i + 2) === 45 && s.charCodeAt(i + 3) === 45) {
      // <!--> and <!---> are complete (empty) comments
      if (s.charCodeAt(i + 4) === 62) return i + 5;
      if (s.charCodeAt(i + 4) === 45 && s.charCodeAt(i + 5) === 62) return i + 6;
      const e = s.indexOf('-->', i + 4);
      return e === -1 ? -1 : e + 3;
    }
    if (s.startsWith('[CDATA[', i + 2)) {
      const e = s.indexOf(']]>', i + 9);
      return e === -1 ? -1 : e + 3;
    }
    if (i + 2 < n && isAlpha(s.charCodeAt(i + 2))) { // <!A...>
      const e = s.indexOf('>', i + 2);
      return e === -1 ? -1 : e + 1;
    }
    return -1;
  }
  if (c1 === 63) { // <? ... ?>
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  let j = i + 1;
  let closing = false;
  if (s.charCodeAt(j) === 47) { closing = true; j++; } // </
  if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  while (j < n) { const c = s.charCodeAt(j); if (isAlnum(c) || c === 45) j++; else break; }
  // after the tag name: only whitespace, '/', '>' (or end) are valid
  if (j < n) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 47 && c !== 62) return -1;
  }
  if (closing) {
    // a closing tag has no attributes: only optional whitespace, then '>'
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
    if (j < n && s.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  // attributes: each must be preceded by whitespace
  for (;;) {
    let ws = 0;
    while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) { j++; ws++; }
    if (j >= n) return -1;
    const c = s.charCodeAt(j);
    if (c === 62) return j + 1; // >
    if (c === 47) { // />
      if (s.charCodeAt(j + 1) === 62) return j + 2;
      return -1;
    }
    if (ws === 0) return -1; // an attribute name needs preceding whitespace
    // attribute name: [A-Za-z_:][A-Za-z0-9_.:-]*
    if (!(isAlpha(c) || c === 95 || c === 58)) return -1;
    j++;
    while (j < n) { const d = s.charCodeAt(j); if (isAlnum(d) || d === 95 || d === 58 || d === 46 || d === 45) j++; else break; }
    // optional =value: peek past whitespace; only consume it when '=' follows
    // (a boolean attribute leaves the whitespace for the next attribute's count)
    let k = j;
    while (k < n && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9 || s.charCodeAt(k) === 10)) k++;
    if (k < n && s.charCodeAt(k) === 61) { // =
      j = k + 1;
      while (j < n && (s.charCodeAt(j) === 32 || s.charCodeAt(j) === 9 || s.charCodeAt(j) === 10)) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) { // quoted value
        const e = s.indexOf(String.fromCharCode(q), j + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else { // unquoted: no space " ' = < > `
        if (q === 32 || q === 9 || q === 10 || q === 34 || q === 39 || q === 61 || q === 60 || q === 62 || q === 96) return -1;
        while (j < n) { const d = s.charCodeAt(j); if (d === 32 || d === 9 || d === 10 || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break; j++; }
        if (j === n) return -1;
      }
    }
  }
}

// ---- Autolink <...> starting at s[i] === '<'. Returns [end, href, text] or null. ----
function isEmailLocal(c) { // [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]
  return isAlnum(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}
function parseAutolink(s, i, n) {
  let j = i + 1;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  if (isAlpha(s.charCodeAt(j))) {
    let k = j + 1;
    while (k < n && k - j <= 32) { const c = s.charCodeAt(k); if (isAlnum(c) || c === 43 || c === 46 || c === 45) k++; else break; }
    if (k - j >= 2 && k - j <= 32 && s.charCodeAt(k) === 58) {
      let e = k + 1;
      while (e < n) { const c = s.charCodeAt(e); if (c === 32 || c === 9 || c === 10 || c === 60 || c === 62 || c < 32) break; e++; }
      if (e > k + 1 && e < n && s.charCodeAt(e) === 62) {
        const raw = s.slice(i + 1, e);
        return [e + 1, raw, raw];
      }
    }
  }
  // email: local@domain with a dot
  let k = j;
  while (k < n && isEmailLocal(s.charCodeAt(k))) k++;
  if (k > j && k < n && s.charCodeAt(k) === 64) {
    let d = k + 1, dots = 0, ok = true, label = 0;
    while (d < n) {
      const c = s.charCodeAt(d);
      if (isAlnum(c) || c === 45) { label++; d++; continue; }
      if (c === 46) { if (label === 0) { ok = false; break; } dots++; label = 0; d++; continue; }
      break;
    }
    if (ok && dots > 0 && label > 0 && d < n && s.charCodeAt(d) === 62) {
      const raw = s.slice(i + 1, d);
      return [d + 1, 'mailto:' + raw, raw];
    }
  }
  return null;
}

// ---- Find a code span starting at s[i] === '`'. Returns [end, a, b] (content slice) or null. ----
function findCodeSpan(s, i, n) {
  let k = i;
  while (k < n && s.charCodeAt(k) === 96) k++;
  const run = k - i;
  let j = k;
  for (;;) {
    const e = s.indexOf('`', j);
    if (e === -1) return null;
    let m = e;
    while (m < n && s.charCodeAt(m) === 96) m++;
    if (m - e === run) return [m, k, e];
    j = m;
  }
}
// Render code span content [a,b) of s into out (newline->space, strip one edge space, escape 5).
function codeSpanInto(out, s, a, b) {
  let hasNl = false, allSp = true;
  for (let i = a; i < b; i++) { const c = s.charCodeAt(i); if (c === 10) hasNl = true; if (c !== 32 && c !== 10) allSp = false; }
  if (!hasNl) {
    let x = a, y = b;
    if (!allSp && b - a >= 2 && s.charCodeAt(a) === 32 && s.charCodeAt(b - 1) === 32) { x = a + 1; y = b - 1; }
    escCodeInto(out, s, x, y);
    return;
  }
  // newlines become spaces first; the edge-space strip applies to the result
  let buf = '';
  for (let i = a; i < b; i++) { const c = s.charCodeAt(i); buf += c === 10 ? ' ' : s[i]; }
  let x = 0, y = buf.length;
  if (!allSp && y >= 2 && buf.charCodeAt(0) === 32 && buf.charCodeAt(y - 1) === 32) { x = 1; y = y - 1; }
  escCodeInto(out, buf, x, y);
}

// ---- Whitespace skip (space/tab/newline) ----
function skipWs(s, i, n) {
  while (i < n) { const c = s.charCodeAt(i); if (c === 32 || c === 9 || c === 10) i++; else break; }
  return i;
}
// Decode backslash escapes in a raw slice [a,b): \punct -> punct (others keep the backslash).
function unescapeStr(s, a, b) {
  let out = null, k = a;
  for (let i = a; i < b; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < b && isPunct(s.charCodeAt(i + 1))) {
      if (out === null) out = [s.slice(k, i)];
      out.push(s[i + 1]);
      i++; k = i + 1;
    }
  }
  return out === null ? s.slice(a, b) : out.join('') + s.slice(k, b);
}
// Parse a link destination at s[i]. Returns [decodedDest, next] or null.
function parseDest(s, i, n) {
  if (s.charCodeAt(i) === 60) { // <...>
    let j = i + 1, buf = null, k = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) {
        const raw = buf === null ? s.slice(k, j) : buf.join('') + s.slice(k, j);
        return [raw, j + 1];
      }
      if (c === 60 || c === 10) return null;
      if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) {
        if (buf === null) buf = [];
        buf.push(s.slice(k, j), s[j + 1]);
        j += 2; k = j; continue;
      }
      j++;
    }
    return null;
  }
  let j = i, depth = 0, buf = null, k = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c < 32) break;
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) { if (depth === 0) break; depth--; j++; continue; }
    if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) {
      if (buf === null) buf = [];
      buf.push(s.slice(k, j), s[j + 1]);
      j += 2; k = j; continue;
    }
    j++;
  }
  if (j === i) return null;
  const raw = buf === null ? s.slice(k, j) : buf.join('') + s.slice(k, j);
  return [raw, j];
}
// Parse a link title at s[i] (", ', or (). Returns [decodedTitle, next] or null.
function parseTitle(s, i, n) {
  const q = s.charCodeAt(i);
  if (q === 34 || q === 39) {
    let j = i + 1, buf = null, k = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === q) {
        const raw = buf === null ? s.slice(k, j) : buf.join('') + s.slice(k, j);
        return [raw, j + 1];
      }
      if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) {
        if (buf === null) buf = [];
        buf.push(s.slice(k, j), s[j + 1]);
        j += 2; k = j; continue;
      }
      j++;
    }
    return null;
  }
  if (q === 40) {
    let j = i + 1, buf = null, k = i + 1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 41) {
        const raw = buf === null ? s.slice(k, j) : buf.join('') + s.slice(k, j);
        return [raw, j + 1];
      }
      if (c === 40) return null;
      if (c === 92 && j + 1 < n && isPunct(s.charCodeAt(j + 1))) {
        if (buf === null) buf = [];
        buf.push(s.slice(k, j), s[j + 1]);
        j += 2; k = j; continue;
      }
      j++;
    }
    return null;
  }
  return null;
}
// Parse the suffix after a ']' (at s[i]) for a link/image.
// Returns {dest, title, end} or null. linkText is the raw text slice (for ref lookup).
function parseLinkSuffix(s, i, n, refs, linkText) {
  let j = i; // ( or [ must immediately follow ]
  if (j < n && s.charCodeAt(j) === 40) { // ( ... ) inline link
    j++;
    j = skipWs(s, j, n);
    let dest = '', title = null, ok = false;
    if (j < n && s.charCodeAt(j) === 41) { j++; return { dest: '', title: null, end: j }; }
    const d = parseDest(s, j, n);
    if (d !== null) {
      dest = d[0]; j = d[1];
      const destEnd = j;
      j = skipWs(s, j, n);
      if (j > destEnd && j < n && s.charCodeAt(j) !== 41) {
        const t = parseTitle(s, j, n);
        if (t !== null) { title = t[0]; j = t[1]; j = skipWs(s, j, n); }
        else j = -1;
      }
      if (j !== -1 && j < n && s.charCodeAt(j) === 41) ok = true;
    }
    if (ok) return { dest, title, end: j + 1 };
    // inline parse failed: fall through to the shortcut ref (cm-568)
  } else if (j < n && s.charCodeAt(j) === 91) { // [label] full or collapsed ref
    let k = j + 1, labelEnd = -1, bad = false;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 92 && k + 1 < n) { k += 2; continue; }
      if (c === 91) { bad = true; break; } // unescaped '[' is not allowed in a label
      if (c === 93) { labelEnd = k; break; }
      k++;
    }
    if (!bad && labelEnd !== -1) {
      const label = labelEnd === j + 1 ? linkText : s.slice(j + 1, labelEnd);
      const ref = refs.get(normLabel(label));
      if (ref) return { dest: ref.dest, title: ref.title, end: labelEnd + 1 };
      // well-formed [label] but no such ref: NOT a shortcut (cm-571)
      return null;
    }
    // malformed label: fall through to the shortcut ref
  }
  // shortcut ref
  const ref = refs.get(normLabel(linkText));
  if (!ref) return null;
  return { dest: ref.dest, title: ref.title, end: i };
}
// Normalize a link label: collapse whitespace, trim, lowercase.
function normLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/\u00df/g, 'ss');
}
// Scan image text after '![', starting at i. Returns index of the closing ']' or -1.
// Brackets must balance: a nested '[' opens a level closed by its ']'.
function scanImageText(s, i, n) {
  let j = i, depth = 0;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; } // escaped char
    if (c === 91) { depth++; j++; continue; } // [
    if (c === 93) { // ]
      if (depth === 0) return j;
      depth--; j++; continue;
    }
    j++;
  }
  return -1;
}

// ---- Extended autolinks (GFM) ----
// Email local chars for extended autolinks: [A-Za-z0-9._+-]
function isExtLocal(c) { return isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45; }
function isWordChar(c) { return isAlnum(c) || c === 95; }
// Try to match an extended email at s[i] (i at local-part start). Returns [end] or null.
// With wantPending, an email followed by '_' returns [end, usPos] instead of
// null: the '_' may be a closing emphasis delimiter (the email is lexed
// inside the emphasis in marked, so the '_' is already consumed there).
// The caller resolves such a pending email after emphasis resolution.
function matchExtEmail(s, i, n, wantPending) {
  let j = i;
  while (j < n && isExtLocal(s.charCodeAt(j))) j++;
  if (j === i || j >= n || s.charCodeAt(j) !== 64) return null;
  let d = j + 1, dots = 0, label = 0;
  while (d < n) {
    const c = s.charCodeAt(d);
    if (isAlnum(c) || c === 45) { label++; d++; continue; }
    if (c === 46) { if (label === 0) break; dots++; label = 0; d++; continue; }
    break;
  }
  // the domain must not end with a hyphen
  if (d > j + 1 && s.charCodeAt(d - 1) === 45) return null;
  // a trailing dot is trimmed from the domain (a.b. -> a.b)
  while (d > j + 1 && s.charCodeAt(d - 1) === 46) { d--; dots--; }
  if (dots === 0) return null;
  // trailing boundary: next char must not be a word char or '-'
  if (d < n) { const c = s.charCodeAt(d); if (c === 95 && wantPending) return [d, d]; if (isWordChar(c) || c === 45) return null; }
  return [d];
}
// Punctuation in marked's _backpedal: ? ! . , : ; * _ ' " ~ )
function isBackpedalPunct(c) {
  return c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 || c === 42 || c === 95 || c === 39 || c === 34 || c === 126 || c === 41;
}
// Marked's _backpedal, as a scanner: the longest prefix of [a,b) that
// decomposes into ordinary chars (not ?!.,:;*_'\"~()&), balanced (...) groups,
// an & that does not start an &name; entity ending at b, or trailing
// punctuation that is NOT at the end. A ')' is kept when it closes a
// balanced group (e.g. ...%5D(...)) or is followed by more URL text.
function backpedalEnd(s, a, b) {
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 40) { // '(' — balanced group \([^)]*\)
      let j = i + 1;
      while (j < b && s.charCodeAt(j) !== 41) j++;
      if (j < b) { i = j + 1; continue; }
      break; // unmatched '(' stops the match
    }
    if (c === 38) { // '&' — excluded if it starts an &name; entity ending at b
      let j = i + 1;
      while (j < b && isAlnum(s.charCodeAt(j))) j++;
      if (j > i + 1 && j < b && s.charCodeAt(j) === 59 && j + 1 === b) break;
      i++;
      continue;
    }
    if (isBackpedalPunct(c)) {
      let j = i;
      while (j < b && isBackpedalPunct(s.charCodeAt(j))) j++;
      if (j < b) { i = j; continue; } // followed by more: keep the run
      break; // run is at the end: exclude it
    }
    i++; // ordinary char
  }
  return i;
}
// Trim an extended URL match [a,b): apply the backpedal repeatedly until stable.
function trimExtUrl(s, a, b) {
  let prev = -1;
  while (prev !== b) { prev = b; b = backpedalEnd(s, a, b); }
  return b;
}
// Try to match an extended autolink at s[i]. Returns [end, href, textStart, textEnd] or null.
// i must be at the start of www. / scheme / mailto: / email local part.
function matchExtAutolink(s, i, n, stopBracket) {
  const c = s.charCodeAt(i);
  // www. (lowercase only: Www. / WWW. do not link)
  if (c === 119 && s.slice(i, i + 4) === 'www.') {
    if (i > 0) { const p = s.charCodeAt(i - 1); if (isWordChar(p) || p === 47) return null; }
    let j = i;
    while (j < n) { const d = s.charCodeAt(j); if (d === 32 || d === 9 || d === 10 || d === 60 || (stopBracket && d === 93)) break; j++; }
    const e = trimExtUrl(s, i, j);
    if (e <= i + 4) return null;
    return [e, 'http://' + s.slice(i, e), i, e];
  }
  // scheme:// (http, https, ftp, case-insensitive)
  const rest = s.slice(i, i + 8).toLowerCase();
  let schemeLen = 0;
  if (rest.startsWith('http://')) schemeLen = 7;
  else if (rest.startsWith('https://')) schemeLen = 8;
  else if (rest.startsWith('ftp://')) schemeLen = 6;
  if (schemeLen > 0) {
    let j = i;
    while (j < n) { const d = s.charCodeAt(j); if (d === 32 || d === 9 || d === 10 || d === 60 || (stopBracket && d === 93)) break; j++; }
    const e = trimExtUrl(s, i, j);
    if (e <= i + schemeLen) return null;
    return [e, s.slice(i, e), i, e];
  }
  // mailto: / xmpp: + email + optional /resource  (marked: (?:mailto|xmpp):email(?:\/[A-Za-z0-9@.]+)?)
  // the scheme is lowercase only: MAILTO: / XMPP: do not link as a whole
  const restL = s.slice(i, i + 7);
  if (restL.startsWith('mailto:') || restL.startsWith('xmpp:')) {
    const sl = restL.startsWith('mailto:') ? 7 : 5;
    if (i > 0) { const p = s.charCodeAt(i - 1); if (isWordChar(p) || p === 47) return null; }
    const em = matchExtEmail(s, i + sl, n);
    if (em === null) return null;
    let e = em[0];
    // optional /resource segment: '/' + [A-Za-z0-9@.]+
    if (e < n && s.charCodeAt(e) === 47 && e + 1 < n) {
      const r0 = s.charCodeAt(e + 1);
      if (isAlnum(r0) || r0 === 64 || r0 === 46) {
        let r = e + 1;
        while (r < n) { const c = s.charCodeAt(r); if (isAlnum(c) || c === 64 || c === 46) r++; else break; }
        e = r;
      }
    }
    e = trimExtUrl(s, i, e);
    if (e <= i + sl) return null;
    return [e, s.slice(i, e), i, e];
  }
  // email
  if (isExtLocal(c)) {
    if (i > 0 && isExtLocal(s.charCodeAt(i - 1))) return null;
    const em = matchExtEmail(s, i, n);
    if (em === null) return null;
    return [em[0], 'mailto:' + s.slice(i, em[0]), i, em[0]];
  }
  return null;
}

// ---- Flanking helpers ----
function charBefore(s, i) {
  if (i <= 0) return '';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xDC00 && c <= 0xDFFF && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xD800 && h <= 0xDBFF) return s.slice(i - 2, i);
  }
  return s[i - 1];
}
function charAfter(s, i) {
  if (i >= s.length) return '';
  const c = s.charCodeAt(i);
  if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
    const l = s.charCodeAt(i + 1);
    if (l >= 0xDC00 && l <= 0xDFFF) return s.slice(i, i + 2);
  }
  return s[i];
}
function flank(s, i, len) {
  const b = charBefore(s, i), a = charAfter(s, i + len);
  // a string boundary counts as whitespace (not punctuation)
  const bSp = b === '' ? true : isSpaceU(b), bPu = b === '' ? false : isPunctU(b);
  const aSp = a === '' ? true : isSpaceU(a), aPu = a === '' ? false : isPunctU(a);
  const left = !aSp && (!aPu || bSp || bPu);
  const right = !bSp && (!bPu || aSp || aPu);
  return [left, right, bPu, aPu];
}
// Node kinds: 0 text [0,a,b], 1 literal [1,str],
// 2 delim [2,ch,len,canOpen,canClose,openTags,closeTags], 3 bracket [3,srcPos,bang,active]
// Returns true if a link (not an image) was formed in this call.
// Document-level lexer state (marked): once an <a ...> start tag is seen in
// inline text, extended autolinks (www / scheme / bare email) are suppressed
// until a matching </a>. Persists across paragraphs for the whole document.
// Reset at the start of each parse() pass. Plain-text (alt) rendering must
// not disturb it (marked renders alt with the text renderer, no lexing).
let INLINK = false;

function inlineTo(s, refs, out, noExt) {
  const n = s.length;
  const toks = [];
  const openers = [];
  let formedLink = false;
  let i = 0, textStart = 0, pendingBang = false;
  // Pre-scan for extended emails: their local part can contain '_' which the
  // main loop would otherwise tokenize as an emphasis delimiter first.
  // (An email inside a code span / link is skipped by the main loop's jumps.)
  // noExt (link text): extended autolinks are not recognized inside link text.
  const emails = [];
  const pends = []; // [start, end, usPos]: email followed by '_' (pending emphasis decision)
  if (!noExt) {
  for (let p = 0; p < n; p++) {
    if (s.charCodeAt(p) === 64) { // @
      let k = p - 1;
      while (k >= 0 && isExtLocal(s.charCodeAt(k))) k--;
      const st = k + 1;
      if (st < p) {
        const em = matchExtEmail(s, st, n, true);
        if (em !== null) {
          if (em.length === 2) pends.push([st, em[0], em[1]]);
          else emails.push([st, em[0]]);
          p = em[0] - 1;
        }
      }
    }
  }
  }
  let emailIdx = 0;
  let pendIdx = 0;
  const pendToks = []; // pending-email tokens [4, start, end, usPos, delimTokIdx]
  const pendByPos = new Map(); // usPos -> pending token
  const flush = (end) => { if (end > textStart) toks.push([0, textStart, end]); };
  // true while inside an active '[' ... (a ']' there closes the link text,
  // so an extended URL must stop before it)
  const inBrackets = () => openers.length > 0 && toks[openers[openers.length - 1]][3];
  while (i < n) {
    while (emailIdx < emails.length && emails[emailIdx][0] < i) emailIdx++;
    if (emailIdx < emails.length && emails[emailIdx][0] === i && !INLINK) {
      const en = emails[emailIdx][1]; emailIdx++;
      flush(i);
      const raw = s.slice(i, en);
      const href = 'mailto:' + raw;
      const t1 = []; escAttrInto(t1, href, 0, href.length);
      const t2 = []; escInto(t2, raw, 0, raw.length);
      toks.push([1, '<a href="' + t1.join('') + '">' + t2.join('') + '</a>']);
      i = en; textStart = i; continue;
    }
    while (pendIdx < pends.length && pends[pendIdx][0] < i) pendIdx++;
    if (pendIdx < pends.length && pends[pendIdx][0] === i && !INLINK) {
      const pd = pends[pendIdx]; pendIdx++;
      flush(i);
      const pt = [4, pd[0], pd[1], pd[2], -1];
      toks.push(pt);
      pendToks.push(pt);
      pendByPos.set(pd[2], pt);
      i = pd[1]; textStart = i; continue;
    }
    const c = s.charCodeAt(i);
    if (c === 92) { // backslash
      const d = s.charCodeAt(i + 1);
      if (d === 10) {
        if (i + 2 < n) {
          flush(i); toks.push([1, '<br>']); i += 2; textStart = i;
          // a hard break strips all leading whitespace of the next line
          while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
          textStart = i; continue;
        }
        i++; continue;
      }
      if (d !== undefined && isPunct(d)) {
        flush(i);
        const ch = s[i + 1];
        toks.push([1, ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch]);
        i += 2; textStart = i; continue;
      }
      i++; continue;
    }
    if (c === 96) { // backtick
      const cs = findCodeSpan(s, i, n);
      if (cs !== null) {
        flush(i);
        const tmp = [];
        codeSpanInto(tmp, s, cs[1], cs[2]);
        toks.push([1, '<code>' + tmp.join('') + '</code>']);
        i = cs[0]; textStart = i; continue;
      }
      while (i < n && s.charCodeAt(i) === 96) i++;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) { // * _ ~
      let j = i;
      while (j < n && s.charCodeAt(j) === c) j++;
      const len = j - i;
      if (c === 126 && len > 2) { i = j; continue; }
      const fl = flank(s, i, len);
      let canOpen, canClose;
      if (c === 95) { canOpen = fl[0] && (!fl[1] || fl[2]); canClose = fl[1] && (!fl[0] || fl[3]); }
      else { canOpen = fl[0]; canClose = fl[1]; }
      flush(i);
      const pt = pendByPos.get(i);
      if (pt !== undefined) pt[4] = toks.length;
      toks.push([2, c, len, canOpen, canClose, null, null]);
      i = j; textStart = i; continue;
    }
    if (c === 33 && s.charCodeAt(i + 1) === 91) { // ![
      const te = scanImageText(s, i + 2, n);
      if (te !== -1) {
        const suf = parseLinkSuffix(s, te + 1, n, refs, s.slice(i + 2, te));
        if (suf !== null) {
          flush(i);
          const alt = plainText(s.slice(i + 2, te), refs);
          const href = cleanUrl(suf.dest);
          const t1 = []; escAttrInto(t1, href, 0, href.length);
          const t2 = []; escAttrInto(t2, alt, 0, alt.length);
          let img = '<img src="' + t1.join('') + '" alt="' + t2.join('') + '"';
          if (suf.title !== null) { const t3 = []; escAttrInto(t3, suf.title, 0, suf.title.length); img += ' title="' + t3.join('') + '"'; }
          toks.push([1, img + '>']);
          i = suf.end; textStart = i; continue;
        }
      }
      flush(i);
      pendingBang = true;
      i++; textStart = i;
      continue;
    }
    if (c === 91) { // [
      flush(i);
      toks.push([3, i, pendingBang, true]);
      openers.push(toks.length - 1);
      pendingBang = false;
      i++; textStart = i; continue;
    }
    if (c === 93) { // ]
      if (openers.length === 0) { i++; continue; }
      const oi = openers.pop();
      const br = toks[oi];
      if (!br[3]) { i++; continue; }
      const linkText = s.slice(br[1] + 1, i);
      const suf = parseLinkSuffix(s, i + 1, n, refs, linkText);
      if (suf === null) { i++; continue; }
      const innerOut = [];
      // marked's De(): link text is lexed with inLink forced on, then the
      // outer inLink is restored — a tag inside link text must not leak state.
      const savedLink = INLINK;
      INLINK = true;
      const innerHasLink = inlineTo(linkText, refs, innerOut, true);
      INLINK = savedLink;
      if (innerHasLink) {
        for (let k = 0; k < openers.length; k++) toks[openers[k]][3] = false;
        i++; continue;
      }
      // form the link (or image, if bang)
      toks.length = oi;
      const href = cleanUrl(suf.dest);
      if (br[2]) { // image via the stack
        const alt = plainText(linkText, refs);
        const t1 = []; escAttrInto(t1, href, 0, href.length);
        const t2 = []; escAttrInto(t2, alt, 0, alt.length);
        let img = '<img src="' + t1.join('') + '" alt="' + t2.join('') + '"';
        if (suf.title !== null) { const t3 = []; escAttrInto(t3, suf.title, 0, suf.title.length); img += ' title="' + t3.join('') + '"'; }
        toks.push([1, img + '>']);
      } else {
        const t1 = []; escAttrInto(t1, href, 0, href.length);
        let a = '<a href="' + t1.join('') + '"';
        if (suf.title !== null) { const t3 = []; escAttrInto(t3, suf.title, 0, suf.title.length); a += ' title="' + t3.join('') + '"'; }
        toks.push([1, a + '>' + innerOut.join('') + '</a>']);
        formedLink = true;
        for (let k = 0; k < openers.length; k++) toks[openers[k]][3] = false;
      }
      i = suf.end; textStart = i; continue;
    }
    if (c === 38) { // &
      const de = decodeEntity(s, i, n);
      if (de !== null) {
        flush(i);
        const ch = de[0];
        toks.push([1, ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : ch === "'" ? '&#39;' : ch]);
        i = de[1]; textStart = i; continue;
      }
      i++; continue;
    }
    if (c === 60) { // <
      const al = parseAutolink(s, i, n);
      if (al !== null) {
        flush(i);
        const href = cleanUrl(al[1]);
        const t1 = []; escAttrInto(t1, href, 0, href.length);
        const t2 = []; escInto(t2, al[2], 0, al[2].length);
        toks.push([1, '<a href="' + t1.join('') + '">' + t2.join('') + '</a>']);
        i = al[0]; textStart = i; continue;
      }
      const tg = parseHtmlTag(s, i, n);
      if (tg !== -1) {
        const tag = s.slice(i, tg);
        if (/^<a /i.test(tag)) INLINK = true;
        else if (INLINK && /^<\/a>/i.test(tag)) INLINK = false;
        flush(i);
        toks.push([1, tag]);
        i = tg; textStart = i; continue;
      }
      i++; continue;
    }
    if (c === 10) { // newline: hard break if 2+ trailing spaces
      let sp = 0;
      for (let k = i - 1; k >= textStart && s.charCodeAt(k) === 32; k--) sp++;
      if (sp >= 2) {
        flush(i - sp);
        toks.push([1, '<br>']);
        i++; textStart = i;
        // a hard break strips all leading whitespace of the next line
        while (i < n && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
        textStart = i; continue;
      }
      i++; continue;
    }
    if (c === 64 && !noExt && !INLINK) { // @ : extended email, look back for local part
      let k = i - 1;
      while (k >= textStart && isExtLocal(s.charCodeAt(k))) k--;
      const start = k + 1;
      if (start < i) {
        const em = matchExtEmail(s, start, n);
        if (em !== null) {
          flush(start);
          const raw = s.slice(start, em[0]);
          const href = 'mailto:' + raw;
          const t1 = []; escAttrInto(t1, href, 0, href.length);
          const t2 = []; escInto(t2, raw, 0, raw.length);
          toks.push([1, '<a href="' + t1.join('') + '">' + t2.join('') + '</a>']);
          i = em[0]; textStart = i; continue;
        }
      }
      i++; continue;
    }
    if (!noExt && !INLINK && (c === 119 || c === 87 || c === 104 || c === 72 || c === 102 || c === 70 || c === 109 || c === 77 || c === 120 || c === 88)) {
      const m = matchExtAutolink(s, i, n, inBrackets());
      if (m !== null) {
        flush(i);
        const href = cleanUrl(m[1]);
        const t1 = []; escAttrInto(t1, href, 0, href.length);
        const t2 = []; escInto(t2, s, m[2], m[3]);
        toks.push([1, '<a href="' + t1.join('') + '">' + t2.join('') + '</a>']);
        i = m[0]; textStart = i; continue;
      }
      i++; continue;
    }
    i++;
  }
  flush(n);
  resolveEmphasis(toks);
  // Pending emails: the '_' after the domain links iff that delimiter run
  // was used as a closer (the email sits inside the emphasis in marked).
  for (let q = 0; q < pendToks.length; q++) {
    const pt = pendToks[q];
    const dt = pt[4] >= 0 ? toks[pt[4]] : null;
    if (dt !== null && dt[6] !== null) {
      const raw = s.slice(pt[1], pt[2]);
      const href = 'mailto:' + raw;
      const t1 = []; escAttrInto(t1, href, 0, href.length);
      const t2 = []; escInto(t2, raw, 0, raw.length);
      pt[0] = 1; pt[1] = '<a href="' + t1.join('') + '">' + t2.join('') + '</a>';
    } else {
      pt[0] = 0;
    }
  }
  // render
  for (let t = 0; t < toks.length; t++) {
    const tk = toks[t];
    if (tk[0] === 0) escInto(out, s, tk[1], tk[2]);
    else if (tk[0] === 1) out.push(tk[1]);
    else if (tk[0] === 3) out.push(tk[2] ? '![' : '[');
    else { // delim: close tags, then leftover literal chars, then open tags
      const ch = tk[1] === 42 ? '*' : tk[1] === 95 ? '_' : '~';
      if (tk[6]) for (let q = 0; q < tk[6].length; q++) out.push(tk[6][q]);
      if (tk[2] > 0) out.push(ch.repeat(tk[2]));
      if (tk[5]) for (let q = tk[5].length - 1; q >= 0; q--) out.push(tk[5][q]);
    }
  }
  return formedLink;
}
// Emphasis / strikethrough resolution over the token list (delimiter stack algorithm).
function resolveEmphasis(toks) {
  const delims = [];
  for (let idx = 0; idx < toks.length; idx++) if (toks[idx][0] === 2) delims.push(idx);
  const spans = []; // [openerTokIdx, closerTokIdx] of formed emphasis (blocks cross-boundary matches)
  for (let di = 0; di < delims.length; di++) {
    const ci = delims[di];
    const closer = toks[ci];
    if (closer[2] === 0 || !closer[4]) continue; // [4] = canClose
    while (closer[2] > 0) {
      let oi = -1;
      for (let dj = di - 1; dj >= 0; dj--) {
        const oj = delims[dj];
        const opener = toks[oj];
        if (opener[2] === 0 || !opener[3]) continue; // [3] = canOpen
        if (opener[1] !== closer[1]) continue;
        // trapped inside a formed emphasis that ends before this closer?
        let trapped = false;
        for (let s = 0; s < spans.length; s++) {
          if (spans[s][0] < oj && oj < spans[s][1] && spans[s][1] < ci) { trapped = true; break; }
        }
        if (trapped) continue;
        if (closer[1] === 126) { if (opener[2] !== closer[2]) continue; }
        else if ((opener[3] && opener[4]) || (closer[3] && closer[4])) {
          // rule of 3: applies when EITHER delimiter can both open and close
          if ((opener[2] + closer[2]) % 3 === 0 && opener[2] % 3 !== 0) continue;
        }
        oi = oj; break;
      }
      if (oi === -1) break;
      const opener = toks[oi];
      const use = closer[1] === 126 ? closer[2] : (opener[2] >= 2 && closer[2] >= 2 ? 2 : 1);
      const tag = closer[1] === 126 ? 'del' : use === 2 ? 'strong' : 'em';
      if (opener[5] === null) opener[5] = [];
      if (closer[6] === null) closer[6] = [];
      opener[5].push('<' + tag + '>');
      closer[6].push('</' + tag + '>');
      opener[2] -= use;
      closer[2] -= use;
      spans.push([oi, ci]);
    }
  }
}

// Decode entities in a plain string (used for image alt text).
function decodeEntitiesInStr(str) {
  let out = null, k = 0;
  for (let i = 0; i < str.length; i++) {
    if (str.charCodeAt(i) === 38) {
      const de = decodeEntity(str, i, str.length);
      if (de !== null) {
        if (out === null) out = [str.slice(k, i)];
        out.push(de[0]);
        i = de[1] - 1; k = de[1];
      }
    }
  }
  return out === null ? str : out.join('') + str.slice(k);
}
// Plain-text rendering of inline markdown (image alt text): inline HTML with
// tags stripped (img -> its alt), entities decoded.
function plainText(s, refs) {
  const tmp = [];
  const saved = INLINK;
  inlineTo(s, refs, tmp);
  INLINK = saved;
  let html = tmp.join('');
  html = html.replace(/<img\b[^>]*?alt="([^"]*)"[^>]*>/g, '$1');
  html = html.replace(/<br>/g, '\n');
  html = html.replace(/<[^>]*>/g, '');
  return decodeEntitiesInStr(html);
}

// ===================== Block parsing =====================
// Lines are the source split on '\n' (CRLF/CR normalized first).
// [cols, idx]: leading-whitespace columns (tab = next multiple of 4)
// and the char index of the first non-space/tab char.
function lineIndent(line) {
  let cols = 0, idx = 0;
  while (idx < line.length) {
    const c = line.charCodeAt(idx);
    if (c === 32) { cols++; idx++; }
    else if (c === 9) { cols += 4 - (cols % 4); idx++; }
    else break;
  }
  return [cols, idx];
}
function isBlank(line) {
  for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) return false; }
  return true;
}
// Remove `cols` columns of LEADING WHITESPACE only (code/fence indent).
// Tabs cut through become spaces; a remaining leading tab whose width would
// change at its new column is expanded to spaces.
function stripIndent(line, cols) {
  let col = 0, i = 0, out = '';
  while (i < line.length && col < cols) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const adv = 4 - (col % 4);
      if (col + adv <= cols) { col += adv; i++; }
      else { out = ' '.repeat(col + adv - cols); i++; col = col + adv; break; }
    } else break;
  }
  const shift = col - out.length;
  let res = out, rcol = out.length, j = i;
  while (j < line.length) {
    const ch = line.charCodeAt(j);
    if (ch === 32) { res += ' '; rcol++; j++; }
    else if (ch === 9) {
      // a tab entirely past the strip point is kept as a tab, even if its
      // width at the new column differs (only a cut-through tab expands)
      res += '\t'; rcol += 4 - (rcol % 4); j++;
    } else break;
  }
  return res + line.slice(j);
}
// List-item dedent (marked): expand leading tabs to spaces (tab stops from
// column 0), then remove `cols` characters. A tab that straddles the strip
// point becomes spaces — never a literal tab (unlike stripPrefix, which
// preserves a tab whose width is unchanged).
function stripListPrefix(line, cols) {
  let col = 0, i = 0, exp = '';
  while (i < line.length) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { exp += ' '; col++; i++; }
    else if (ch === 9) { const adv = 4 - (col % 4); exp += ' '.repeat(adv); col += adv; i++; }
    else break;
  }
  const rest = line.slice(i);
  if (exp.length >= cols) return exp.slice(cols) + rest;
  return rest;
}
// Remove `cols` columns from the start of a line, including non-whitespace
// marker chars (container prefixes: `>`, `-`, `1.`). Same tab handling.
function stripPrefix(line, cols) {
  let col = 0, i = 0, out = '';
  while (i < line.length && col < cols) {
    const ch = line.charCodeAt(i);
    if (ch === 32) { col++; i++; }
    else if (ch === 9) {
      const adv = 4 - (col % 4);
      if (col + adv <= cols) { col += adv; i++; }
      else { out = ' '.repeat(col + adv - cols); i++; col = col + adv; break; }
    } else { col++; i++; } // marker char: 1 column
  }
  const shift = col - out.length;
  let res = out, rcol = out.length, j = i;
  while (j < line.length) {
    const ch = line.charCodeAt(j);
    if (ch === 32) { res += ' '; rcol++; j++; }
    else if (ch === 9) {
      const origW = 4 - ((rcol + shift) % 4);
      const newW = 4 - (rcol % 4);
      if (origW === newW) { res += '\t'; rcol += newW; j++; }
      else { res += ' '.repeat(origW); rcol += origW; j++; }
    } else break;
  }
  return res + line.slice(j);
}
// A line that is a setext underline: returns 1 ('='), 2 ('-'), or 0.
// The run must be contiguous (no spaces between the chars).
function setextLevel(line) {
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return 0;
  const c = line.charCodeAt(idx);
  if (c !== 61 && c !== 45) return 0;
  let i = idx;
  while (i < line.length && line.charCodeAt(i) === c) i++;
  while (i < line.length) { const d = line.charCodeAt(i); if (d !== 32 && d !== 9) return 0; i++; }
  return c === 61 ? 1 : 2;
}
// A line that is a thematic break.
function isHr(line) {
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return false;
  const c = line.charCodeAt(idx);
  if (c !== 42 && c !== 45 && c !== 95) return false;
  let n = 0;
  for (let i = idx; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d === c) n++;
    else if (d !== 32 && d !== 9) return false;
  }
  return n >= 3;
}
// Parse a link reference definition starting at lines[i].
// Returns {dest, title, end} (end = last line index consumed) or null.
function tryRefDef(lines, i, end) {
  // join up to 20 lines (a title may span several lines)
  const maxEnd = Math.min(end, i + 20);
  let text = lines[i];
  for (let k = i + 1; k < maxEnd; k++) { text += '\n' + lines[k]; }
  const n = text.length;
  let p = 0;
  while (p < n && p < 3 && text.charCodeAt(p) === 32) p++;
  if (p >= n || text.charCodeAt(p) !== 91) return null; // '['
  // label: [ ... ] — no unescaped '[' inside, no blank line
  let q = p + 1, labelEnd = -1;
  while (q < n) {
    const c = text.charCodeAt(q);
    if (c === 10) { if (q + 1 < n && text.charCodeAt(q + 1) === 10) return null; q++; continue; }
    if (c === 92 && q + 1 < n && isPunct(text.charCodeAt(q + 1))) { q += 2; continue; }
    if (c === 91) return null; // unescaped '[' is not allowed in a label
    if (c === 93) { labelEnd = q; break; }
    q++;
  }
  if (labelEnd === -1) return null;
  q = labelEnd + 1;
  const label = normLabel(text.slice(p + 1, labelEnd));
  if (label.length === 0) return null;
  let r = q;
  while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9 || text.charCodeAt(r) === 10)) r++;
  if (r >= n || text.charCodeAt(r) !== 58) return null; // ':'
  r++;
  while (r < n && (text.charCodeAt(r) === 32 || text.charCodeAt(r) === 9 || text.charCodeAt(r) === 10)) r++;
  if (r >= n) return null;
  const d = parseDest(text, r, n);
  if (d === null) return null;
  let dest = d[0]; r = d[1];
  let title = null;
  const save = r; // after dest
  // title: only if preceded by whitespace, and followed by end of line
  let t = r;
  while (t < n && (text.charCodeAt(t) === 32 || text.charCodeAt(t) === 9 || text.charCodeAt(t) === 10)) t++;
  if (t > save && t < n && (text.charCodeAt(t) === 34 || text.charCodeAt(t) === 39 || text.charCodeAt(t) === 40)) {
    const tp = parseTitle(text, t, n);
    if (tp !== null) {
      let u = tp[1];
      while (u < n && (text.charCodeAt(u) === 32 || text.charCodeAt(u) === 9)) u++;
      if (u >= n || text.charCodeAt(u) === 10) { title = tp[0]; r = tp[1]; }
      // else: title followed by junk on its line -> fall back to no title
    }
    // else: title did not parse -> fall back to no title
  }
  // after dest (and optional title): only spaces/tabs to end of line
  let v = r;
  while (v < n && (text.charCodeAt(v) === 32 || text.charCodeAt(v) === 9)) v++;
  if (v < n && text.charCodeAt(v) !== 10) return null; // trailing junk on the line
  // how many lines were consumed: count '\n' before r
  let linesUsed = 1;
  for (let k = 0; k < r; k++) if (text.charCodeAt(k) === 10) linesUsed++;
  return { dest, title, end: i + linesUsed - 1, label };
}
// Consume leading ref defs of a paragraph (lines[start..end)); returns the
// index of the first non-def line and stores defs in refs.
function consumeRefDefs(lines, start, end, refs) {
  let i = start;
  while (i < end) {
    if (isBlank(lines[i])) break;
    const def = tryRefDef(lines, i, end);
    if (def === null) break;
    if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
    i = def.end + 1;
  }
  return i;
}
// ---- HTML blocks ----
// Block-level tags (CommonMark type 6).
const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
// HTML block starting at lines[i] (line[idx] === '<', ind <= 3).
// Returns {end, type} (end = last line index) or null. Type 7 cannot interrupt a paragraph.
function htmlBlockStart(lines, i, end) {
  const line = lines[i];
  const [ind, idx] = lineIndent(line);
  if (ind > 3 || line.charCodeAt(idx) !== 60) return null;
  const lower = line.slice(idx).toLowerCase();
  for (const t1 of ['pre', 'script', 'style', 'textarea']) {
    if (lower.startsWith('<' + t1)) {
      const c = lower.charAt(1 + t1.length);
      if (c === '' || c === ' ' || c === '\t' || c === '\n' || c === '>') return { type: 1, close: '</' + t1 + '>' };
    }
  }
  if (lower.startsWith('<!--')) return { type: 2, close: '-->' };
  if (lower.startsWith('<?')) return { type: 3, close: '?>' };
  if (lower.startsWith('<!') && lower.length > 2 && /[A-Za-z]/.test(lower.charAt(2))) return { type: 4, close: '>' };
  if (lower.startsWith('<![cdata[')) return { type: 5, close: ']]>' };
  // type 6: < or </ followed by a block-level tag name (no delimiter required)
  const tagM = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(line.slice(idx));
  if (tagM && BLOCK_TAGS.has(tagM[1].toLowerCase())) return { type: 6 };
  // type 7: a complete open or close tag, alone on the line
  const e = parseHtmlTag(line, idx, line.length);
  if (e === line.length) return { type: 7 };
  return null;
}
// ---- Tables ----
function splitTableRow(line) {
  // split on unescaped '|', trim cells; strip one leading/trailing empty cell from edge pipes
  const cells = [];
  let cur = '';
  const s = line.trim();
  const hasLead = s.startsWith('|');
  const hasTrail = s.endsWith('|') && s.length > 1;
  let k = hasLead ? 1 : 0;
  const end = hasTrail ? s.length - 1 : s.length;
  for (; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === 92 && k + 1 < end && s.charCodeAt(k + 1) === 124) { cur += '|'; k++; continue; }
    if (c === 124) { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}
function isDelimiterRow(line) {
  if (lineIndent(line)[0] > 3) return null;
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^:?-+:?$/.exec(cell);
    if (!m) return null;
    const left = cell.startsWith(':'), right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// ATX heading at line[idx] === '#'. Returns {level, content} or null.
function tryAtx(line, idx) {
  let n = 0;
  while (line.charCodeAt(idx + n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (idx + n >= line.length) return { level: n, content: '' };
  const after = line.charCodeAt(idx + n);
  if (after !== 32 && after !== 9) return null;
  let content = line.slice(idx + n);
  // closing sequence of #'s preceded by a space (check before trimming)
  content = content.replace(/[ \t]+#+[ \t]*$/, '');
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: n, content };
}
// List marker at line[idx] (ind = indent columns of the marker).
// Returns {ordered, delim, start, contentIndent, markerLen} or null.
// contentIndent is in COLUMNS: marker + whitespace after it (1-4 cols);
// 5+ cols of whitespace (or an empty item) -> marker + 1.
function listMarker(line, idx, ind) {
  const c = line.charCodeAt(idx);
  if (c === 45 || c === 43 || c === 42) {
    const after = line.charCodeAt(idx + 1);
    if (Number.isNaN(after) || after === 32 || after === 9) {
      let j = idx + 1, cols = ind + 1, wsCols = 0;
      while (j < line.length) {
        const d = line.charCodeAt(j);
        if (d === 32) { wsCols++; cols++; j++; }
        else if (d === 9) { const adv = 4 - (cols % 4); wsCols += adv; cols += adv; j++; }
        else break;
      }
      const contentIndent = (j >= line.length || wsCols >= 5) ? ind + 2 : ind + 1 + wsCols;
      return { ordered: false, delim: String.fromCharCode(c), start: 0, contentIndent, markerLen: 1, empty: j >= line.length };
    }
    return null;
  }
  if (c >= 48 && c <= 57) {
    let j = idx;
    while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (j - idx > 9) return null;
    const delim = line.charCodeAt(j);
    if (delim !== 46 && delim !== 41) return null;
    const after = line.charCodeAt(j + 1);
    if (!Number.isNaN(after) && after !== 32 && after !== 9) return null;
    const start = parseInt(line.slice(idx, j), 10);
    const markerLen = j - idx + 1;
    let k = j + 1, cols = ind + markerLen, wsCols = 0;
    while (k < line.length) {
      const d = line.charCodeAt(k);
      if (d === 32) { wsCols++; cols++; k++; }
      else if (d === 9) { const adv = 4 - (cols % 4); wsCols += adv; cols += adv; k++; }
      else break;
    }
    const contentIndent = (k >= line.length || wsCols >= 5) ? ind + markerLen + 1 : ind + markerLen + wsCols;
    return { ordered: true, delim: String.fromCharCode(delim), start, contentIndent, markerLen, empty: k >= line.length };
  }
  return null;
}
// Fenced code starting at lines[i]. Returns {end, lang, char} or null.
function tryFence(lines, i, end) {
  const line = lines[i];
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return null;
  const ch = line.charCodeAt(idx);
  if (ch !== 96 && ch !== 126) return null;
  let run = 0;
  while (line.charCodeAt(idx + run) === ch) run++;
  if (run < 3) return null;
  let info = line.slice(idx + run);
  if (ch === 96 && info.includes('`')) return null;
  info = info.trim();
  const langRaw = info.split(/[ \t]+/)[0] || '';
  const lang = unescapeStr(langRaw, 0, langRaw.length);
  // find closing fence
  let j = i + 1;
  while (j < end) {
    const l2 = lines[j];
    const [ind2, idx2] = lineIndent(l2);
    if (ind2 <= 3 && l2.charCodeAt(idx2) === ch) {
      let r2 = 0;
      while (l2.charCodeAt(idx2 + r2) === ch) r2++;
      if (r2 >= run) {
        let ok = true;
        for (let k = idx2 + r2; k < l2.length; k++) { const d = l2.charCodeAt(k); if (d !== 32 && d !== 9) { ok = false; break; } }
        if (ok) break;
      }
    }
    j++;
  }
  const closeIdx = j < end ? j : end;
  // Content lines: marked's Dt strips up to N leading whitespace CHARACTERS
  // (N = the fence line's leading-whitespace length), and only for backtick
  // fences — tilde fences keep their content verbatim (indentCodeCompensation
  // only matches ```). A tab counts as ONE character here, not 4 columns.
  const content = [];
  const strip = ch === 96 ? idx : 0;
  for (let k = i + 1; k < closeIdx; k++) content.push(stripFenceIndent(lines[k], strip));
  if (content.length > 0 && content[content.length - 1] === '') content.pop();
  return { end: closeIdx < end ? closeIdx + 1 : end, lang, content };
}
// Remove up to n leading whitespace characters (spaces/tabs count as 1).
function stripFenceIndent(line, n) {
  let i = 0;
  while (i < line.length && i < n && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) i++;
  return line.slice(i);
}
// Render a fenced/indented code block's content lines.
function codeBlockHtml(content, lang) {
  const out = ['<pre><code'];
  if (lang) { const t = []; escAttrInto(t, lang, 0, lang.length); out.push(' class="language-', t.join(''), '"'); }
  out.push('>');
  for (const l of content) { escCodeInto(out, l, 0, l.length); out.push('\n'); }
  out.push('</code></pre>\n');
  return out.join('');
}
// Does this line start a block that interrupts a paragraph? (ATX, fence, hr,
// blockquote, list-that-can-interrupt, HTML block type 1-6.)
function interruptsPara(line, inPara, inList) {
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return false;
  const c = line.charCodeAt(idx);
  if (c === 35) return tryAtx(line, idx) !== null;
  if (c === 96 || c === 126) {
    let run = 0;
    while (line.charCodeAt(idx + run) === c) run++;
    if (run >= 3) {
      if (c === 96 && line.slice(idx + run).includes('`')) return false;
      return true;
    }
    return false;
  }
  if (c === 62) return true;
  if (c === 60) {
    // HTML block type 1-6 interrupts; type 7 does not
    const hb = htmlBlockStart([line], 0, 1);
    return hb !== null && hb.type !== 7;
  }
  if (c === 42 || c === 45 || c === 95) { if (isHr(line)) return true; }
  const lm = listMarker(line, idx, ind);
  if (lm) {
    if (lm.empty) return false;
    if (!lm.ordered) return true;
    // inside a list item's content, an ordered list may interrupt a paragraph
    // regardless of its start number (nested list); elsewhere start must be 1
    return inList || lm.start === 1;
  }
  return false;
}
// Parse blocks in lines[start..end). Returns array of
// {html, start, end, kind, inner}. `noP` renders direct paragraphs without
// <p> (tight list items). `endsNL` = the text ends with a newline (top level).
function parseBlocks(lines, start, end, refs, noP, endsNL, inList) {
  const blocks = [];
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const [ind, idx] = lineIndent(line);
    const c = line.charCodeAt(idx);
    // indented code
    if (ind >= 4) {
      const content = [];
      let j = i;
      while (j < end) {
        const l2 = lines[j];
        if (isBlank(l2)) {
          // blank line inside code only if followed by another indented line;
          // it keeps its content stripped of the 4-col code indent
          let k = j + 1;
          while (k < end && isBlank(lines[k])) k++;
          if (k < end && lineIndent(lines[k])[0] >= 4) { for (let b = j; b < k; b++) content.push(stripIndent(lines[b], 4)); j = k; continue; }
          break;
        }
        if (lineIndent(l2)[0] >= 4) { content.push(stripIndent(l2, 4)); j++; continue; }
        break;
      }
      while (content.length > 0 && isBlank(content[content.length - 1])) content.pop();
      blocks.push({ html: codeBlockHtml(content, ''), start: i, end: j, kind: 'code' });
      i = j; continue;
    }
    // ATX heading
    if (c === 35) {
      const atx = tryAtx(line, idx);
      if (atx) {
        const inner = [];
        inlineTo(atx.content, refs, inner);
        blocks.push({ html: '<h' + atx.level + '>' + inner.join('') + '</h' + atx.level + '>\n', start: i, end: i + 1, kind: 'heading' });
        i++; continue;
      }
    }
    // fenced code
    if (c === 96 || c === 126) {
      const f = tryFence(lines, i, end);
      if (f) {
        blocks.push({ html: codeBlockHtml(f.content, f.lang), start: i, end: f.end, kind: 'code' });
        i = f.end; continue;
      }
    }
    // blockquote
    if (c === 62) {
      const q = parseQuote(lines, i, end, refs, endsNL, inList);
      blocks.push({ html: q.html, start: i, end: q.end, kind: 'quote' });
      i = q.end; continue;
    }
    // thematic break (checked before list: `- - -` and `* * *` are hrs)
    if (isHr(line)) {
      blocks.push({ html: '<hr>\n', start: i, end: i + 1, kind: 'hr' });
      i++; continue;
    }
    // list
    if (c === 45 || c === 43 || c === 42 || (c >= 48 && c <= 57)) {
      const lm = listMarker(line, idx, ind);
      if (lm) {
        const l = parseList(lines, i, end, refs, endsNL, inList);
        blocks.push({ html: l.html, start: i, end: l.end, kind: 'list' });
        i = l.end; continue;
      }
    }
    // HTML block
    if (c === 60) {
      const hb = htmlBlockStart(lines, i, end);
      if (hb) {
        let j = i;
        if (hb.type === 1 || hb.type === 2 || hb.type === 3 || hb.type === 4 || hb.type === 5) {
          // ends at a line containing the close marker (the start line may contain it)
          const close = hb.close;
          for (;;) {
            if (lines[j].toLowerCase().includes(close)) break;
            j++;
            if (j >= end) { j = end - 1; break; }
          }
          j++;
        } else {
          // type 6/7: ends at a blank line
          j = i + 1;
          while (j < end && !isBlank(lines[j])) j++;
        }
        const blines = lines.slice(i, j);
        // trailing newline: types 1-5 add one iff the next line is not the
        // empty string (a whitespace-only line still counts); types 6-7
        // (which end at a blank line) only when the block is last and the
        // text ends with a newline
        const trailNL = hb.type <= 5
          ? (j < end && lines[j] !== '') || (j >= end && endsNL)
          : (j < end && !isBlank(lines[j])) || (j >= end && endsNL);
        blocks.push({ html: blines.join('\n') + (trailNL ? '\n' : ''), start: i, end: j, kind: 'html' });
        i = j; continue;
      }
    }
    // paragraph (with setext / table / ref-def handling)
    const para = parseParagraph(lines, i, end, refs, noP, inList);
    for (const b of para.blocks) blocks.push(b);
    i = para.end;
  }
  return blocks;
}

// First non-def line index (no storing) — used to test "all defs so far".
function defLinesEnd(lines, start, end) {
  let i = start;
  while (i < end) {
    if (isBlank(lines[i])) break;
    const def = tryRefDef(lines, i, end);
    if (def === null) break;
    i = def.end + 1;
  }
  return i;
}
// Is this line a paragraph-continuation line (not blank, not a block start)?
function isParaLine(line) {
  if (isBlank(line)) return false;
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return true; // indented text is a continuation (code can't interrupt)
  const c = line.charCodeAt(idx);
  if (c === 35) return tryAtx(line, idx) === null;
  if (c === 96 || c === 126) { let r = 0; while (line.charCodeAt(idx + r) === c) r++; return r < 3; }
  if (c === 62) return false;
  if (c === 60) { const hb = htmlBlockStart([line], 0, 1); return hb === null || hb.type === 7; }
  if (c === 42 || c === 45 || c === 95) {
    if (listMarker(line, idx, ind)) return false;
    return !isHr(line);
  }
  if (listMarker(line, idx, ind)) return false;
  return true;
}
// Parse a paragraph starting at lines[i]. Returns {blocks, end}.
function parseParagraph(lines, i, end, refs, noP, inList) {
  // NB: the first line keeps its leading spaces (marked does not strip them).
  const paraLines = [lines[i]];
  let j = i + 1, setext = 0, tableDelim = -1;
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) break;
    const sl = setextLevel(line);
    if (sl) { setext = sl; j++; break; }
    const aligns = isDelimiterRow(line);
    if (aligns) {
      // the delimiter row must have exactly as many cells as the header line
      const headerCells = splitTableRow(paraLines[paraLines.length - 1]);
      if (aligns.length === headerCells.length && defLinesEnd(paraLines, 0, paraLines.length) < paraLines.length) { tableDelim = j; break; }
    }
    if (interruptsPara(line, true, inList)) break;
    paraLines.push(line);
    j++;
  }
  const dEnd = consumeRefDefs(paraLines, 0, paraLines.length, refs);
  if (setext) {
    if (dEnd >= paraLines.length) return { blocks: [], end: j - 1 }; // no content; re-process the underline
    const text = paraLines.slice(dEnd).join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    const inner = [];
    inlineTo(text, refs, inner);
    const html = '<h' + setext + '>' + inner.join('') + '</h' + setext + '>\n';
    return { blocks: [{ html, start: i, end: j, kind: 'heading' }], end: j };
  }
  if (tableDelim >= 0) {
    const aligns = isDelimiterRow(lines[tableDelim]);
    const headerLine = paraLines[paraLines.length - 1];
    const headerCells = splitTableRow(headerLine);
    let bEnd = tableDelim + 1;
    while (bEnd < end) {
      const l2 = lines[bEnd];
      // a tab-only line is a table row (empty cells), not a blank line;
      // only an empty or spaces-only line ends the table
      if (l2 === '' || /^[ ]*$/.test(l2)) break;
      if (interruptsPara(l2, false, inList)) break;
      bEnd++;
    }
    let html = '<table>\n<thead>\n<tr>\n';
    for (let ci = 0; ci < aligns.length; ci++) {
      const inner = [];
      inlineTo(headerCells[ci] || '', refs, inner);
      html += '<th' + (aligns[ci] ? ' align="' + aligns[ci] + '"' : '') + '>' + inner.join('') + '</th>\n';
    }
    html += '</tr>\n</thead>\n';
    if (bEnd > tableDelim + 1) {
      html += '<tbody>';
      for (let r = tableDelim + 1; r < bEnd; r++) {
        const cells = splitTableRow(lines[r]);
        html += '<tr>\n';
        for (let ci = 0; ci < aligns.length; ci++) {
          const inner = [];
          inlineTo(cells[ci] || '', refs, inner);
          html += '<td' + (aligns[ci] ? ' align="' + aligns[ci] + '"' : '') + '>' + inner.join('') + '</td>\n';
        }
        html += '</tr>\n';
      }
      html += '</tbody>';
    }
    html += '</table>\n';
    const blocks = [];
    const preLines = paraLines.slice(dEnd, paraLines.length - 1);
    if (preLines.length > 0) {
      const inner = [];
      inlineTo(preLines.join('\n'), refs, inner);
      const innerHtml = inner.join('');
      blocks.push({ html: noP ? innerHtml : '<p>' + innerHtml + '</p>\n', start: i, end: tableDelim, kind: 'p', inner: innerHtml });
    }
    blocks.push({ html, start: i, end: bEnd, kind: 'table' });
    return { blocks, end: bEnd };
  }
  const contentLines = paraLines.slice(dEnd);
  if (contentLines.length === 0) return { blocks: [], end: j };
  const inner = [];
  inlineTo(contentLines.join('\n'), refs, inner);
  const innerHtml = inner.join('');
  const html = noP ? innerHtml : '<p>' + innerHtml + '</p>\n';
  return { blocks: [{ html, start: i, end: j, kind: 'p', inner: innerHtml }], end: j };
}
// Blockquote starting at lines[i] (line[idx] === '>').
// Is a paragraph open after adding `line` as a content line (wasOpen = was a
// paragraph open before it)? Used to decide lazy continuations.
function paraOpenAfter(line, wasOpen) {
  if (isBlank(line)) return false;
  const [ind, idx] = lineIndent(line);
  if (ind > 3) return wasOpen; // indented: continuation if open, code if not
  const c = line.charCodeAt(idx);
  if (c === 35) return tryAtx(line, idx) === null;
  if (c === 96 || c === 126) { let r = 0; while (line.charCodeAt(idx + r) === c) r++; return r < 3; }
  if (c === 62) {
    // nested quote: recurse into its content (fresh context)
    const spaceAfter = (line.charCodeAt(idx + 1) === 32 || line.charCodeAt(idx + 1) === 9) ? 1 : 0;
    return paraOpenAfter(stripPrefix(line, ind + 1 + spaceAfter), false);
  }
  if (c === 60) { const hb = htmlBlockStart([line], 0, 1); return hb === null || hb.type === 7; }
  if (c === 42 || c === 45 || c === 95) {
    if (isHr(line)) return false;
    if (listMarker(line, idx, ind)) return true;
    return true;
  }
  if (listMarker(line, idx, ind)) return true;
  if (setextLevel(line) > 0) return !wasOpen; // underline ends the para (heading) only if one is open
  return true;
}
function parseQuote(lines, i, end, refs, endsNL, inList) {
  const sub = [];
  let j = i, prevLazy = false, paraOpen = false;
  // fenced-code state: lines inside a fence are not paragraph content, so a
  // lazy (unprefixed) line there must end the quote, not continue it
  let fenceChar = 0, fenceLen = 0;
  while (j < end) {
    const line = lines[j];
    const [ind, idx] = lineIndent(line);
    if (ind <= 3 && line.charCodeAt(idx) === 62) {
      const spaceAfter = (line.charCodeAt(idx + 1) === 32 || line.charCodeAt(idx + 1) === 9) ? 1 : 0;
      const s = stripPrefix(line, ind + 1 + spaceAfter);
      // track fenced code blocks (indent <= 3, 3+ backticks/tildes)
      const [ind2, idx2] = lineIndent(s);
      if (ind2 <= 3) {
        const cc = s.charCodeAt(idx2);
        if (cc === 96 || cc === 126) {
          let r = 0; while (s.charCodeAt(idx2 + r) === cc) r++;
          if (r >= 3) {
            if (fenceChar !== 0 && cc === fenceChar && r >= fenceLen) {
              // closing fence: only spaces/tabs may follow
              let ok = true;
              for (let k = idx2 + r; k < s.length; k++) { const d = s.charCodeAt(k); if (d !== 32 && d !== 9) { ok = false; break; } }
              if (ok) { fenceChar = 0; fenceLen = 0; }
            } else if (fenceChar === 0 && !(cc === 96 && s.slice(idx2 + r).includes('`'))) {
              fenceChar = cc; fenceLen = r;
            }
          }
        }
      }
      sub.push(s);
      paraOpen = fenceChar !== 0 ? false : paraOpenAfter(s, paraOpen);
      prevLazy = false;
      j++; continue;
    }
    if (isBlank(line)) break; // a truly blank line ends the quote
    // lazy continuation: a paragraph must be open, and this line is not a block start.
    // Append to the previous sub-line (do not push a new one) so the re-parse
    // treats it as paragraph text, never as a new block (cm-238: `- bar`).
    if (sub.length > 0 && paraOpen && isParaLine(line)) {
      const [lind] = lineIndent(line);
      let l = lind >= 4 ? stripIndent(line, 4) : line;
      if (prevLazy && setextLevel(l) > 0) { l = '    ' + l.replace(/^[ \t]+/, ''); }
      sub[sub.length - 1] += '\n' + l;
      paraOpen = paraOpenAfter(l, paraOpen);
      prevLazy = true;
      j++; continue;
    }
    break;
  }
  // a trailing whitespace-only sub-line from a `>` line merges into the previous
  // paragraph line (cm-241: `> foo\n>  ` -> <p>foo\n </p>), but only one
  if (sub.length >= 2) {
    const last = sub[sub.length - 1];
    if (last.length > 0 && isBlank(last) && !isBlank(sub[sub.length - 2]) && paraOpenAfter(sub[sub.length - 2], false)) {
      sub[sub.length - 2] += '\n' + last;
      sub.pop();
    }
  }
  while (sub.length > 0 && isBlank(sub[sub.length - 1])) sub.pop();
  // a blockquote resets the list-item context: inside it, an ordered list
  // again needs start 1 to interrupt a paragraph
  const inner = parseBlocks(sub, 0, sub.length, refs, false, false, false);
  let html = '<blockquote>\n';
  for (const b of inner) html += b.html;
  html += '</blockquote>\n';
  return { html, end: j };
}
// List starting at lines[i].
function parseList(lines, i, end, refs, endsNL, inList) {
  const [ind0, idx0] = lineIndent(lines[i]);
  const lm0 = listMarker(lines[i], idx0, ind0);
  const ordered = lm0.ordered, delim = lm0.delim, listIndent = ind0;
  const items = [];
  let loose = false;
  let j = i;
  let prevContentCols = Infinity; // content indent of the previous item
  let listEnd = i + 1; // end of the last item's content (excludes trailing blanks)
  while (j < end) {
    const line = lines[j];
    if (isBlank(line)) { j++; continue; }
    if (isHr(line)) break; // a thematic break ends the list
    const [ind, idx] = lineIndent(line);
    const lm = listMarker(line, idx, ind);
    // a sibling item must be indented less than the previous item's content indent
    // and within 3 columns of the list's first item (cm-312/313)
    if (!lm || ind >= prevContentCols || ind > listIndent + 3 || lm.ordered !== ordered || lm.delim !== delim) break;
    const contentCols = lm.contentIndent;
    const itemLines = [stripPrefix(line, contentCols)];
    let paraOpen = paraOpenAfter(itemLines[0], false);
    let hasContent = !isBlank(itemLines[0]);
    let k = j + 1, blankRun = 0;
    while (k < end) {
      const l2 = lines[k];
      if (isBlank(l2)) { blankRun++; k++; continue; }
      const [ind2, idx2] = lineIndent(l2);
      const lm2 = listMarker(l2, idx2, ind2);
      if (ind2 >= contentCols) {
        // an empty item ends at a blank line (cm-280)
        if (blankRun > 0 && !hasContent) break;
        // a blank line before a ref def still separates items (cm-317:
        // the def is consumed, so the blank is a real separator)
        if (blankRun > 0 && tryRefDef(lines, k, end)) loose = true;
        for (let b = 0; b < blankRun; b++) { itemLines.push(''); paraOpen = false; }
        blankRun = 0;
        const stripped = stripListPrefix(l2, contentCols);
        itemLines.push(stripped);
        paraOpen = paraOpenAfter(stripped, paraOpen);
        hasContent = true;
        k++; continue;
      }
      if (isHr(l2)) break; // a thematic break ends the list (even if it looks like an item)
      // a sibling item (indent < this item's content indent, within 3 of list indent) ends this item
      if (lm2 && ind2 < contentCols && ind2 <= listIndent + 3 && lm2.ordered === ordered && lm2.delim === delim) break;
      if (blankRun === 0 && itemLines.length > 0 && paraOpen && isParaLine(l2)) {
        // lazy continuation: append to the previous item line so the re-parse
        // treats it as paragraph text, never as a new block; strip 4 cols
        // when indented >= 4 (cm-291)
        const [lind2] = lineIndent(l2);
        const ll = lind2 >= 4 ? stripIndent(l2, 4) : l2;
        itemLines[itemLines.length - 1] += '\n' + ll;
        paraOpen = paraOpenAfter(ll, paraOpen);
        hasContent = true;
        k++; continue;
      }
      break;
    }
    if (blankRun > 0 && k < end) {
      const [ind3, idx3] = lineIndent(lines[k]);
      const lm3 = listMarker(lines[k], idx3, ind3);
      if (lm3 && ind3 < contentCols && ind3 <= listIndent + 3 && lm3.ordered === ordered && lm3.delim === delim) loose = true;
    }
    items.push({ lines: itemLines });
    prevContentCols = contentCols;
    listEnd = k - blankRun; // content end, excluding trailing blank lines
    j = k;
  }
  // loose if any item contains two blocks separated by a blank line
  // item content is parsed with inList=true: a nested ordered list may
  // interrupt a paragraph regardless of its start number
  let parsed = items.map((it) => parseBlocks(it.lines, 0, it.lines.length, refs, false, false, true));
  if (!loose) {
    for (let t = 0; t < items.length; t++) {
      const bl = parsed[t];
      for (let b = 1; b < bl.length; b++) {
        for (let l = bl[b - 1].end; l < bl[b].start; l++) {
          if (isBlank(items[t].lines[l])) { loose = true; break; }
        }
        if (loose) break;
      }
      if (loose) break;
    }
  }
  if (!loose) parsed = items.map((it) => parseBlocks(it.lines, 0, it.lines.length, refs, true, false, true));
  let html = ordered ? (lm0.start !== 1 ? '<ol start="' + lm0.start + '">\n' : '<ol>\n') : '<ul>\n';
  for (let t = 0; t < items.length; t++) {
    let li = '<li>';
    // task item: [ ] / [x] / [X] at the start of the first content line
    const first = items[t].lines[0] || '';
    const tm = /^\[([ xX])\][ \t]/.exec(first) || /^\[([ xX])\]$/.exec(first);
    let inputHtml = '';
    if (tm) {
      const checked = tm[1] !== ' ';
      inputHtml = checked ? '<input checked="" disabled="" type="checkbox"> ' : '<input disabled="" type="checkbox"> ';
      // strip the checkbox marker from the item's first line and re-parse
      items[t].lines[0] = first.slice(tm[0].length);
      parsed[t] = parseBlocks(items[t].lines, 0, items[t].lines.length, refs, !loose, false, true);
    }
    if (inputHtml) {
      // loose items render the first paragraph with <p>; the checkbox goes inside it
      if (parsed[t].length > 0 && parsed[t][0].html.startsWith('<p>')) {
        parsed[t][0].html = '<p>' + inputHtml + parsed[t][0].html.slice(3);
      } else {
        li += inputHtml;
      }
    }
    for (const b of parsed[t]) li += b.html;
    li += '</li>\n';
    html += li;
  }
  html += ordered ? '</ol>\n' : '</ul>\n';
  return { html, end: listEnd };
}
export function parse(markdown) {
  const src = markdown.replace(/\r\n?/g, '\n');
  if (src === '') return '';
  const lines = src.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const endsNL = src.endsWith('\n');
  const refs = new Map();
  // pass 1: collect link reference definitions (document-global)
  INLINK = false;
  parseBlocks(lines, 0, lines.length, refs, false, endsNL);
  // pass 2: render
  INLINK = false;
  const blocks = parseBlocks(lines, 0, lines.length, refs, false, endsNL);
  let out = '';
  for (const b of blocks) out += b.html;
  return out;
}
