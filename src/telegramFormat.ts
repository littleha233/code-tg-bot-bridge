// Telegram 富文本格式化（与 cc bridge 的 src/format.js 逻辑保持一致）。
//
// 背景：模型输出是标准 Markdown（**加粗**、## 标题、表格、```代码块```），Telegram 默认按
// 纯文本展示，于是群里满屏 ** ## | ``` 符号。这里把 Markdown 转成 Telegram 支持的 HTML 子集
// （<b> <i> <code> <pre> <a> <blockquote> <s>），渲染成真正的加粗/标题/代码块，接近群聊观感。
//
// 转换"尽力而为"：万一产出非法 HTML 导致 Telegram 解析失败，上层退回 stripMarkdown 纯文本，
// 保证消息一定发得出去（绝不因格式问题丢回复）。

const Z = String.fromCharCode(0); // 占位符控制字符(NUL)，正常文本不会出现

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 行内：在"已转义、已抠掉代码"的文本上套加粗/斜体/删除线/链接
function applyInline(s: string): string {
  let r = s;
  r = r.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  r = r.replace(/__(.+?)__/g, "<b>$1</b>");
  r = r.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1<i>$2</i>");
  r = r.replace(/~~(.+?)~~/g, "<s>$1</s>");
  r = r.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, t: string, u: string) => `<a href="${u.replace(/"/g, "%22")}">${t}</a>`,
  );
  return r;
}

// 去掉行内标记还原纯文字（表格单元格用，避免 HTML 标签破坏等宽对齐）
function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, "$1")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1$2");
}

// 显示宽度：CJK / 全角算 2，其余算 1
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(
      ch,
    )
      ? 2
      : 1;
  }
  return w;
}
function padTo(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - displayWidth(s)));
}

function isTableDivider(line: string | undefined): boolean {
  return (
    typeof line === "string" &&
    line.includes("|") &&
    /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)
  );
}
function isTableRow(line: string | undefined): boolean {
  return typeof line === "string" && line.includes("|") && line.trim().length > 0;
}
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => stripInline(c.trim()));
}
function renderTable(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    widths[c] = Math.max(...rows.map((r) => displayWidth(r[c] || "")));
  }
  const line = (r: string[]): string =>
    r
      .map((cell, c) => padTo(cell || "", widths[c]))
      .join("  ")
      .replace(/\s+$/, "");
  const head = line(rows[0]);
  const sep = widths.map((w) => "─".repeat(w)).join("  ");
  const body = rows.slice(1).map(line);
  return `${Z}T${Z}<pre>${[head, sep, ...body].join("\n")}</pre>${Z}T${Z}`;
}

/** 把 Markdown 转成 Telegram HTML 子集字符串 */
export function mdToTelegramHtml(md: string): string {
  if (!md) return "";
  let text = String(md).replace(/\r\n/g, "\n");

  const blocks: string[] = [];
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const l = (lang || "").trim();
    const inner = escapeHtml(code.replace(/\n+$/, ""));
    const html = l
      ? `<pre><code class="language-${escapeHtml(l)}">${inner}</code></pre>`
      : `<pre>${inner}</pre>`;
    blocks.push(html);
    return `${Z}B${blocks.length - 1}${Z}`;
  });

  const codes: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${Z}C${codes.length - 1}${Z}`;
  });

  text = escapeHtml(text);

  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (isTableRow(line) && isTableDivider(lines[i + 1])) {
      const rows = [splitRow(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]) && !isTableDivider(lines[i])) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      out.push(renderTable(rows));
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push("──────────");
      continue;
    }

    const h = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<b>${applyInline(h[2].trim())}</b>`);
      continue;
    }

    const q = line.match(/^\s{0,3}&gt;\s?(.*)$/);
    if (q) {
      out.push(`<blockquote>${applyInline(q[1])}</blockquote>`);
      continue;
    }

    const ul = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (ul) {
      out.push(`${ul[1]}• ${applyInline(ul[2])}`);
      continue;
    }

    const ol = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ol) {
      out.push(`${ol[1]}${ol[2]}. ${applyInline(ol[3])}`);
      continue;
    }

    out.push(applyInline(line));
  }
  text = out.join("\n");

  text = text.replace(/<\/blockquote>\n<blockquote>/g, "\n");
  text = text.replace(new RegExp(`${Z}T${Z}`, "g"), "");

  text = text.replace(new RegExp(`${Z}C(\\d+)${Z}`, "g"), (_m, n: string) => codes[Number(n)] ?? "");
  text = text.replace(new RegExp(`${Z}B(\\d+)${Z}`, "g"), (_m, n: string) => blocks[Number(n)] ?? "");

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** 纯文本兜底：去掉 Markdown 标记，HTML 发送失败时退回它 */
export function stripMarkdown(md: string): string {
  if (!md) return "";
  let t = String(md).replace(/\r\n/g, "\n");
  t = t.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_m, code: string) => code.replace(/\n+$/, ""));
  t = t.replace(/`([^`\n]+)`/g, "$1");
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1");
  t = t.replace(/~~(.+?)~~/g, "$1");
  t = t.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\*)/g, "$1$2");
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1（$2）");
  t = t.replace(/^\s*([-*_])\1{2,}\s*$/gm, "──────────");
  t = t.replace(/^(\s*)[-*+]\s+/gm, "$1• ");
  t = t.replace(/^\s{0,3}&gt;\s?/gm, "▏ ").replace(/^\s{0,3}>\s?/gm, "▏ ");
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

/** 按行切分，单条不超过 limit；超长单行硬切 */
export function chunkByLine(text: string, limit = 3500): string[] {
  const chunks: string[] = [];
  let buf = "";
  for (const line of String(text).split("\n")) {
    if (buf.length + line.length + 1 > limit) {
      if (buf) chunks.push(buf);
      if (line.length > limit) {
        for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
        buf = "";
      } else {
        buf = line;
      }
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length ? chunks : [""];
}
