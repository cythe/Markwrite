using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace MarkWrite.Services;

/// <summary>
/// 把编辑器渲染出的 DOM 片段包装成一个可独立打开的 HTML 文件。
/// </summary>
public static class Exporter
{
    public static string BuildHtmlDocument(string bodyHtml, string theme, double fontSize, int pageWidth, string editorDir)
    {
        var css = new StringBuilder();
        css.AppendLine(ReadText(Path.Combine(editorDir, "editor.css")));
        css.AppendLine(ReadText(Path.Combine(editorDir, "vendor", "katex", "katex.min.css")));
        css.AppendLine(ReadText(Path.Combine(editorDir, "vendor",
            string.Equals(theme, "night", StringComparison.OrdinalIgnoreCase) ? "hljs-dark.css" : "hljs-light.css")));

        // KaTeX 字体路径改成本地绝对 URI（导出的 HTML 用 file:// 打开时仍能显示公式）
        var fontDir = new Uri(Path.Combine(editorDir, "vendor", "katex", "fonts")).AbsoluteUri.TrimEnd('/') + "/";
        css = new StringBuilder(css.ToString().Replace("url(fonts/", "url(" + fontDir));

        // 导出视图用静态排版，去掉编辑器里的滚动容器与源码态样式
        css.AppendLine(@"
html, body { overflow: auto !important; height: auto !important; }
#scroller { position: static !important; overflow: visible !important; }
#page { padding: 48px 0 80px 0 !important; margin: 0 auto !important; }
#editor { min-height: 0 !important; }
.blk { cursor: default; }
.findbar, .dropmask { display: none !important; }
@page { margin: 18mm 16mm; }
");

        var body = bodyHtml ?? "";
        // 编辑器内部图片使用 mw-img 协议，导出时还原为本地文件路径
        body = Regex.Replace(body, @"mw-img://local/([^""'\s>]+)", m =>
        {
            var raw = Uri.UnescapeDataString(m.Groups[1].Value);
            return ToFileUri(raw);
        });
        // 去掉残留的编辑态标记
        body = body.Replace(" data-state=\"source\"", " data-state=\"rendered\"")
                   .Replace(" class=\"blk src\"", " class=\"blk\"")
                   .Replace(" class=\"blk src blk\"", " class=\"blk\"");

        var head = $@"<!DOCTYPE html>
<html lang=""zh-CN"">
<head>
<meta charset=""utf-8"" />
<meta name=""viewport"" content=""width=device-width, initial-scale=1"" />
<title>MarkWrite 导出</title>
<style>
:root {{ --fs-base: {fontSize}px; --page-w: {pageWidth}px; --page-pad-x: 0px; }}
{css}
</style>
</head>
<body data-theme=""{theme}"">
<div id=""scroller""><div id=""page""><div id=""editor"">
{body}
</div></div></div>
</body>
</html>";
        return head;
    }

    private static string ToFileUri(string path)
    {
        try
        {
            if (Uri.IsWellFormedUriString(path, UriKind.Absolute) &&
                (path.StartsWith("http", StringComparison.OrdinalIgnoreCase) || path.StartsWith("data:", StringComparison.OrdinalIgnoreCase)))
                return path;
            if (File.Exists(path)) return new Uri(Path.GetFullPath(path)).AbsoluteUri;
            return path.Replace("\\", "/");
        }
        catch
        {
            return path.Replace("\\", "/");
        }
    }

    private static string ReadText(string path)
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : "";
        }
        catch { return ""; }
    }
}
