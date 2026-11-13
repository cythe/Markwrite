using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace MarkWrite.Services;

/// <summary>
/// 把 Markdown 直接生成为真实的 .docx（OOXML），不依赖 Office / 第三方库。
/// 支持：标题、段落、粗体 / 斜体 / 删除线 / 行内代码、引用、列表、代码块、表格、分隔线。
/// </summary>
public static class DocxExporter
{
    private sealed class Block
    {
        public string Type = "p";
        public string Text = "";
        public List<string> Lines = new();
        public int Level;
        public List<string[]> Rows = new();
    }

    public static void Export(string markdown, string outputPath)
    {
        var blocks = Parse(markdown ?? "");
        var body = new StringBuilder();
        foreach (var b in blocks) body.Append(RenderBlock(b));

        var doc = $"""
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
{body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body>
</w:document>
""";

        using var fs = File.Create(outputPath);
        using var zip = new ZipArchive(fs, ZipArchiveMode.Create);

        Add(zip, "[Content_Types].xml", """
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>
""");

        Add(zip, "_rels/.rels", """
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>
""");

        Add(zip, "word/_rels/document.xml.rels", """
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>
""");

        Add(zip, "word/document.xml", doc);
        Add(zip, "word/styles.xml", Styles());
        Add(zip, "docProps/core.xml", $"""
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>{Esc(Path.GetFileNameWithoutExtension(outputPath))}</dc:title>
<dc:creator>MarkWrite</dc:creator>
<cp:lastModifiedBy>MarkWrite</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ssZ}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ssZ}</dcterms:modified>
</cp:coreProperties>
""");
    }

    private static void Add(ZipArchive zip, string name, string content)
    {
        var entry = zip.CreateEntry(name, CompressionLevel.Optimal);
        using var stream = entry.Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }

    /* ---------------- 样式表 ---------------- */

    private static string Styles()
    {
        var sb = new StringBuilder();
        sb.Append("""
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
  <w:rPrDefault><w:rPr>
    <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/>
    <w:sz w:val="21"/><w:szCs w:val="21"/>
  </w:rPr></w:rPrDefault>
  <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="310" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
""");

        var heads = new (int size, int before, int after)[] { (0, 0, 0), (40, 360, 160), (32, 300, 130), (28, 260, 110), (24, 220, 100), (22, 200, 90), (21, 180, 80) };
        for (var i = 1; i <= 6; i++)
        {
            sb.Append($"""
<w:style w:type="paragraph" w:styleId="Heading{i}"><w:name w:val="heading {i}"/><w:basedOn w:val="Normal"/><w:qFormat/>
  <w:pPr><w:keepNext/><w:outlineLvl w:val="{i - 1}"/><w:spacing w:before="{heads[i].before}" w:after="{heads[i].after}"/></w:pPr>
  <w:rPr><w:b/><w:color w:val="1F2328"/><w:sz w:val="{heads[i].size}"/><w:szCs w:val="{heads[i].size}"/></w:rPr>
</w:style>
""");
        }

        sb.Append("""
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="MarkWrite Code"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:ind w:left="200" w:right="200"/></w:pPr>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/><w:szCs w:val="18"/><w:color w:val="24292F"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="MarkWrite Quote"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="D0D7DE"/></w:pBdr></w:pPr>
  <w:rPr><w:color w:val="57606A"/></w:rPr>
</w:style>
<w:style w:type="paragraph" w:styleId="ListPara"><w:name w:val="MarkWrite List"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:after="60"/><w:ind w:left="420" w:hanging="240"/></w:pPr>
</w:style>
</w:styles>
""");
        return sb.ToString();
    }

    /* ---------------- markdown 解析 ---------------- */

