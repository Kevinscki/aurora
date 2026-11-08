import { memo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";

/* A small Markdown renderer for chat replies. No dependencies, and it builds React elements
   (never raw HTML), so model output can't inject markup. Fenced code blocks are handled by the
   caller (App.jsx), so this only sees the text between them.
   Supports: headings, bold, italic, strikethrough, inline code, links, autolinks, TeX math,
   bullet and numbered lists (nested), blockquotes, horizontal rules, tables and paragraphs. */

const SAFE_URL = /^(https?:\/\/|mailto:)/i;
const BARE_SYMBOLS = new Set([
  "leftarrow", "rightarrow", "leftrightarrow", "Leftarrow", "Rightarrow", "Leftrightarrow",
  "uparrow", "downarrow", "mapsto", "to", "infty", "times", "div", "pm", "neq", "leq", "geq",
]);
const mathSource = (source) => {
  const trimmed = source.trim();
  // Accept the common chat shorthand `$rightarrow$` as well as canonical `$\\rightarrow$`.
  return BARE_SYMBOLS.has(trimmed) ? `\\${trimmed}` : source;
};

const INLINE_SRC = (
  [
    "\\\\\\(([^\\n]+?)\\\\\\)", //                                      1 math: \\( ... \\)
    "\\$([^$\\n]+?)\\$", //                                            2 math: $ ... $
    "`([^`\\n]+)`", //                                                3 code
    "\\*\\*([^\\s*](?:[\\s\\S]*?[^\\s*])?)\\*\\*", //                 4 bold
    "__([^\\s_](?:[\\s\\S]*?[^\\s_])?)__", //                         5 bold
    "~~([^\\s~](?:[\\s\\S]*?[^\\s~])?)~~", //                         6 strike
    '\\[([^\\]\\n]+)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', //          7 link text, 8 url
    "(https?:\\/\\/[^\\s<>()\\]]+[^\\s<>()\\].,;:!?'\"])", //         9 bare url
    "\\*([^\\s*](?:[^*\\n]*?[^\\s*])?)\\*", //                       10 italic
    "(?<![A-Za-z0-9_])_([^\\s_](?:[^_\\n]*?[^\\s_])?)_(?![A-Za-z0-9_])", // 11 italic
  ].join("|")
);

function Math({ source, display = false }) {
  let html;
  try {
    html = katex.renderToString(mathSource(source), {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "htmlAndMathml",
    });
  } catch {
    return display ? <pre className="math-error">{source}</pre> : <span className="math-error">{source}</span>;
  }
  return <span className={display ? "math-display" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

function inline(text, key = "") {
  const out = [];
  let last = 0, n = 0, m;
  const INLINE = new RegExp(INLINE_SRC, "g"); // per call: inline() recurses, a shared lastIndex would be clobbered
  while ((m = INLINE.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}i${n++}`;
    if (m[1] !== undefined || m[2] !== undefined) out.push(<Math key={k} source={m[1] ?? m[2]} />);
    else if (m[3] !== undefined) out.push(<code key={k}>{m[3]}</code>);
    else if (m[4] !== undefined || m[5] !== undefined) out.push(<strong key={k}>{inline(m[4] ?? m[5], k)}</strong>);
    else if (m[6] !== undefined) out.push(<del key={k}>{inline(m[6], k)}</del>);
    else if (m[7] !== undefined) {
      if (SAFE_URL.test(m[8])) out.push(<a key={k} href={m[8]} target="_blank" rel="noreferrer noopener">{inline(m[7], k)}</a>);
      else out.push(m[0]); // javascript: and friends stay as plain text
    } else if (m[9] !== undefined) out.push(<a key={k} href={m[9]} target="_blank" rel="noreferrer noopener">{m[9]}</a>);
    else out.push(<em key={k}>{inline(m[10] ?? m[11], k)}</em>);
    last = INLINE.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// text with soft line breaks kept as <br/>
function lines(text, key) {
  return text.split("\n").flatMap((l, i) => (i ? [<br key={`${key}b${i}`} />, ...inline(l, `${key}l${i}`)] : inline(l, `${key}l${i}`)));
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const blank = (l) => !l.trim();
const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

const startsBlock = (l, next) =>
  HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LI.test(l) || (l.includes("|") && next !== undefined && TABLE_SEP.test(next));

function list(ls, i, key) {
  const first = LI.exec(ls[i]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  while (i < ls.length) {
    const m = LI.exec(ls[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break; // a different list type starts a new list
    const item = { text: [m[3]], kids: [] };
    i++;
    while (i < ls.length) {
      const nm = LI.exec(ls[i]);
      if (nm && nm[1].length > base) {
        const [node, next] = list(ls, i, `${key}.${items.length}.${item.kids.length}`);
        item.kids.push(node);
        i = next;
      } else if (!nm && !blank(ls[i]) && /^\s+\S/.test(ls[i]) && !QUOTE.test(ls[i])) {
        item.text.push(ls[i].trim()); // wrapped continuation line
        i++;
      } else break;
    }
    items.push(item);
    // one blank line between items of the same list is fine
    if (i + 1 < ls.length && blank(ls[i])) {
      const nm = LI.exec(ls[i + 1]);
      if (nm && nm[1].length === base && /\d/.test(nm[2]) === ordered) i++;
    }
  }
  const body = items.map((it, j) => (
    <li key={`${key}.${j}`}>{lines(it.text.join("\n"), `${key}.${j}`)}{it.kids}</li>
  ));
  return [ordered ? <ol key={key} start={start !== 1 ? start : undefined}>{body}</ol> : <ul key={key}>{body}</ul>, i];
}

function blocks(src, key = "") {
  const ls = src.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < ls.length) {
    const line = ls[i];
    const k = `${key}b${out.length}`;
    if (blank(line)) { i++; continue; }

    // Display TeX may be on one line or span several lines. Leave an unmatched
    // opener as ordinary text so a stray dollar sign cannot swallow the reply.
    const trimmed = line.trim();
    const opener = trimmed.startsWith("$$") ? "$$" : trimmed.startsWith("\\[") ? "\\[" : null;
    if (opener) {
      const closer = opener === "$$" ? "$$" : "\\]";
      const parts = [trimmed.slice(opener.length)];
      let end = i;
      while (!parts.at(-1).trimEnd().endsWith(closer) && end + 1 < ls.length) parts.push(ls[++end]);
      if (parts.at(-1).trimEnd().endsWith(closer)) {
        parts[parts.length - 1] = parts.at(-1).trimEnd().slice(0, -closer.length);
        out.push(<Math key={k} source={parts.join("\n").trim()} display />);
        i = end + 1;
        continue;
      }
    }

    let m = HEADING.exec(line);
    if (m) {
      const Tag = `h${m[1].length}`;
      out.push(<Tag key={k}>{inline(m[2], k)}</Tag>);
      i++; continue;
    }
    if (HR.test(line)) { out.push(<hr key={k} />); i++; continue; }

    if (QUOTE.test(line)) {
      const q = [];
      while (i < ls.length && QUOTE.test(ls[i])) q.push(ls[i++].replace(QUOTE, ""));
      out.push(<blockquote key={k}>{blocks(q.join("\n"), k)}</blockquote>);
      continue;
    }

    if (LI.test(line)) {
      const [node, next] = list(ls, i, k);
      out.push(node);
      i = next; continue;
    }

    if (line.includes("|") && i + 1 < ls.length && TABLE_SEP.test(ls[i + 1])) {
      const head = cells(line);
      const align = cells(ls[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : undefined));
      i += 2;
      const rows = [];
      while (i < ls.length && !blank(ls[i]) && ls[i].includes("|")) rows.push(cells(ls[i++]));
      out.push(
        <div key={k} className="tbl">
          <table>
            <thead><tr>{head.map((c, j) => <th key={j} style={{ textAlign: align[j] }}>{inline(c, `${k}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, a) => (
              <tr key={a}>{head.map((_, j) => <td key={j} style={{ textAlign: align[j] }}>{inline(r[j] ?? "", `${k}r${a}c${j}`)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      );
      continue;
    }

    const para = [line];
    i++;
    while (i < ls.length && !blank(ls[i]) && !startsBlock(ls[i], ls[i + 1])) para.push(ls[i++]);
    out.push(<p key={k}>{lines(para.join("\n"), k)}</p>);
  }
  return out;
}

export const Markdown = memo(function Markdown({ text }) {
  return <div className="md">{blocks(text)}</div>;
});
