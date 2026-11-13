/* ============================================================
   MarkWrite — 编辑器引擎（块级所见即所得）
   - 文档被切成 block，光标所在块显示 Markdown 源文本，其余块渲染排版
   - 输入过程中不重建 DOM，因此光标绝对稳定
   ============================================================ */
(function () {
  'use strict';

  var ZWSP = '\u200b';
  var SLOT = '\u0000';
  var __slots = [];

  var editor = document.getElementById('editor');
  var scroller = document.getElementById('scroller');
  var pageEl = document.getElementById('page');

  // 鼠标按下到松开之间不切块：这段可能是拖动选文本，切块会重建 DOM 把选区冲掉
  var pointerDown = false;
  var dragMoved = false;
  var suppressClick = false;
  var downX = 0;
  var downY = 0;

  var S = {
    blocks: [],
    activeId: null,
    seq: 0,
    mode: 'wysiwyg',
    theme: 'github',
    docDir: '',
    switching: false,
    lastImageCtx: null
  };

  /* ---------------- 基础工具 ---------------- */

  function nextId() { return 'b' + (++S.seq); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function slot(html) { __slots.push(html); return SLOT + (__slots.length - 1) + SLOT; }

  function post(msg) {
    try {
      if (window.chrome && chrome.webview) chrome.webview.postMessage(msg);
    } catch (e) { /* ignore */ }
  }

  function hasFocus() { return document.hasFocus(); }

  /* ---------------- 路径处理 ---------------- */

  function absPath(p) {
    if (!p) return '';
    if (/^[A-Za-z]:[\\/]/.test(p) || p.charAt(0) === '/' || p.slice(0, 5).toLowerCase() === 'file:') return p;
    var dir = S.docDir || '';
    if (!dir) return p;
    var sep = dir.indexOf('\\') >= 0 ? '\\' : '/';
    var rel = p.replace(/^\.\//, '').replace(/^\.\.\//, '../');
    rel = rel.split('/').join(sep);
    if (sep === '\\') rel = rel.split('\\').join(sep);
    return dir.replace(/[\\/]$/, '') + sep + rel;
  }

  function resolveImg(p) {
    if (!p) return '';
    if (/^(https?:|data:|mw-img:)/i.test(p)) return p;
    var abs = absPath(p);
    if (/^file:/i.test(abs)) return abs;
    return 'mw-img://local/' + encodeURIComponent(abs);
  }

  function splitDest(d) {
    d = String(d || '').trim();
    var title = '';
    var mt = d.match(/^(.*?)\s+["']([^"']*)["']\s*$/);
    if (mt) { d = mt[1]; title = mt[2]; }
    d = d.replace(/^</, '').replace(/>$/, '');
    return { url: d.trim(), title: title };
  }

  /* ---------------- 行内渲染 ---------------- */

  function renderInline(text) {
    __slots = [];
    var s = String(text == null ? '' : text);

    // 1. 反斜杠转义
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~=><$|])/g, function (_, c) { return slot(esc(c)); });

    // 2. 行内代码
    s = s.replace(/(`+)([\s\S]*?)\1/g, function (_, tick, code) {
      var body = code;
      if (body.length > 1 && body.charAt(0) === ' ' && body.charAt(body.length - 1) === ' ') body = body.slice(1, -1);
      return slot('<code class="inline">' + esc(body) + '</code>');
    });

    // 3. 行内公式
    s = s.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, function (m, pre, tex) {
      var html;
      try { html = katex.renderToString(tex, { displayMode: false, throwOnError: false }); }
      catch (e) { return m; }
      return pre + slot(html);
    });

    // 4. 图片
    s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, function (_, alt, dest) {
      var sp = splitDest(dest);
      if (!sp.url) return slot(esc(alt));
      return slot('<img src="' + esc(resolveImg(sp.url)) + '" alt="' + esc(alt) + '"' +
        (sp.title ? ' title="' + esc(sp.title) + '"' : '') + '>');
    });

    // 5. 链接
    s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, function (_, txt, dest) {
      var sp = splitDest(dest);
      return slot('<a data-href="' + esc(sp.url) + '" href="' + esc(sp.url) + '"' +
        (sp.title ? ' title="' + esc(sp.title) + '"' : '') + '>' + esc(txt) + '</a>');
    });

    // 6. 自动链接 <http://...>
    s = s.replace(/<((?:https?|mailto):[^>\s]+)>/g, function (_, url) {
      return slot('<a data-href="' + esc(url) + '" href="' + esc(url) + '">' + esc(url) + '</a>');
    });

    // 7. 转义剩余纯文本
    s = esc(s);

    // 8. 强调（此时只剩纯文本 + 占位符）
    s = s.replace(/\*\*\*([\s\S]*?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*([\s\S]*?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([\s\S]*?)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([\s\S]*?)~~/g, '<del>$1</del>');
    s = s.replace(/==([\s\S]*?)==/g, '<mark>$1</mark>');
    s = s.replace(/(^|[^*])\*([^*\s][\s\S]*?)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_A-Za-z0-9])_([^_\s][\s\S]*?)_(?!_)/g, '$1<em>$2</em>');

    // 9. 还原占位符
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return __slots[+i] || ''; });
    return s;
  }

  function renderInlineLines(raw) {
    return String(raw == null ? '' : raw).split('\n').map(renderInline).join('<br>');
  }

  /* ---------------- 块解析 ---------------- */

  function isTableSep(l) {
    var t = String(l || '').trim();
    if (t.indexOf('|') < 0 || t.indexOf('-') < 0) return false;
    return /^\|?[\s:|-]+\|?$/.test(t);
  }

  function isTableRow(l) { return String(l || '').indexOf('|') >= 0; }

  function looksLikeTable(raw) {
    var ls = String(raw || '').split('\n');
    if (ls.length < 2) return false;
    return isTableRow(ls[0]) && isTableSep(ls[1]);
  }

  function isBlockStart(l) {
    if (/^\s*(`{3,}|~{3,})/.test(l)) return true;
    if (/^\s*\$\$\s*$/.test(l)) return true;
    if (/^\s{0,3}#{1,6}(\s|$)/.test(l)) return true;
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(l) && !isTableSep(l)) return true;
    if (/^\s{0,3}>/.test(l)) return true;
    if (/^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(l)) return true;
    return false;
  }

  function splitFence(raw) {
    var lines = String(raw || '').split('\n');
    var first = lines[0] || '';
    var fm = first.match(/^\s*(`{3,}|~{3,})(.*)$/);
    var fence = fm ? fm[1] : '```';
    var lang = fm ? fm[2].trim() : '';
    var body = lines.slice(1);
    var last = body.slice(-1)[0];
    if (last != null && /^\s*(`{3,}|~{3,})\s*$/.test(last)) body = body.slice(0, -1);
    return { fence: fence, lang: lang, body: body.join('\n') };
  }

  function parseBlocks(text) {
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    var lines = src.split('\n');
    var out = [];
    var i = 0, n = lines.length;
    while (i < n) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }

      // 围栏代码块
      var fm = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fm) {
        var fence = fm[1], body = [];
        i++;
        while (i < n) {
          var cm = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
          if (cm && cm[1].charAt(0) === fence.charAt(0) && cm[1].length >= fence.length) { i++; break; }
          body.push(lines[i]); i++;
        }
        out.push({ raw: fence + fm[2] + '\n' + body.join('\n') + '\n' + fence });
        continue;
      }

      // 独立公式
      if (/^\s*\$\$\s*$/.test(line)) {
        var mb = [];
        i++;
        while (i < n && !/^\s*\$\$\s*$/.test(lines[i])) { mb.push(lines[i]); i++; }
        if (i < n) i++;
        out.push({ raw: '$$\n' + mb.join('\n') + '\n$$' });
        continue;
      }

      // 表格
      if (isTableRow(line) && i + 1 < n && isTableSep(lines[i + 1])) {
        var rows = [line, lines[i + 1]];
        i += 2;
        while (i < n && isTableRow(lines[i]) && !/^\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
        out.push({ raw: rows.join('\n') });
        continue;
      }

      // 标题
      if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
        out.push({ raw: line.trim() }); i++; continue;
      }

      // 分隔线
      if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line) && !isTableSep(line)) {
        out.push({ raw: line.trim() }); i++; continue;
      }

      // 引用
      if (/^\s{0,3}>/.test(line)) {
        var qb = [];
        while (i < n && !/^\s*$/.test(lines[i]) &&
          (/^\s{0,3}>/.test(lines[i]) || (qb.length > 0 && !isBlockStart(lines[i])))) {
          qb.push(lines[i]); i++;
        }
        out.push({ raw: qb.join('\n') });
        continue;
      }

      // 列表
      if (/^\s{0,3}([-*+]|\d{1,9}[.)])(\s|$)/.test(line)) {
        var lb = [];
        while (i < n) {
          var l = lines[i];
          if (/^\s*$/.test(l)) {
            var nx = lines[i + 1];
            if (nx != null && (/^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(nx) || /^\s{2,}/.test(nx))) { lb.push(''); i++; continue; }
            break;
          }
          if (/^\s{0,3}([-*+]|\d{1,9}[.)])\s/.test(l) || /^\s{2,}/.test(l)) { lb.push(l); i++; continue; }
          break;
        }
        out.push({ raw: lb.join('\n') });
        continue;
      }

      // 段落
      var pb = [];
      while (i < n) {
        var pl = lines[i];
        if (/^\s*$/.test(pl)) break;
        if (pb.length > 0 && isBlockStart(pl)) break;
        if (pb.length > 0 && isTableRow(pl) && i + 1 < n && isTableSep(lines[i + 1])) break;
        pb.push(pl); i++;
      }
      if (pb.length === 0) { i++; continue; }
      out.push({ raw: pb.join('\n') });
    }
    return out;
  }

  function typeOf(raw) {
    var t = String(raw || '').replace(/\r/g, '').trim();
    if (!t) return 'paragraph';
    var f = t.match(/^(```|~~~)([^\n]*)/);
    if (f) {
      var lang = (f[2] || '').split('\n')[0].trim().split(/\s+/)[0];
      return (/^mermaid$/i.test(lang)) ? 'mermaid' : 'code';
    }
    if (t.slice(0, 2) === '$$') return 'math';
    var h = t.match(/^(#{1,6})(\s|$)/);
    if (h) return 'heading' + h[1].length;
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) return 'hr';
    if (/^>/.test(t)) return 'quote';
    if (/^([-*+]|\d{1,9}[.)])(\s|$)/.test(t)) return 'list';
    if (looksLikeTable(t)) return 'table';
    return 'paragraph';
  }

  /* ---------------- 块 HTML ---------------- */

  function splitFenceBody(raw) { return splitFence(raw); }

  function renderQuote(raw) {
    var lines = String(raw).split('\n').map(function (l) { return l.replace(/^\s{0,3}>\s?/, ''); });
    var groups = [], cur = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\s*$/.test(lines[i])) { if (cur.length) { groups.push(cur); cur = []; } }
      else cur.push(lines[i]);
    }
    if (cur.length) groups.push(cur);
    var html = groups.map(function (g) {
      if (/^\s*([-*+]|\d{1,9}[.)])\s/.test(g[0])) return renderList(g.join('\n'));
      return '<p>' + renderInlineLines(g.join('\n')) + '</p>';
    }).join('');
    return '<blockquote>' + html + '</blockquote>';
  }

  function renderList(raw) {
    var items = [];
    var lines = String(raw).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^\s*$/.test(line)) continue;
      var m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
      if (!m) {
        if (items.length) {
          var last = items[items.length - 1];
          last.text += (last.text ? '\n' : '') + line.replace(/^\s{2,}/, '').trim();
        }
        continue;
      }
      var indent = m[1].replace(/\t/g, '  ').length;
      var ordered = /\d/.test(m[2]);
      items.push({
        level: Math.floor(indent / 2),
        ordered: ordered,
        num: ordered ? (parseInt(m[2], 10) || 1) : 1,
        text: m[3]
      });
    }
    if (!items.length) return renderInlineLines(raw);

    var html = '';
    var stack = [];
    function closeList() { var t = stack.pop(); html += '</' + (t.ordered ? 'ol' : 'ul') + '>'; }
    function openList(ordered, level, num) {
      var tag = ordered ? 'ol' : 'ul';
      html += '<' + tag + (ordered && num > 1 ? ' start="' + num + '"' : '') + '>';
      stack.push({ ordered: ordered, level: level });
    }

    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (!stack.length) {
        openList(it.ordered, it.level, it.num);
      } else {
        var top = stack[stack.length - 1];
        if (it.level > top.level) {
          openList(it.ordered, it.level, it.num);
        } else if (it.level < top.level) {
          while (stack.length && it.level < stack[stack.length - 1].level) closeList();
          if (!stack.length) openList(it.ordered, it.level, it.num);
        } else if (it.ordered !== top.ordered) {
          closeList(); openList(it.ordered, it.level, it.num);
        }
      }
      var taskM = it.text.match(/^\[([ xX])\]\s*(.*)$/);
      if (taskM) {
        html += '<li class="task"><input type="checkbox" disabled' + (/x/i.test(taskM[1]) ? ' checked' : '') + '>' +
          renderInline(taskM[2]) + '</li>';
      } else {
        html += '<li>' + renderInlineLines(it.text) + '</li>';
      }
    }
    while (stack.length) closeList();
    return html;
  }

  function renderCode(raw) {
    var sp = splitFenceBody(raw);
    var lang = (sp.lang || '').split(/\s+/)[0] || '';
    var body = sp.body;
    var key = lang.toLowerCase();
    var html;
    if (key && window.hljs && hljs.getLanguage && hljs.getLanguage(key)) {
      try { html = hljs.highlight(body, { language: key, ignoreIllegals: true }).value; }
      catch (e) { html = esc(body); }
    } else {
      html = esc(body);
    }
    return '<pre><code class="hljs' + (key ? ' language-' + esc(key) : '') + '">' + html + '</code>' +
      '<span class="code-lang" contenteditable="false">' + esc(lang || 'text') + '</span></pre>';
  }

  function cellSplit(l) {
    var s = String(l).trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|' && s.slice(-2, -1) !== '\\') s = s.slice(0, -1);
    return s.split(/(?<!\\)\|/).map(function (c) {
      return c.trim().replace(/\\\|/g, '|');
    });
  }

  function renderTable(raw) {
    var rows = String(raw).split('\n').filter(function (l) { return l.trim().length > 0; });
    if (rows.length < 2) return renderInlineLines(raw);
    var head = cellSplit(rows[0]);
    var aligns = cellSplit(rows[1]).map(function (c) {
      var l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      return (l && r) ? 'center' : (r ? 'right' : (l ? 'left' : ''));
    });
    var th = head.map(function (c, i) {
      return '<th' + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '') + '>' + renderInline(c) + '</th>';
    }).join('');
    var trs = rows.slice(2).map(function (r) {
      var cells = cellSplit(r);
      while (cells.length < head.length) cells.push('');
      return '<tr>' + head.map(function (_, i) {
        return '<td' + (aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '') + '>' + renderInline(cells[i] || '') + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<table><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table>';
  }

  function renderMath(raw) {
    var body = String(raw).replace(/^\s*\$\$\s*\n?/, '').replace(/\n?\s*\$\$\s*$/, '');
    body = body.replace(/^\s*\$\$/, '').replace(/\$\$\s*$/, '');
    try { return katex.renderToString(body.trim(), { displayMode: true, throwOnError: false }); }
    catch (e) { return '<pre><code>' + esc(raw) + '</code></pre>'; }
  }

  function renderMermaidPlaceholder(raw) {
    var sp = splitFenceBody(raw);
    return '<div class="mermaid-render" data-code="' + encodeURIComponent(sp.body) + '"></div>';
  }

  function blockHTML(b) {
    var raw = b.raw;
    switch (b.type) {
      case 'paragraph': return renderInlineLines(raw);
      case 'heading1': case 'heading2': case 'heading3':
      case 'heading4': case 'heading5': case 'heading6':
        return renderInline(String(raw).replace(/^\s{0,3}#{1,6}\s*/, ''));
      case 'hr': return '<hr>';
      case 'quote': return renderQuote(raw);
      case 'list': return renderList(raw);
      case 'code': return renderCode(raw);
      case 'table': return renderTable(raw);
      case 'math': return renderMath(raw);
      case 'mermaid': return renderMermaidPlaceholder(raw);
      default: return renderInlineLines(raw);
    }
  }

  /* ---------------- Mermaid ---------------- */

  var mq = [], mb = false;

  function queueMermaid(el, code) {
    if (!window.mermaid) {
      el.innerHTML = '<pre><code>' + esc(code) + '</code></pre>';
      return;
    }
    mq.push({ el: el, code: code });
    if (!mb) setTimeout(pumpMermaid, 0);
  }

  async function pumpMermaid() {
    if (mb) return;
    mb = true;
    while (mq.length) {
      var job = mq.shift();
      if (!job.el) continue;
      var id = 'mmd' + Math.random().toString(36).slice(2, 9);
      try {
        var res = await mermaid.render(id, job.code);
        job.el.innerHTML = res.svg;
      } catch (err) {
        job.el.innerHTML = '<div class="mermaid-err">Mermaid 渲染失败\n' +
          esc(String((err && err.message) || err)) + '</div>';
      }
    }
    mb = false;
  }

  /* ---------------- DOM 与状态 ---------------- */

  function elOf(id) {
    if (!id) return null;
    return editor.querySelector('.blk[data-id="' + id + '"]');
  }

  function blockOf(id) {
    for (var i = 0; i < S.blocks.length; i++) if (S.blocks[i].id === id) return S.blocks[i];
    return null;
  }

  function indexOfBlock(id) {
    for (var i = 0; i < S.blocks.length; i++) if (S.blocks[i].id === id) return i;
    return -1;
  }

  function readRaw(el) {
    if (!el) return '';
    // 代码块：DOM 里只有正文（语言在标签上），围栏要按语言重建回来。
    // 不看 data-state —— 渲染态也走这条，免得把语言标签的字当成正文读进去。
    if (el.dataset && el.dataset.type === 'code') {
      var codeEl = el.querySelector('pre > code');
      if (codeEl) {
        var lang = codeEl.getAttribute('data-lang');
        if (lang == null) {
          var sp = el.querySelector('.code-lang');
          lang = sp ? (sp.textContent || '').trim() : '';
          if (lang === 'text') lang = '';
        }
        var body = (codeEl.textContent || '').split(ZWSP).join('');
        return '```' + lang + '\n' + body + '\n```';
      }
    }
    var t = el.textContent || '';
    if (t === ZWSP) return '';
    return t.split(ZWSP).join('');
  }

  function renderBlock(el, b) {
    if (!el) return;
    el.dataset.type = b.type;
    el.dataset.state = 'rendered';
    el.classList.remove('src');
    el.innerHTML = blockHTML(b);
    var mm = el.querySelector('.mermaid-render');
    if (mm) queueMermaid(mm, decodeURIComponent(mm.getAttribute('data-code') || ''));
  }

  function makeBlockEl(b) {
    var el = document.createElement('div');
    el.className = 'blk';
    el.dataset.id = b.id;
    return el;
  }

  /* ---------------- 光标工具 ---------------- */

  function collectTextNodes(el) {
    var out = [];
    var w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = w.nextNode())) out.push(node);
    return out;
  }

  function caretAt(el, offset) {
    var sel = window.getSelection();
    if (!sel) return;
    var range = document.createRange();
    var nodes = collectTextNodes(el);
    if (!nodes.length) {
      range.setStart(el, 0);
    } else {
      var acc = 0, target = null, tOff = 0;
      for (var i = 0; i < nodes.length; i++) {
        var len = nodes[i].nodeValue.length;
        if (acc + len >= offset) { target = nodes[i]; tOff = offset - acc; break; }
        acc += len;
      }
      if (!target) { target = nodes[nodes.length - 1]; tOff = target.nodeValue.length; }
      range.setStart(target, Math.max(0, Math.min(tOff, target.nodeValue.length)));
    }
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function caretOffsetInSource(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    var r = sel.getRangeAt(0);
    if (!el.contains(r.endContainer) && r.endContainer !== el) return 0;
    var rr = document.createRange();
    rr.setStart(el, 0);
    rr.setEnd(r.endContainer, r.endOffset);
    return rr.toString().split(ZWSP).join('').length;
  }

  function mapVisibleToRaw(raw, target) {
    var i = 0, v = 0, lineStart = true;
    var n = raw.length;
    function skipParen(idx) {
      var depth = 1, j = idx + 1;
      while (j < n && depth > 0) {
        if (raw.charAt(j) === '(') depth++;
        else if (raw.charAt(j) === ')') depth--;
        j++;
      }
      return j;
    }
    while (i < n) {
      if (v >= target) return i;
      var c = raw.charAt(i);
      if (lineStart) {
        var rest = raw.slice(i);
        var m = rest.match(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/);
        if (m) { i += m[0].length; lineStart = false; continue; }
        var lead = rest.match(/^[ \t]+/);
        if (lead) { i += lead[0].length; continue; }
        lineStart = false;
      }
      if (c === '\\') { i += 2; v++; continue; }
      if (c === '\n') { i++; v++; lineStart = true; continue; }
      if (c === '`' || c === '*' || c === '_' || c === '~' || c === '=' || c === '|' || c === '$' || c === '!') { i++; continue; }
      if (c === '[') { i++; continue; }
      if (c === ']') {
        if (raw.charAt(i + 1) === '(') { i = skipParen(i + 1); continue; }
        i++; continue;
      }
      i++; v++;
    }
    return n;
  }

  function caretRenderedOffset(el, raw) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return raw.length;
    var r = sel.getRangeAt(0);
    if (!el.contains(r.endContainer) && r.endContainer !== el) return raw.length;
    var rr = document.createRange();
    rr.setStart(el, 0);
    rr.setEnd(r.endContainer, r.endOffset);
    var vis = rr.toString().length;
    return mapVisibleToRaw(raw, vis);
  }

  /* ---------------- 块状态切换 ---------------- */

  function enterSource(id, offset) {
    var el = elOf(id);
    var b = blockOf(id);
    if (!el || !b) return;
    if (S.mode !== 'source' && b.type === 'code') {
      // 代码块走"只编辑内容"的路径：代码框和语言标签都保持不变
      enterCodeEdit(id, caretVisibleIn(el));
      return;
    }
    if (el.dataset.state === 'source') {
      if (offset != null) caretAt(el, offset);
      return;
    }
    el.dataset.state = 'source';
    el.classList.add('src');
    el.dataset.type = b.type;
    el.innerHTML = '';
    el.appendChild(document.createTextNode(b.raw && b.raw.length ? b.raw : ZWSP));
    if (offset != null) caretAt(el, offset);
  }

  /* ---------------- 代码块内联编辑 ---------------- */

  function caretVisibleIn(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return 0;
    var r = sel.getRangeAt(0);
    if (!el.contains(r.endContainer) && r.endContainer !== el) return 0;
    var rr = document.createRange();
    rr.setStart(el, 0);
    rr.setEnd(r.endContainer, r.endOffset);
    return rr.toString().split(ZWSP).join('').length;
  }

  function codeParts(raw) {
    var sp = splitFenceBody(raw);
    return { lang: (sp.lang || '').split(/\s+/)[0] || '', body: sp.body };
  }

  /* 进代码块编辑态：保留 <pre> 框与语言标签，只把正文换成纯文本 */
  function enterCodeEdit(id, bodyOffset) {
    var el = elOf(id);
    var b = blockOf(id);
    if (!el || !b) return;
    if (el.dataset.state === 'source' && el.querySelector('pre > code')) {
      if (bodyOffset != null) caretAt(el, bodyOffset);
      return;
    }
    var p = codeParts(b.raw);
    el.dataset.state = 'source';
    el.classList.add('src');
    el.dataset.type = 'code';
    el.innerHTML = '<pre><code class="code-edit" data-lang="' + esc(p.lang) + '">' + esc(p.body) + '</code>' +
      '<span class="code-lang" contenteditable="false">' + esc(p.lang || 'text') + '</span></pre>';
    if (bodyOffset != null) caretAt(el, bodyOffset);
  }

  /* 改语言：只动围栏首行的语言，正文原样保留 */
  function setBlockLang(id, lang) {
    var b = blockOf(id);
    if (!b) return;
    var p = codeParts(b.raw);
    b.raw = '```' + (lang || '') + '\n' + p.body + '\n```';
    b.type = typeOf(b.raw);
    var el = elOf(id);
    if (el) {
      if (el.dataset.state === 'source') {
        var codeEl = el.querySelector('pre > code');
        var span = el.querySelector('.code-lang');
        if (codeEl) codeEl.setAttribute('data-lang', lang || '');
        if (span) { span.textContent = lang || 'text'; span.style.display = ''; }
      } else {
        renderBlock(el, b);
      }
    }
    notifyChange();
    postStatsOnly();
  }

  var langEditing = false;
  function isLangInput(el) {
    return !!(el && el.classList && el.classList.contains('code-lang-input'));
  }

  /* 右下角悬浮输入框：点语言标签就变成可输入的小框。
     延迟一拍再插进去 —— 点标签本身会触发 selectionchange 把块重建成编辑态，
     立刻插入的话 input 会连块一起被 innerHTML 重建掉。 */
  function openLangEditor(blkId) {
    if (editor.querySelector('.code-lang-input')) return;
    var blk = elOf(blkId);
    if (!blk || !blockOf(blkId)) return;
    var pre = blk.querySelector('pre');
    var spanEl = blk.querySelector('.code-lang');
    if (!pre || !spanEl) return;
    var codeEl = pre.querySelector('code');
    var cur = codeEl ? (codeEl.getAttribute('data-lang') || '') : '';
    if (!cur) {
      // 渲染态的 code 上没有 data-lang，从右下角标签文字里取
      cur = (spanEl.textContent || '').trim();
      if (cur === 'text') cur = '';
    }
    var editing = blk.dataset.state === 'source';
    var saved = editing ? caretVisibleIn(blk) : null;

    var inp = document.createElement('input');
    inp.className = 'code-lang-input';
    inp.value = cur;
    inp.placeholder = '语言';
    spanEl.style.display = 'none';
    pre.appendChild(inp);
    langEditing = true;

    var done = false;
    function finish(apply) {
      if (done) return;
      done = true;
      langEditing = false;
      var v = inp.value.trim().replace(/[`~\s]/g, '');
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (spanEl.parentNode) spanEl.style.display = '';
      if (apply && v !== cur) setBlockLang(blkId, v);
      if (editing && saved != null) {
        var el = elOf(blkId);
        if (el && el.dataset.state === 'source') caretAt(el, saved);
      }
    }
    inp.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    });
    inp.addEventListener('blur', function () { finish(true); });
    setTimeout(function () { inp.focus(); inp.select(); }, 0);
  }

  function toRendered(id) {
    var el = elOf(id);
    var b = blockOf(id);
    if (!el || !b) return;
    b.raw = readRaw(el);
    b.type = typeOf(b.raw);
    renderBlock(el, b);
  }

  function activeBlock() {
    if (!S.activeId) return null;
    return blockOf(S.activeId);
  }

  function ensureActiveSource() {
    var b = activeBlock();
    if (!b) return null;
    var el = elOf(b.id);
    if (el && el.dataset.state !== 'source') enterSource(b.id, caretRenderedOffset(el, b.raw));
    return b;
  }

  /* ---------------- 文档构建 ---------------- */

  function buildAll(md, opts) {
    opts = opts || {};
    var parsed = parseBlocks(md || '');
    if (!parsed.length) parsed = [{ raw: '' }];
    S.blocks = parsed.map(function (p) { return { id: nextId(), raw: p.raw, type: typeOf(p.raw) }; });
    editor.innerHTML = '';
    for (var i = 0; i < S.blocks.length; i++) {
      var el = makeBlockEl(S.blocks[i]);
      renderBlock(el, S.blocks[i]);
      editor.appendChild(el);
    }
    S.activeId = null;
    if (opts.scrollRatio != null) {
      var ratio = opts.scrollRatio;
      requestAnimationFrame(function () {
        var max = scroller.scrollHeight - scroller.clientHeight;
        scroller.scrollTop = Math.max(0, max * ratio);
      });
    }
    if (opts.focus) {
      requestAnimationFrame(function () {
        var last = S.blocks[S.blocks.length - 1];
        if (last) { S.activeId = last.id; enterSource(last.id, last.raw.length); }
      });
    }
  }

  function buildSourceAll(md) {
    editor.innerHTML = '';
    var b = { id: nextId(), raw: '', type: 'paragraph' };
    S.blocks = [b];
    var el = makeBlockEl(b);
    el.dataset.type = 'paragraph';
    el.dataset.state = 'source';
    el.classList.add('src');
    el.textContent = (md && md.length) ? md : ZWSP;
    editor.appendChild(el);
    S.activeId = b.id;
    b.raw = md || '';
  }

  function toMarkdown() {
    if (S.mode === 'source') {
      var only = editor.firstElementChild;
      return only ? readRaw(only) : '';
    }
    var parts = [];
    for (var i = 0; i < S.blocks.length; i++) {
      var b = S.blocks[i];
      var el = elOf(b.id);
      if (el && el.dataset.state === 'source') b.raw = readRaw(el);
      if (b.raw && b.raw.length) parts.push(b.raw);
    }
    return parts.join('\n\n');
  }

  /* ---------------- 变更同步 ---------------- */

  var syncTimer = null;

  function computeStats(md) {
    var chars = md.replace(/\s/g, '').length;
    var lines = md.split('\n').length;
    var cjk = (md.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    var wordsEn = (md.match(/[A-Za-z0-9_'-]+/g) || []).length;
    return { chars: chars, lines: lines, words: wordsEn + cjk, cjk: cjk, wordsEn: wordsEn };
  }

  function buildOutline() {
    var out = [];
    for (var i = 0; i < S.blocks.length; i++) {
      var b = S.blocks[i];
      if (!/^heading[1-6]$/.test(b.type)) continue;
      var el = elOf(b.id);
      var raw = (el && el.dataset.state === 'source') ? readRaw(el) : b.raw;
      var m = raw.match(/^(#{1,6})\s*(.*)$/);
      if (!m) continue;
      var text = m[2].replace(/[*_`~=]|\[|\]|\(|\)/g, '').trim();
      out.push({ level: m[1].length, text: text || '(空标题)', id: b.id });
    }
    return out;
  }

  function notifyChange() {
    if (syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      var md = toMarkdown();
      post({ type: 'change', md: md, outline: buildOutline(), stats: computeStats(md) });
    }, 160);
  }

  /* ---------------- 文本插入 ---------------- */

  function insertText(str) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    r.deleteContents();
    var tn = document.createTextNode(str);
    r.insertNode(tn);
    var r2 = document.createRange();
    r2.setStart(tn, str.length);
    r2.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r2);
  }

  function wrapSelection(mark) {
    var b = ensureActiveSource();
    if (!b) return;
    var el = elOf(b.id);
    if (!el) return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    var raw = readRaw(el);
    var rr = document.createRange();
    rr.setStart(el, 0);
    rr.setEnd(r.startContainer, r.startOffset);
    var off1 = rr.toString().split(ZWSP).join('').length;
    rr.setEnd(r.endContainer, r.endOffset);
    var off2 = rr.toString().split(ZWSP).join('').length;
    var newRaw = raw.slice(0, off1) + mark + raw.slice(off1, off2) + mark + raw.slice(off2);
    el.textContent = newRaw && newRaw.length ? newRaw : ZWSP;
    b.raw = newRaw;
    caretAt(el, off2 + mark.length * 2);
    notifyChange();
  }

  /* ---------------- 块拆分 / 合并 ---------------- */

  function lineAt(raw, off) {
    var start = raw.lastIndexOf('\n', off - 1) + 1;
    var end = raw.indexOf('\n', off);
    if (end < 0) end = raw.length;
    return raw.slice(start, end);
  }

  function linePrefixOf(raw, off) {
    var line = lineAt(raw, off);
    var m = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+/);
    if (m) {
      if (/\d/.test(m[2])) {
        var num = parseInt(m[2], 10) + 1;
        return m[1] + num + '. ';
      }
      return m[1] + m[2] + ' ';
    }
    return '';
  }

  function splitBlock() {
    var b = ensureActiveSource();
    if (!b) return;
    var el = elOf(b.id);
    if (!el) return;
    var raw = readRaw(el);
    var off = Math.max(0, Math.min(caretOffsetInSource(el), raw.length));
    var head = raw.slice(0, off);
    var tail = raw.slice(off);

    var prefix = '';
    if (b.type === 'list') prefix = linePrefixOf(raw, off);
    else if (b.type === 'quote') prefix = '> ';
    else if (/^heading/.test(b.type)) prefix = '';

    var headType = typeOf(head);
    b.raw = head;
    b.type = headType;
    renderBlock(el, b);

    var nb = { id: nextId(), raw: prefix + tail, type: typeOf(prefix + tail) };
    var idx = indexOfBlock(b.id);
    S.blocks.splice(idx + 1, 0, nb);
    var nel = makeBlockEl(nb);
    renderBlock(nel, nb);
    el.parentNode.insertBefore(nel, el.nextSibling);
    S.activeId = nb.id;
    enterSource(nb.id, prefix.length);
    notifyChange();
    post({ type: 'outlineNow', outline: buildOutline() });
  }

  var MERGE_SKIP = { code: 1, table: 1, math: 1, mermaid: 1, hr: 1 };

  function mergeBack() {
    var b = ensureActiveSource();
    if (!b) return false;
    var el = elOf(b.id);
    var idx = indexOfBlock(b.id);
    if (!el || idx <= 0) return false;
    var prev = S.blocks[idx - 1];
    if (MERGE_SKIP[prev.type] || MERGE_SKIP[b.type]) return false;
    var prevEl = elOf(prev.id);
    var prevRaw = prev.raw;
    var curRaw = readRaw(el);
    prev.raw = prevRaw + curRaw;
    prev.type = typeOf(prev.raw);
    renderBlock(prevEl, prev);
    removeBlockAt(idx);
    S.activeId = prev.id;
    enterSource(prev.id, prevRaw.length);
    notifyChange();
    return true;
  }

  function removeBlockAt(idx) {
    var b = S.blocks[idx];
    if (!b) return;
    var el = elOf(b.id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    S.blocks.splice(idx, 1);
  }

  /* ---------------- 文档变更事件 ---------------- */

  function applySelection() {
    if (S.switching) return;
    if (S.mode === 'source') return;
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    // 有选区（拖动选中、双击选词、Shift+方向键）：只读场景，别把块切进源码态重建
    if (!sel.isCollapsed) return;
    var anchor = sel.anchorNode;
    if (!anchor) return;
    var host = anchor.nodeType === 1 ? anchor : anchor.parentElement;
    if (!host || !editor.contains(host)) return;
    var blk = host.closest ? host.closest('.blk') : null;
    if (!blk) {
      // 光标落在块之间的空白处：把上一个块收回渲染态，否则它会一直停在源码态
      if (S.activeId) {
        var prevEl0 = elOf(S.activeId);
        if (prevEl0 && prevEl0.dataset.state === 'source') {
          var pb0 = blockOf(S.activeId);
          if (pb0) {
            pb0.raw = readRaw(prevEl0);
            pb0.type = typeOf(pb0.raw);
            renderBlock(prevEl0, pb0);
          }
        }
        S.activeId = null;
      }
      return;
    }
    var id = blk.dataset.id;

    // 正在改代码块语言时不要把这切进编辑态：innerHTML 重建会把浮层输入框一起冲掉
    if (langEditing && blk.dataset.type === 'code') return;

    if (id === S.activeId && blk.dataset.state === 'source') return;

    S.switching = true;
    try {
      if (S.activeId && S.activeId !== id) {
        var prevEl = elOf(S.activeId);
        if (prevEl && prevEl.dataset.state === 'source') {
          var pb = blockOf(S.activeId);
          pb.raw = readRaw(prevEl);
          pb.type = typeOf(pb.raw);
          renderBlock(prevEl, pb);
        }
      }
      S.activeId = id;
      if (blk.dataset.state !== 'source') {
        var b = blockOf(id);
        if (b) enterSource(id, caretRenderedOffset(blk, b.raw));
      }
    } finally {
      S.switching = false;
    }
    post({ type: 'caretBlock', id: id });
  }

  document.addEventListener('selectionchange', function () {
    if (pointerDown) return;
    applySelection();
  });

  /* 按下先不改结构，等松开再结算：中间可能是拖动选文本 */
  editor.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    pointerDown = true;
    dragMoved = false;
    downX = e.clientX;
    downY = e.clientY;
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!pointerDown || dragMoved) return;
    if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) dragMoved = true;
  });

  document.addEventListener('mouseup', function (e) {
    if (!pointerDown) return;
    pointerDown = false;
    var moved = dragMoved;
    dragMoved = false;
    if (S.mode === 'source') return;
    // 点在代码块的语言标签上：交给语言框，别把这当一次点击编辑
    var onLang = e.target && e.target.closest ? e.target.closest('.code-lang') : null;
    if (onLang || langEditing) return;
    var sel = window.getSelection();
    if (moved || (sel && sel.rangeCount && !sel.isCollapsed)) {
      // 拖动/选中文本：所有块保持渲染态，不做任何切换（选完就能直接复制纯文本）
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 0);
      return;
    }
    applySelection();
  });

  editor.addEventListener('input', function (e) {
    // 语言小框里的键入会冒泡上来，不能当成"在编辑这个块"
    if (langEditing || isLangInput(e.target)) return;
    if (S.mode === 'source') {
      var only = editor.firstElementChild;
      if (only) {
        var b0 = S.blocks[0];
        if (b0) { b0.raw = readRaw(only); }
      }
      notifyChange();
      postStatsOnly();
      return;
    }
    var blk = e.target && e.target.closest ? e.target.closest('.blk') : null;
    if (!blk && e.target && e.target.closest) blk = e.target.closest('.blk');
    if (!blk) {
      var ae = document.activeElement;
      if (ae && ae.closest) blk = ae.closest('.blk');
    }
    if (!blk) return;
    var b = blockOf(blk.dataset.id);
    if (!b) return;
    var raw = readRaw(blk);
    b.raw = raw;
    var t = typeOf(raw);
    if (t !== b.type) {
      b.type = t;
      if (blk.dataset.state === 'source') blk.dataset.type = t;
    }
    notifyChange();
    postStatsOnly();
  });

  var statTimer = null;
  function postStatsOnly() {
    if (statTimer) return;
    statTimer = setTimeout(function () {
      statTimer = null;
      var md = toMarkdown();
      post({ type: 'stats', stats: computeStats(md) });
    }, 400);
  }

  editor.addEventListener('keydown', function (e) {
    if (langEditing || isLangInput(e.target)) return;
    if (e.isComposing || e.keyCode === 229) return;
    var ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && !e.altKey) {
      var k = (e.key || '').toLowerCase();
      if (k === 's' || k === 'o' || k === 'n' || k === 'w' || k === 'p') {
        e.preventDefault();
        post({ type: 'shortcut', key: (e.shiftKey ? 'shift+' : '') + k });
        return;
      }
      if (k === 'f') { e.preventDefault(); openFind(false); return; }
      if (k === 'h') { e.preventDefault(); openFind(true); return; }
      if (k === 'b') { e.preventDefault(); wrapSelection('**'); return; }
      if (k === 'i') { e.preventDefault(); wrapSelection('*'); return; }
      if (k === '/') { e.preventDefault(); toggleSourceMode(); return; }
      if (k === 'z' || k === 'y') {
        // 结构重建也会在原生撤销栈里留一步，那一步改了 DOM 却没改内容；
        // 这里连续执行直到内容真的变了，跳过这些空操作
        e.preventDefault();
        var isRedo = (k === 'y') || e.shiftKey;
        var before = domSnapshot();
        var guard = 0;
        do {
          if (!document.execCommand(isRedo ? 'redo' : 'undo')) break;
          guard++;
        } while (domSnapshot() === before && guard < 12);
        return;
      }
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      var at = ensureActiveSource();
      if (at) {
        var spaces = (at.type === 'code') ? '    ' : '  ';
        if (e.shiftKey) {
          var elT = elOf(at.id);
          var offT = caretOffsetInSource(elT);
          var rawT = readRaw(elT);
          var prevTwo = rawT.slice(Math.max(0, offT - 2), offT);
          if (prevTwo === '  ') {
            elT.textContent = rawT.slice(0, offT - 2) + rawT.slice(offT);
            at.raw = elT.textContent;
            caretAt(elT, offT - 2);
            notifyChange();
          }
        } else {
          insertText(spaces);
          var bT = blockOf(S.activeId);
          var elT2 = elOf(S.activeId);
          if (bT && elT2) { bT.raw = readRaw(elT2); notifyChange(); }
        }
      }
      return;
    }

    if (e.key === 'Enter') {
      var bE = ensureActiveSource();
      if (!bE) return;
      if (S.mode === 'source') { e.preventDefault(); insertText('\n'); syncSourceRaw(); return; }
      var isMulti = bE.type === 'code' || bE.type === 'math' || bE.type === 'mermaid' ||
        bE.type === 'table' || bE.type === 'list' || bE.type === 'quote';
      if (e.shiftKey) { e.preventDefault(); insertText('\n'); syncRaw(); return; }
      e.preventDefault();
      if (isMulti) {
        var pfx = '';
        if (bE.type === 'list') pfx = linePrefixOf(bE.raw, caretOffsetInSource(elOf(bE.id)));
        else if (bE.type === 'quote') pfx = '> ';
        insertText('\n' + pfx);
        syncRaw();
      } else {
        splitBlock();
      }
      return;
    }

    if (e.key === 'Backspace') {
      var bB = activeBlock();
      if (!bB) return;
      var elB = elOf(bB.id);
      if (!elB) return;
      if (elB.dataset.state !== 'source') return;
      var offB = caretOffsetInSource(elB);
      if (offB !== 0) return;
      if (mergeBack()) e.preventDefault();
      return;
    }
  });

  function syncRaw() {
    var b = activeBlock();
    var el = elOf(b && b.id);
    if (b && el) { b.raw = readRaw(el); b.type = typeOf(b.raw); notifyChange(); }
  }

  function syncSourceRaw() {
    var only = editor.firstElementChild;
    if (only && S.blocks[0]) S.blocks[0].raw = readRaw(only);
    notifyChange();
  }

  /* ---------------- 复制：给选中区域的 markdown 源码 ---------------- */

  function pointBlock(node) {
    var host = node && (node.nodeType === 1 ? node : node.parentElement);
    return host && host.closest ? host.closest('.blk') : null;
  }

  /* 选区是否覆盖这一块（分割线这类没有文字的块也算） */
  function hitsBlock(r, el) {
    var fs = el.compareDocumentPosition(r.startContainer);
    var fe = el.compareDocumentPosition(r.endContainer);
    // 选区起点在这块之后（且不是这块的祖先）→ 这块没被选到
    if ((fs & 4) && !(fs & 16)) return false;
    // 选区终点在这块之前（且不是这块的后代占位）→ 这块没被选到
    if ((fe & 2) && !(fe & 8)) return false;
    return true;
  }

  /* 端点在这一块里的可见字符偏移 */
  function visibleOffsetIn(el, container, offset) {
    var total = (el.textContent || '').split(ZWSP).join('').length;
    if (el !== container && !el.contains(container)) {
      // 端点直接落在容器本身（全选/跨块），offset 是子节点索引
      if (container === editor) {
        var idx = [].indexOf.call(editor.children, el);
        return offset <= idx ? 0 : total;
      }
      var cmp = el.compareDocumentPosition(container);
      if (cmp & 2) return 0;                   // 端点在这块之前
      if (cmp & 4) return total;               // 端点在这块之后
      return 0;
    }
    var rr = document.createRange();
    rr.setStart(el, 0);
    try { rr.setEnd(container, offset); } catch (x) { return total; }
    return Math.min(rr.toString().split(ZWSP).join('').length, total);
  }

  /* 代码块源文里围栏行占掉的区间 */
  function codeBounds(raw) {
    var lines = raw.split('\n');
    var head = 0;
    var tail = raw.length;
    if (/^(?:```|~~~)/.test(lines[0] || '')) head = lines[0].length + 1;
    if (lines.length > 1 && /^(?:```|~~~)/.test(lines[lines.length - 1] || '')) {
      tail = raw.length - lines[lines.length - 1].length - 1;
    }
    if (tail < head) tail = head;
    return { head: head, tail: tail };
  }

  /* 整块源码，按选区两端裁剪 */
  function sourceSlice(el, r) {
    var b = blockOf(el.dataset.id);
    var raw = el.dataset.state === 'source' ? readRaw(el) : (b ? b.raw : readRaw(el));
    var type = el.dataset.type;
    // 表格、公式、图表、分割线、图片：选中即整块源码
    if (type === 'table' || type === 'math' || type === 'mermaid' || type === 'hr' || type === 'image') {
      return raw;
    }
    var vs = visibleOffsetIn(el, r.startContainer, r.startOffset);
    var ve = visibleOffsetIn(el, r.endContainer, r.endOffset);
    if (el.dataset.state === 'source') return raw.slice(Math.min(vs, raw.length), Math.min(ve, raw.length));
    return raw.slice(mapVisibleToRaw(raw, vs), mapVisibleToRaw(raw, ve));
  }

  editor.addEventListener('copy', function (e) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var r = sel.getRangeAt(0);
    if (r.collapsed) return;
    var startBlk = pointBlock(r.startContainer);
    var endBlk = pointBlock(r.endContainer);
    var parts = [];
    [].slice.call(editor.children).forEach(function (el) {
      if (!hitsBlock(r, el)) return;
      if (el.dataset.type === 'code') {
        var b = blockOf(el.dataset.id);
        var raw = el.dataset.state === 'source' ? readRaw(el) : (b ? b.raw : readRaw(el));
        // 整段都在这一个代码框里 → 只要代码本身；跨出代码框或全文复制 → 连围栏一起
        if (startBlk === el && endBlk === el) {
          var cb = codeBounds(raw);
          var body = raw.slice(cb.head, cb.tail);
          var vs2 = Math.min(visibleOffsetIn(el, r.startContainer, r.startOffset), body.length);
          var ve2 = Math.min(visibleOffsetIn(el, r.endContainer, r.endOffset), body.length);
          parts.push(body.slice(vs2, ve2));
        } else {
          parts.push(raw);
        }
        return;
      }
      parts.push(sourceSlice(el, r));
    });
    if (!parts.length) return;
    e.clipboardData.setData('text/plain', parts.join('\n\n'));
    e.preventDefault();
  });



  /* 粘贴 */
  editor.addEventListener('paste', function (e) {
    if (langEditing || isLangInput(e.target)) return;
    var cd = e.clipboardData;
    if (!cd) return;
    var items = cd.items ? Array.prototype.slice.call(cd.items) : [];
    var imgItem = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image/') === 0) { imgItem = items[i]; break; }
    }
    if (imgItem) {
      e.preventDefault();
      var file = imgItem.getAsFile();
      if (!file) return;
      var b = activeBlock();
      S.lastImageCtx = b ? { id: b.id, off: caretOffsetInSource(elOf(b.id)) } : null;
      var fr = new FileReader();
      fr.onload = function () {
        post({ type: 'imagePaste', dataUrl: fr.result, name: file.name || 'image.png' });
      };
      fr.readAsDataURL(file);
      return;
    }
    e.preventDefault();
    var text = cd.getData('text/plain') || '';
    if (!text) return;
    e.stopPropagation();
    insertPlainText(text);
  });

  function insertPlainText(text) {
    var clean = text.replace(/\r\n?/g, '\n');
    var b = ensureActiveSource();
    if (!b) return;
    var el = elOf(b.id);
    var off = caretOffsetInSource(el);
    var raw = readRaw(el);
    var before = raw.slice(0, off);
    var after = raw.slice(off);
    var blocks = parseBlocks(clean);
    if (blocks.length <= 1) {
      insertText(clean);
      syncRaw();
      return;
    }
    // 多块内容：把当前块拆成 before + 粘贴块 + after
    var idx = indexOfBlock(b.id);
    var newBlocks = [];
    var firstRaw = (before + blocks[0].raw).replace(/^\s*\n+/, '');
    if (firstRaw.length) newBlocks.push({ raw: firstRaw });
    for (var i = 1; i < blocks.length; i++) {
      var r = blocks[i].raw;
      if (i === blocks.length - 1) r = r + after;
      if (r.length) newBlocks.push({ raw: r });
    }
    if (!newBlocks.length) newBlocks.push({ raw: after });
    S.blocks.splice(idx, 1);
    if (el.parentNode) el.parentNode.removeChild(el);
    var made = newBlocks.map(function (nb) {
      var o = { id: nextId(), raw: nb.raw, type: typeOf(nb.raw) };
      var nel = makeBlockEl(o);
      renderBlock(nel, o);
      return { b: o, el: nel };
    });
    var refNode = el.nextSibling;
    var parent = editor;
    made.forEach(function (m) { parent.insertBefore(m.el, refNode); });
    S.blocks.splice.apply(S.blocks, [idx, 0].concat(made.map(function (m) { return m.b; })));
    var target = made[made.length - 1];
    S.activeId = target.b.id;
    enterSource(target.b.id, target.b.raw.length);
    notifyChange();
  }

  /* 链接点击（Ctrl+Click 打开） */
  document.addEventListener('mousedown', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      e.stopPropagation();
      var href = a.getAttribute('data-href') || a.getAttribute('href') || '';
      post({ type: 'openLink', href: href });
    }
  }, true);

  // 语言标签要在 mousedown 阶段就拦住：若等 click，selectionchange 已经把块重建成编辑态，
  // 原来的 span 被换掉，click 就落空了。
  editor.addEventListener('mousedown', function (e) {
    if (langEditing) return;
    var langEl = e.target && e.target.closest ? e.target.closest('.code-lang') : null;
    if (!langEl) return;
    var blk = langEl.closest('.blk');
    if (!blk) return;
    e.preventDefault();
    var id = blk.dataset.id;
    setTimeout(function () { openLangEditor(id); }, 0);
  }, true);

  /* 按纵坐标找点击位置所属的块：落在块的下半截或块下方空隙，就算这块 */
  function blockAtY(y) {
    var kids = [].slice.call(editor.children);
    if (!kids.length) return null;
    var pick = kids[0];
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].getBoundingClientRect().top <= y) pick = kids[i];
      else break;
    }
    return pick;
  }

  /* 当前 DOM 的全文快照：判断一次撤销/重做有没有真的改动内容 */
  function domSnapshot() {
    return [].slice.call(editor.children).map(function (el) {
      return (el.dataset.type || '') + '\u0001' + readRaw(el);
    }).join('\u0002');
  }

  /* 把停在源码态的那块收回渲染态。click 主动切块之前必须先收旧块：
     否则两块同时停在源码态 —— 快速连点时 selectionchange 跟不上，
     就会看到"后来点的那块渲染了、之前点的那块没回来" */
  function collapseActive(keepId) {
    if (!S.activeId || S.activeId === keepId) return;
    var pe = elOf(S.activeId);
    var pb = blockOf(S.activeId);
    if (pe && pb && pe.dataset.state === 'source') {
      pb.raw = readRaw(pe);
      pb.type = typeOf(pb.raw);
      renderBlock(pe, pb);
    }
    S.activeId = null;
  }

  /* 点击统一挂在滚动容器上：#editor 只有正文宽度、高度也跟内容走，
     两边的留白和正文下方的空白都属于 #page / #scroller，
     点在那些地方不会冒泡到 #editor，浏览器会直接把光标丢掉 */
  scroller.addEventListener('click', function (e) {
    if (langEditing || suppressClick) return;
    var langEl = e.target && e.target.closest ? e.target.closest('.code-lang') : null;
    if (langEl) {
      e.preventDefault();
      e.stopPropagation();
      openLangEditor(langEl.closest('.blk').dataset.id);
      return;
    }
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a) e.preventDefault();
    if (S.mode !== 'source') {
      var target = e.target;
      var inBlk = target && target.closest ? target.closest('.blk') : null;
      if (inBlk && inBlk.dataset.state !== 'source' && inBlk.dataset.id !== S.activeId) {
        // 分割线、表格、图表这类块点上去光标落不进块内节点，
        // selectionchange 拿不到它，这里主动把它切成源码态，否则点不进去、改不了。
        collapseActive(inBlk.dataset.id);
        S.activeId = inBlk.dataset.id;
        enterSource(inBlk.dataset.id, 0);
      } else if (!inBlk) {
        // 只处理点在正文容器/页面背景上的情况；滚动条别动光标
        if (e.target === scroller) {
          var sr = scroller.getBoundingClientRect();
          var barW = scroller.offsetWidth - scroller.clientWidth;
          if (barW > 0 && e.clientX >= sr.left + scroller.clientWidth) return;
        } else if (e.target !== pageEl && e.target !== editor) {
          return;
        }
        // 点在块间缝隙、正文两侧或下方空白：光标就近落到该纵坐标处那一块的末尾，
        // 不要甩到文末 —— 那会把光标顶出当前视口，看着就像"焦点丢了"
        var dest = blockAtY(e.clientY);
        if (dest) {
          collapseActive(dest.dataset.id);
          S.activeId = dest.dataset.id;
          var bd = blockOf(dest.dataset.id);
          enterSource(dest.dataset.id, bd && bd.raw ? bd.raw.length : 0);
          dest.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  });

  editor.addEventListener('blur', function () {
    if (S.mode === 'source') return;
    // 语言输入框拿到焦点时不算离开编辑区
    if (langEditing) return;
    if (!S.activeId) return;
    var el = elOf(S.activeId);
    if (el && el.dataset.state === 'source') {
      var b = blockOf(S.activeId);
      b.raw = readRaw(el);
      b.type = typeOf(b.raw);
      renderBlock(el, b);
    }
  });

  /* 滚动位置回报 */
  var scrollTimer = null;
  scroller.addEventListener('scroll', function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      var max = scroller.scrollHeight - scroller.clientHeight;
      post({ type: 'scroll', ratio: max > 0 ? scroller.scrollTop / max : 0 });
    }, 300);
  });

  /* ---------------- 查找替换 ---------------- */

  var findBar = document.getElementById('findbar');
  var findInput = document.getElementById('find-input');
  var replaceInput = document.getElementById('replace-input');
  var findCount = document.getElementById('find-count');
  var F = { q: '', hits: [], cur: -1 };

  function openFind(replaceMode) {
    findBar.classList.add('show');
    findInput.focus();
    findInput.select();
    if (replaceMode) setTimeout(function () { replaceInput.focus(); }, 0);
    if (findInput.value) runSearch(findInput.value);
  }

  function closeFind() {
    findBar.classList.remove('show');
    clearSearchHighlights();
    editor.focus();
  }

  function clearSearchHighlights() {
    if (window.CSS && CSS.highlights) {
      try { CSS.highlights.delete('mw-search'); CSS.highlights.delete('mw-search-cur'); } catch (e) { }
    }
    F.hits = [];
    F.cur = -1;
  }

  function runSearch(q) {
    clearSearchHighlights();
    F.q = q || '';
    if (!F.q) { findCount.textContent = ''; return; }
    var ql = F.q.toLowerCase();
    var w = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = w.nextNode())) {
      var txt = node.nodeValue;
      if (!txt || txt === ZWSP) continue;
      var lower = txt.toLowerCase();
      var idx = 0;
      while ((idx = lower.indexOf(ql, idx)) !== -1) {
        var r = document.createRange();
        try { r.setStart(node, idx); r.setEnd(node, idx + F.q.length); } catch (err) { break; }
        var blkEl = node.parentElement && node.parentElement.closest ? node.parentElement.closest('.blk') : null;
        F.hits.push({ range: r, blkId: blkEl ? blkEl.dataset.id : null });
        idx += Math.max(1, F.q.length);
      }
    }
    if (window.CSS && CSS.highlights && window.Highlight) {
      try { CSS.highlights.set('mw-search', new Highlight(F.hits.map(function (h) { return h.range; }))); }
      catch (e) { }
    }
    findCount.textContent = F.hits.length ? ('1/' + F.hits.length) : '0/0';
    if (F.hits.length) gotoHit(0);
  }

  function gotoHit(i) {
    if (!F.hits.length) return;
    F.cur = ((i % F.hits.length) + F.hits.length) % F.hits.length;
    var h = F.hits[F.cur];
    if (window.CSS && CSS.highlights && window.Highlight) {
      try { CSS.highlights.set('mw-search-cur', new Highlight(h.range)); } catch (e) { }
    }
    var rect = h.range.getBoundingClientRect();
    var target = rect.top + scroller.scrollTop - scroller.clientHeight / 2 + rect.height / 2;
    scroller.scrollTop = Math.max(0, target);
    findCount.textContent = (F.cur + 1) + '/' + F.hits.length;
  }

  function nthIndexOf(hay, needle, n) {
    var idx = -1;
    for (var i = 0; i <= n; i++) {
      idx = hay.indexOf(needle, idx + 1);
      if (idx < 0) return -1;
    }
    return idx;
  }

  function replaceCurrent() {
    if (!F.hits.length) return;
    var h = F.hits[F.cur];
    var blk = blockOf(h.blkId);
    if (!blk) return;
    var el = elOf(blk.id);
    var raw = (el && el.dataset.state === 'source') ? readRaw(el) : blk.raw;
    var k = 0;
    for (var i = 0; i <= F.cur; i++) if (F.hits[i].blkId === h.blkId) k++;
    k = Math.max(0, k - 1);
    var idx = nthIndexOf(raw, F.q, k);
    if (idx < 0) return;
    var rep = replaceInput.value;
    var newRaw = raw.slice(0, idx) + rep + raw.slice(idx + F.q.length);
    blk.raw = newRaw;
    blk.type = typeOf(newRaw);
    if (el) {
      if (el.dataset.state === 'source') el.textContent = newRaw && newRaw.length ? newRaw : ZWSP;
      else renderBlock(el, blk);
    }
    notifyChange();
    var cur = F.cur;
    runSearch(findInput.value);
    if (F.hits.length) gotoHit(Math.min(cur, F.hits.length - 1));
  }

  function replaceAll() {
    if (!F.q) return;
    var q = F.q, rep = replaceInput.value, count = 0;
    for (var i = 0; i < S.blocks.length; i++) {
      var b = S.blocks[i];
      var el = elOf(b.id);
      var raw = (el && el.dataset.state === 'source') ? readRaw(el) : b.raw;
      var parts = raw.split(q);
      if (parts.length > 1) {
        count += parts.length - 1;
        b.raw = parts.join(rep);
        b.type = typeOf(b.raw);
        if (el) {
          if (el.dataset.state === 'source') el.textContent = b.raw && b.raw.length ? b.raw : ZWSP;
          else renderBlock(el, b);
        }
      }
    }
    notifyChange();
    runSearch(q);
    findCount.textContent = '已替换 ' + count + ' 处';
  }

  findInput.addEventListener('input', function () { runSearch(findInput.value); });
  findInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); gotoHit(e.shiftKey ? F.cur - 1 : F.cur + 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  replaceInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); replaceCurrent(); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  document.getElementById('find-prev').addEventListener('click', function () { gotoHit(F.cur - 1); });
  document.getElementById('find-next').addEventListener('click', function () { gotoHit(F.cur + 1); });
  document.getElementById('find-close').addEventListener('click', closeFind);
  document.getElementById('replace-one').addEventListener('click', replaceCurrent);
  document.getElementById('replace-all').addEventListener('click', replaceAll);

  /* ---------------- 主题 / 字号 / 模式 ---------------- */

  function setTheme(t) {
    S.theme = t || 'github';
    document.body.dataset.theme = S.theme;
    var hl = document.getElementById('hljs-theme');
    if (hl) hl.href = (S.theme === 'night') ? 'vendor/hljs-dark.css' : 'vendor/hljs-light.css';
    if (window.mermaid) {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: (S.theme === 'night') ? 'dark' : 'default',
          fontFamily: 'Microsoft YaHei, Segoe UI, sans-serif'
        });
      } catch (e) { }
    }
    if (S.mode !== 'source') {
      // 重新渲染图表块（配色需跟着换）
      for (var i = 0; i < S.blocks.length; i++) {
        if (S.blocks[i].type === 'mermaid') {
          var el = elOf(S.blocks[i].id);
          if (el) renderBlock(el, S.blocks[i]);
        }
      }
    }
  }

  function setPrefs(p) {
    if (p.theme) setTheme(p.theme);
    if (p.fontSize) document.documentElement.style.setProperty('--fs-base', p.fontSize + 'px');
    if (p.pageWidth) document.documentElement.style.setProperty('--page-w', p.pageWidth + 'px');
  }

  function setMode(mode) {
    mode = (mode === 'source') ? 'source' : 'wysiwyg';
    if (mode === S.mode) return;
    var md = toMarkdown();
    var ratio = 0;
    var max = scroller.scrollHeight - scroller.clientHeight;
    if (max > 0) ratio = scroller.scrollTop / max;
    S.mode = mode;
    document.body.classList.toggle('mode-source', mode === 'source');
    if (mode === 'source') buildSourceAll(md);
    else buildAll(md, { scrollRatio: ratio });
    post({ type: 'mode', mode: S.mode });
    notifyChange();
  }

  function toggleSourceMode() { setMode(S.mode === 'source' ? 'wysiwyg' : 'source'); }

  function gotoBlock(id) {
    var el = elOf(id);
    if (!el) return;
    var top = el.offsetTop - 120;
    scroller.scrollTop = Math.max(0, top);
  }

  function insertImageAt(path) {
    var b = ensureActiveSource();
    if (!b) return;
    var el = elOf(b.id);
    var off = caretOffsetInSource(el);
    var raw = readRaw(el);
    var md = '![](' + path + ')';
    var newRaw = raw.slice(0, off) + md + raw.slice(off);
    b.raw = newRaw;
    b.type = typeOf(newRaw);
    el.textContent = newRaw;
    caretAt(el, off + md.length);
    notifyChange();
  }

  /* ---------------- 片段插入 ---------------- */

  function selectPlaceholder(el, text) {
    var prefixLen = 0;
    var m = text.match(/^(#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/);
    if (m) prefixLen = m[0].length;
    if (/^(```|~~~|\$\$)/.test(text)) {
      var nl = text.indexOf('\n');
      prefixLen = nl >= 0 ? nl + 1 : text.length;
    }
    if (text.charAt(0) === '|') prefixLen = 2;
    if (prefixLen >= text.length) return;
    var nodes = collectTextNodes(el);
    if (!nodes.length) return;
    var tn = nodes[0];
    var sel = window.getSelection();
    var r = document.createRange();
    r.setStart(tn, Math.min(prefixLen, tn.nodeValue.length));
    r.setEnd(tn, Math.min(text.length, tn.nodeValue.length));
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertSnippet(text) {
    text = String(text == null ? '' : text);
    if (!text) return;
    if (S.mode === 'source') return;

    var b = activeBlock();
    var empty = false;
    if (b) {
      var el0 = elOf(b.id);
      empty = ((el0 ? readRaw(el0) : b.raw) || '').trim() === '';
    }

    if (b && empty) {
      b.raw = text;
      b.type = typeOf(text);
      var el = elOf(b.id);
      renderBlock(el, b);
      S.activeId = b.id;
      enterSource(b.id, 0);
      selectPlaceholder(el, text);
    } else {
      var idx = b ? indexOfBlock(b.id) : S.blocks.length - 1;
      var nb = { id: nextId(), raw: text, type: typeOf(text) };
      S.blocks.splice(idx + 1, 0, nb);
      var nel = makeBlockEl(nb);
      renderBlock(nel, nb);
      var ref = b ? elOf(b.id) : null;
      if (ref && ref.parentNode) ref.parentNode.insertBefore(nel, ref.nextSibling);
      else editor.appendChild(nel);
      S.activeId = nb.id;
      enterSource(nb.id, 0);
      selectPlaceholder(nel, text);
    }
    notifyChange();
    post({ type: 'outlineNow', outline: buildOutline() });
  }

  function flushActiveToRendered() {
    if (S.mode === 'source' || !S.activeId) return;
    var el = elOf(S.activeId);
    if (el && el.dataset.state === 'source') {
      var b = blockOf(S.activeId);
      if (!b) return;
      b.raw = readRaw(el);
      b.type = typeOf(b.raw);
      renderBlock(el, b);
    }
  }


  function execOp(op) {
    if (op === 'selectAll') {
      var r = document.createRange();
      r.selectNodeContents(editor);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      return;
    }
    try { document.execCommand(op); } catch (e) { }
  }

  /* ---------------- 宿主消息 ---------------- */

  function onHost(data) {
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (e) { return; }
    }
    if (!data || !data.cmd) return;
    switch (data.cmd) {
      case 'load': {
        S.docDir = data.docDir || '';
        var mode = data.mode === 'source' ? 'source' : 'wysiwyg';
        S.mode = mode;
        document.body.classList.toggle('mode-source', mode === 'source');
        if (mode === 'source') buildSourceAll(data.md || '');
        else buildAll(data.md || '', { scrollRatio: data.scrollRatio });
        if (data.focus) setTimeout(function () { editor.focus(); }, 30);
        var mdNow = toMarkdown();
        post({ type: 'stats', stats: computeStats(mdNow) });
        post({ type: 'outlineNow', outline: buildOutline() });
        break;
      }
      case 'setTheme': setTheme(data.theme); break;
      case 'setPrefs': setPrefs(data); break;
      case 'setMode': setMode(data.mode); break;
      case 'getContent': post({ type: 'content', md: toMarkdown() }); break;
      case 'insertImage': insertImageAt(data.path); break;
      case 'insert': insertSnippet(data.text); break;
      case 'format': wrapSelection(data.mark || '**'); break;
      case 'exec': execOp(data.op); break;
      case 'find': openFind(false); break;
      case 'findReplace': openFind(true); break;
      case 'exportHtml':
        flushActiveToRendered();
        post({ type: 'exportHtml', html: editor.innerHTML });
        break;
      case 'printMode':
        if (data.on) flushActiveToRendered();
        document.body.classList.toggle('print-mode', !!data.on);
        break;
      case 'gotoBlock': gotoBlock(data.id); break;
      case 'focus': editor.focus(); break;
      case 'toggleSource': toggleSourceMode(); break;
      case 'relayout': break;
      case 'setDocDir': S.docDir = data.docDir || ''; break;
    }
  }

  if (window.chrome && chrome.webview) {
    chrome.webview.addEventListener('message', function (e) { onHost(e.data); });
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    if (window.mermaid) {
      try {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default', fontFamily: 'Microsoft YaHei, Segoe UI, sans-serif' });
      } catch (e) { }
    }
    if (window.hljs) {
      try { hljs.configure({ ignoreUnescapedHTML: true }); } catch (e) { }
    }
    document.body.dataset.theme = S.theme;
    buildAll('', {});
    post({ type: 'ready' });
  }

  // 暴露给宿主（用于导出时取 HTML）
  window.MW = {
    toMarkdown: toMarkdown,
    setMode: setMode,
    getRendererHTML: function () {
      return document.getElementById('page') ? document.getElementById('page').innerHTML : '';
    }
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init);

})();