    private static List<Block> Parse(string md)
    {
        var lines = md.Replace("\r\n", "\n").Replace('\t', ' ').Split('\n');
        var result = new List<Block>();
        var i = 0;
        while (i < lines.Length)
        {
            var line = lines[i];
            if (string.IsNullOrWhiteSpace(line)) { i++; continue; }

            // 代码围栏
            var fm = Regex.Match(line, @"^\s{0,3}(`{3,}|~{3,})");
            if (fm.Success)
            {
                var fence = fm.Groups[1].Value;
                var body = new List<string>();
                i++;
                while (i < lines.Length && !Regex.IsMatch(lines[i], @"^\s{0,3}" + Regex.Escape(fence[..1]) + "{" + fence.Length + @",}\s*$"))
                {
                    body.Add(lines[i]); i++;
                }
                if (i < lines.Length) i++;
                result.Add(new Block { Type = "code", Lines = body });
                continue;
            }

            // 独立公式块
            if (Regex.IsMatch(line, @"^\s*\$\$\s*$"))
            {
                var body = new List<string>();
                i++;
                while (i < lines.Length && !Regex.IsMatch(lines[i], @"^\s*\$\$\s*$")) { body.Add(lines[i]); i++; }
                if (i < lines.Length) i++;
                result.Add(new Block { Type = "code", Lines = body });
                continue;
            }

            // 表格
            if (line.Contains('|') && i + 1 < lines.Length && Regex.IsMatch(lines[i + 1], @"^\s*\|?[\s:|-]+\|?\s*$") && lines[i + 1].Contains('-'))
            {
                var rows = new List<string[]> { SplitRow(line), SplitRow(lines[i + 1]) };
                i += 2;
                while (i < lines.Length && !string.IsNullOrWhiteSpace(lines[i]) && lines[i].Contains('|'))
                {
                    rows.Add(SplitRow(lines[i])); i++;
                }
                result.Add(new Block { Type = "table", Rows = rows });
                continue;
            }

            // 标题
            var hm = Regex.Match(line, @"^\s{0,3}(#{1,6})\s+(.*)$");
            if (hm.Success)
            {
                result.Add(new Block { Type = "h", Level = hm.Groups[1].Value.Length, Text = hm.Groups[2].Value.Trim() });
                i++;
                continue;
            }

            // 分隔线
            if (Regex.IsMatch(line, @"^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$"))
            {
                result.Add(new Block { Type = "hr" }); i++; continue;
            }

            // 引用
            if (Regex.IsMatch(line, @"^\s{0,3}>"))
            {
                var body = new List<string>();
                while (i < lines.Length && Regex.IsMatch(lines[i], @"^\s{0,3}>"))
                {
                    body.Add(Regex.Replace(lines[i], @"^\s{0,3}>\s?", "")); i++;
                }
                result.Add(new Block { Type = "quote", Lines = body });
                continue;
            }

            // 列表
            if (Regex.IsMatch(line, @"^\s{0,3}([-*+]|\d{1,9}[.)])\s+"))
            {
                var body = new List<string>();
                while (i < lines.Length && Regex.IsMatch(lines[i], @"^\s{0,3}([-*+]|\d{1,9}[.)])\s+"))
                {
                    body.Add(lines[i]); i++;
                }
                result.Add(new Block { Type = "list", Lines = body });
                continue;
            }

            // 段落到空行为止
            var para = new List<string>();
            while (i < lines.Length && !string.IsNullOrWhiteSpace(lines[i]))
            {
                if (para.Count > 0 && Regex.IsMatch(lines[i], @"^\s{0,3}(#{1,6}\s|>|[-*+]\s|\d{1,9}[.)]\s|`{3,}|~{3,})")) break;
                para.Add(lines[i]); i++;
            }
            if (para.Count > 0) result.Add(new Block { Type = "p", Text = string.Join("\n", para) });
            else i++;
        }
        return result;
    }

    private static string[] SplitRow(string line)
    {
        var s = line.Trim();
        if (s.StartsWith("|")) s = s[1..];
        if (s.EndsWith("|")) s = s[..^1];
        return s.Split('|').Select(x => x.Trim()).ToArray();
    }

    /* ---------------- 渲染 ---------------- */

    private static string RenderBlock(Block b)
    {
        switch (b.Type)
        {
            case "h":
                return Para(Inline(b.Text), $"<w:pStyle w:val=\"Heading{b.Level}\"/>");

            case "hr":
                return Para("", "<w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"D0D7DE\"/></w:pBdr>");

            case "code":
            {
                var sb = new StringBuilder();
                if (b.Lines.Count == 0) b.Lines.Add("");
                foreach (var l in b.Lines)
                    sb.Append($"""
<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Microsoft YaHei"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">{Esc(l)}</w:t></w:r></w:p>
""");
                return sb.ToString();
            }

            case "quote":
            {
                var sb = new StringBuilder();
                var joined = string.Join("\n", b.Lines);
                foreach (var seg in joined.Split("\n\n"))
                    sb.Append(Para(Inline(seg.Replace("\n", " ")), "<w:pStyle w:val=\"Quote\"/>"));
                return sb.ToString();
            }

            case "list":
            {
                var sb = new StringBuilder();
                foreach (var raw in b.Lines)
                {
                    var m = Regex.Match(raw, @"^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$");
                    if (!m.Success) continue;
                    var indent = m.Groups[1].Value.Length;
                    var marker = m.Groups[2].Value;
                    var ordered = char.IsDigit(marker[0]);
                    var body = m.Groups[3].Value;
                    var isTask = Regex.IsMatch(body, @"^\[[ xX]\]");
                    var bullet = isTask ? (Regex.IsMatch(body, @"^\[[xX]\]") ? "☑" : "☐") : (ordered ? marker : "•");
                    if (isTask) body = Regex.Replace(body, @"^\[[ xX]\]\s*", "");
                    var pPr = $"""
<w:pStyle w:val="ListPara"/><w:ind w:left="{420 + indent * 160}" w:hanging="240"/>
""";
                    sb.Append(Para("<w:r><w:rPr><w:rFonts w:eastAsia=\"Microsoft YaHei\"/></w:rPr><w:t xml:space=\"preserve\">" +
                                   Esc(bullet) + "  </w:t></w:r>" + Inline(body), pPr));
                }
                return sb.ToString();
            }

            case "table":
            {
                var sb = new StringBuilder();
                sb.Append("<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>");
                foreach (var side in new[] { "top", "left", "bottom", "right", "insideH", "insideV" })
                    sb.Append($"<w:{side} w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"D0D7DE\"/>");
                sb.Append("</w:tblBorders></w:tblPr>");

                for (var r = 0; r < b.Rows.Count; r++)
                {
                    if (r == 1) continue; // 分隔行
                    var isHead = r == 0;
                    sb.Append("<w:tr>");
                    foreach (var cell in b.Rows[r])
                    {
                        sb.Append("<w:tc><w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/>");
                        if (isHead) sb.Append("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F3F5\"/>");
                        sb.Append("</w:tcPr>");
                        var runs = Inline(cell);
                        if (isHead) runs = "<w:r><w:rPr><w:b/></w:rPr><w:t xml:space=\"preserve\">" + Esc(StripMarks(cell)) + "</w:t></w:r>";
                        sb.Append(Para(runs, "<w:spacing w:before=\"40\" w:after=\"40\" w:line=\"260\" w:lineRule=\"auto\"/>"));
                        sb.Append("</w:tc>");
                    }
                    sb.Append("</w:tr>");
                }
                sb.Append("</w:tbl>");
                sb.Append(Para("", "<w:spacing w:after=\"0\"/>")); // Word 要求表格后有空段
                return sb.ToString();
            }

            default:
                return Para(Inline(b.Text), "<w:spacing w:after=\"160\"/>");
        }
    }

    private static string StripMarks(string s) => Regex.Replace(Regex.Replace(s, @"[*_`~=]", ""), @"\[([^\]]*)\]\([^)]*\)", "$1");

    private static string Para(string runs, string pPr)
    {
        return $"<w:p><w:pPr>{pPr}</w:pPr>{runs}</w:p>";
    }

    private static string Inline(string text)
    {
        if (string.IsNullOrEmpty(text)) return "";
        var sb = new StringBuilder();
        var parts = Regex.Split(text, @"(\*\*[\s\S]*?\*\*|__[\s\S]*?__|~~[\s\S]*?~~|==[\s\S]*?==|`[\s\S]*?`|\*[\s\S]*?\*|_[\s\S]*?_)");
        foreach (var part in parts)
        {
            if (part.Length == 0) continue;
            var bold = false; var italic = false; var strike = false; var code = false;
            var body = part;

            if (part.Length > 4 && part.StartsWith("**") && part.EndsWith("**")) { bold = true; body = part[2..^2]; }
            else if (part.Length > 4 && part.StartsWith("__") && part.EndsWith("__")) { bold = true; body = part[2..^2]; }
            else if (part.Length > 4 && part.StartsWith("~~") && part.EndsWith("~~")) { strike = true; body = part[2..^2]; }
            else if (part.Length > 4 && part.StartsWith("==") && part.EndsWith("==")) { body = part[2..^2]; }
            else if (part.Length > 2 && part.StartsWith("`") && part.EndsWith("`")) { code = true; body = part[1..^1]; }
            else if (part.Length > 2 && part.StartsWith("*") && part.EndsWith("*")) { italic = true; body = part[1..^1]; }
            else if (part.Length > 2 && part.StartsWith("_") && part.EndsWith("_")) { italic = true; body = part[1..^1]; }

            // 去掉链接语法，保留可读文字
            body = Regex.Replace(body, @"!\[([^\]]*)\]\([^)]*\)", "$1");
            body = Regex.Replace(body, @"\[([^\]]*)\]\(([^)]*)\)", "$1 ($2)");

            var rpr = new StringBuilder();
            if (bold) rpr.Append("<w:b/>");
            if (italic) rpr.Append("<w:i/>");
            if (strike) rpr.Append("<w:strike/>");
            if (code) rpr.Append("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F1F2F3\"/>");

            string Txt(string seg) =>
                $"<w:r><w:rPr>{rpr}</w:rPr><w:t xml:space=\"preserve\">{Esc(seg)}</w:t></w:r>";

            var segs = body.Split('\n');
            for (var i = 0; i < segs.Length; i++)
            {
                if (i > 0) sb.Append("<w:r><w:br/></w:r>");
                if (segs[i].Length > 0) sb.Append(Txt(segs[i]));
            }
        }
        return sb.ToString();
    }

    private static string Esc(string s)
    {
        return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
                .Replace("\"", "&quot;").Replace("\u0000", "");
    }
}
