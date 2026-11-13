using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using MarkWrite.Models;
using MarkWrite.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace MarkWrite;

public partial class MainWindow : Window
{
    private readonly AppSettings _settings = AppSettings.Load();
    private readonly ObservableCollection<DocTab> _tabs = new();
    private readonly string? _startupFile;
    private DocTab? _current;
    private bool _ready;
    private readonly List<string> _pending = new();
    private string? _folderRoot;
    private List<OutlineItem> _outline = new();
    private TaskCompletionSource<string>? _contentTcs;
    private TaskCompletionSource<string>? _exportTcs;
    private bool _forceClose;

    private string EditorDir => Path.Combine(AppContext.BaseDirectory, "Resources", "editor");

    public MainWindow()
    {
        InitializeComponent();
        var argv = Environment.GetCommandLineArgs();
        if (argv.Length > 1 && !argv[1].StartsWith("-", StringComparison.Ordinal) && File.Exists(argv[1]))
            _startupFile = argv[1];
        _tabs.CollectionChanged += (_, _) => RebuildTabStrip();
        Loaded += Window_Loaded;
        Closing += Window_Closing;
        StateChanged += (_, _) => UpdateMaxButton();
        SideSplitter.DragCompleted += (_, _) =>
        {
            _settings.SidebarWidth = SideCol.ActualWidth;
            _settings.Save();
        };
    }

    /* ===================== 启动 ===================== */

    private void Window_Loaded(object sender, RoutedEventArgs e)
    {
        RestoreWindow();
        ApplyTheme(_settings.Theme, notifyEditor: false);
        ShowSideMode(_settings.SidebarMode);
        ApplySidebarVisibility(_settings.SidebarVisible);
        ShowWelcome(true);
        UpdateModeButton();
        BuildOutlinePanel();
        _ = InitWebAsync();
        if (_startupFile != null) _ = OpenPathAsync(_startupFile);
    }

    private void RestoreWindow()
    {
        if (_settings.WindowWidth > 400) Width = _settings.WindowWidth;
        if (_settings.WindowHeight > 300) Height = _settings.WindowHeight;
        if (_settings.WindowLeft is double wl && _settings.WindowTop is double wt)
        {
            var vLeft = SystemParameters.VirtualScreenLeft;
            var vTop = SystemParameters.VirtualScreenTop;
            var vRight = vLeft + SystemParameters.VirtualScreenWidth;
            var vBottom = vTop + SystemParameters.VirtualScreenHeight;
            if (wl >= vLeft - 50 && wl < vRight - 200 &&
                wt >= vTop - 50 && wt < vBottom - 150)
            {
                Left = wl;
                Top = wt;
            }
        }
        if (_settings.WindowMaximized) WindowState = WindowState.Maximized;
        SideCol.Width = new GridLength(Math.Max(0, _settings.SidebarWidth));
    }

    private async Task InitWebAsync()
    {
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MarkWrite", "WebView2");
            Directory.CreateDirectory(userData);

            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await Web.EnsureCoreWebView2Async(env);

            var core = Web.CoreWebView2!;
            var st = core.Settings;
            st.AreDefaultContextMenusEnabled = false;
            st.IsStatusBarEnabled = false;
            st.AreBrowserAcceleratorKeysEnabled = false;
            st.IsZoomControlEnabled = false;
            st.IsPasswordAutosaveEnabled = false;
            st.IsGeneralAutofillEnabled = false;
            Web.AllowExternalDrop = false;

            core.SetVirtualHostNameToFolderMapping("app.local", EditorDir, CoreWebView2HostResourceAccessKind.Allow);
            core.AddWebResourceRequestedFilter("mw-img://*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += OnResourceRequested;
            core.WebMessageReceived += OnWebMessage;
            core.NavigationCompleted += (_, _) => ApplyWebBackground();

            ApplyWebBackground();
            core.Navigate("https://app.local/index.html");
        }
        catch (Exception ex)
        {
            MessageBox.Show("WebView2 初始化失败：\n" + ex.Message +
                            "\n\n请确认系统已安装 Microsoft Edge WebView2 Runtime。",
                "MarkWrite", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void OnResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var uri = e.Request.Uri;
        if (!uri.StartsWith("mw-img://", StringComparison.OrdinalIgnoreCase)) return;
        try
        {
            var idx = uri.IndexOf("local/", StringComparison.OrdinalIgnoreCase);
            var raw = idx >= 0 ? uri[(idx + 6)..] : uri["mw-img://".Length..];
            var path = Uri.UnescapeDataString(raw.TrimEnd('/'));
            if (!File.Exists(path))
            {
                e.Response = Web.CoreWebView2!.Environment.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            var stream = File.Open(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            e.Response = Web.CoreWebView2!.Environment.CreateWebResourceResponse(
                stream, 200, "OK", "Content-Type: " + MimeOf(path));
        }
        catch
        {
            try { e.Response = Web.CoreWebView2!.Environment.CreateWebResourceResponse(null, 500, "Error", ""); } catch { }
        }
    }

    private static string MimeOf(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" => "image/jpeg",
            ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            ".bmp" => "image/bmp",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream",
        };
    }

    /* ===================== 与编辑器通信 ===================== */

    private void Send(object payload)
    {
        var json = JsonSerializer.Serialize(payload);
        if (!_ready || Web.CoreWebView2 == null) { _pending.Add(json); return; }
        try { Web.CoreWebView2.PostWebMessageAsJson(json); }
        catch { _pending.Add(json); }
    }

    private void FlushPending()
    {
        if (Web.CoreWebView2 == null) return;
        foreach (var json in _pending)
        {
            try { Web.CoreWebView2.PostWebMessageAsJson(json); } catch { }
        }
        _pending.Clear();
    }

    private void SendPrefs()
    {
        Send(new
        {
            cmd = "setPrefs",
            theme = _settings.Theme,
            fontSize = _settings.FontSize,
            pageWidth = _settings.PageWidth
        });
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(e.WebMessageAsJson); }
        catch { return; }

        using (doc)
        {
            var root = doc.RootElement;
            if (!root.TryGetProperty("type", out var typeEl)) return;
            var type = typeEl.GetString() ?? "";

            switch (type)
            {
                case "ready":
                    _ready = true;
                    FlushPending();
                    SendPrefs();
                    if (_current != null) LoadTabIntoEditor(_current);
                    break;

                case "change":
                    HandleChange(root);
                    break;

                case "stats":
                    if (root.TryGetProperty("stats", out var st)) UpdateStats(st);
                    break;

                case "outlineNow":
                    if (root.TryGetProperty("outline", out var ol0)) ParseOutline(ol0);
                    break;

                case "scroll":
                    if (_current != null && root.TryGetProperty("ratio", out var rt) && rt.TryGetDouble(out var ratio))
                        _current.ScrollRatio = ratio;
                    break;

                case "content":
                    if (root.TryGetProperty("md", out var cm)) _contentTcs?.TrySetResult(cm.GetString() ?? "");
                    break;

                case "exportHtml":
                    if (root.TryGetProperty("html", out var eh)) _exportTcs?.TrySetResult(eh.GetString() ?? "");
                    break;

                case "shortcut":
                    if (root.TryGetProperty("key", out var keyEl)) HandleShortcut(keyEl.GetString() ?? "");
                    break;

                case "openLink":
                    if (root.TryGetProperty("href", out var hrefEl)) OpenExternal(hrefEl.GetString() ?? "");
                    break;

                case "imagePaste":
                    _ = HandleImagePasteAsync(root);
                    break;

                case "mode":
                    if (root.TryGetProperty("mode", out var mEl) && _current != null)
                        _current.Mode = mEl.GetString() == "source" ? "source" : "wysiwyg";
                    UpdateModeButton();
                    break;
            }
        }
    }

    private void HandleChange(JsonElement root)
    {
        if (_current == null) return;
        if (root.TryGetProperty("md", out var mdEl))
        {
            var md = mdEl.GetString() ?? "";
            if (md != _current.Content)
            {
                _current.Content = md;
                _current.Dirty = true;
                UpdateChrome();
            }
        }
        if (root.TryGetProperty("stats", out var st)) UpdateStats(st);
        if (root.TryGetProperty("outline", out var ol)) ParseOutline(ol);
    }

    private void UpdateStats(JsonElement st)
    {
        try
        {
            StatWords.Text = "字数 " + st.GetProperty("words").GetInt32();
            StatLines.Text = "行 " + st.GetProperty("lines").GetInt32();
            StatChars.Text = "字符 " + st.GetProperty("chars").GetInt32();
        }
        catch { }
    }

    private void ParseOutline(JsonElement arr)
    {
        var list = new List<OutlineItem>();
        try
        {
            foreach (var e in arr.EnumerateArray())
            {
                list.Add(new OutlineItem
                {
                    Level = e.GetProperty("level").GetInt32(),
                    Text = e.GetProperty("text").GetString() ?? "",
                    Id = e.GetProperty("id").GetString() ?? ""
                });
            }
        }
        catch { }
        _outline = list;
        BuildOutlinePanel();
    }

    private void HandleShortcut(string key)
    {
        switch (key)
        {
            case "s": _ = SaveCurrentAsync(false); break;
            case "shift+s": _ = SaveCurrentAsync(true); break;
            case "o": ShowOpenDialog(); break;
            case "n": CreateNewTab(); break;
            case "w": _ = CloseTabAsync(_current); break;
            case "p": _ = ExportPdfAsync(); break;
        }
    }

    private void OpenExternal(string href)
    {
        if (string.IsNullOrWhiteSpace(href)) return;
        try
        {
            var url = href.Trim();
            if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ||
                url.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase))
            {
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
                return;
            }
            if (File.Exists(url))
            {
                var full = "file:///" + url.Replace("\\", "/");
                System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(full) { UseShellExecute = true });
            }
        }
        catch { }
    }

    private async Task HandleImagePasteAsync(JsonElement root)
    {
        try
        {
            var dataUrl = root.GetProperty("dataUrl").GetString() ?? "";
            var comma = dataUrl.IndexOf(',');
            if (comma < 0) return;
            var bytes = Convert.FromBase64String(dataUrl[(comma + 1)..]);

            var dir = _current?.FilePath != null
                ? (Path.GetDirectoryName(_current.FilePath) ?? "")
                : _folderRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "MarkWrite");
            if (string.IsNullOrEmpty(dir)) dir = Path.GetTempPath();

            Directory.CreateDirectory(Path.Combine(dir, "assets"));
            var name = "img_" + DateTime.Now.ToString("yyyyMMdd_HHmmss_fff") + ".png";
            var full = Path.Combine(dir, "assets", name);
            await File.WriteAllBytesAsync(full, bytes);

            Send(new { cmd = "insertImage", path = "assets/" + name });
            Toast("已插入图片 " + name);
        }
        catch (Exception ex)
        {
            Toast("图片保存失败：" + ex.Message);
        }
    }

    /* ===================== 标签 ===================== */

    private void CreateNewTab()
    {
        var tab = new DocTab();
        _tabs.Add(tab);
        _ = SwitchToAsync(tab);
    }

    private void NewTab_Click(object sender, RoutedEventArgs e) => CreateNewTab();

    private async Task SwitchToAsync(DocTab? tab)
    {
        if (tab == null) return;
        if (_current != null && _current != tab)
            _current.Content = await GetContentAsync();

        _current = tab;
        RebuildTabStrip();
        UpdateChrome();
        ShowWelcome(false);
        LoadTabIntoEditor(tab);
    }

    private void LoadTabIntoEditor(DocTab tab)
    {
        var dir = tab.FilePath != null
            ? (Path.GetDirectoryName(tab.FilePath) ?? "")
            : (_folderRoot ?? "");

        Send(new
        {
            cmd = "load",
            md = tab.Content,
            docDir = dir,
            mode = tab.Mode,
            scrollRatio = tab.ScrollRatio,
            focus = false
        });
        UpdateModeButton();
    }

    private async Task<string> GetContentAsync()
    {
        if (!_ready || Web.CoreWebView2 == null) return _current?.Content ?? "";
        _contentTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        Send(new { cmd = "getContent" });
        var tcs = _contentTcs;
        var done = await Task.WhenAny(tcs.Task, Task.Delay(800));
        if (done == tcs.Task) return tcs.Task.Result;
        return _current?.Content ?? "";
    }

    private async Task<bool> SaveCurrentAsync(bool saveAs)
    {
        if (_current == null) return false;
        return await SaveTabAsync(_current, saveAs);
    }

    private async Task<bool> SaveTabAsync(DocTab tab, bool saveAs)
    {
        if (tab == _current) tab.Content = await GetContentAsync();

        if (saveAs || string.IsNullOrEmpty(tab.FilePath))
        {
            var dlg = new SaveFileDialog
            {
                Filter = "Markdown 文件 (*.md)|*.md|所有文件 (*.*)|*.*",
                FileName = tab.FilePath != null ? Path.GetFileName(tab.FilePath) : "未命名.md",
                DefaultExt = ".md"
            };
            if (dlg.ShowDialog() != true) return false;
            tab.FilePath = dlg.FileName;
        }

        try
        {
            await File.WriteAllTextAsync(tab.FilePath!, tab.Content, new UTF8Encoding(false));
            tab.Dirty = false;
            _settings.PushRecent(tab.FilePath!);
            _settings.Save();
            RebuildTabStrip();
            UpdateChrome();
            Toast("已保存 " + tab.SafeName);
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show("保存失败：" + ex.Message, "MarkWrite", MessageBoxButton.OK, MessageBoxImage.Error);
            return false;
        }
    }

    private async Task OpenPathAsync(string path)
    {
        try { path = Path.GetFullPath(path); } catch { /* 路径非法则保持原样 */ }
        var existing = _tabs.FirstOrDefault(t => t.FilePath != null &&
            string.Equals(t.FilePath, path, StringComparison.OrdinalIgnoreCase));
        if (existing != null) { await SwitchToAsync(existing); return; }

        try
        {
            var content = await File.ReadAllTextAsync(path, Encoding.UTF8);
            var tab = new DocTab { FilePath = path, Content = content };
            _tabs.Add(tab);
            await SwitchToAsync(tab);
            _settings.PushRecent(path);
            _settings.Save();
        }
        catch (Exception ex)
        {
            MessageBox.Show("打开失败：" + ex.Message, "MarkWrite", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void ShowOpenDialog()
    {
        var dlg = new OpenFileDialog
        {
            Filter = "Markdown (*.md;*.markdown;*.mdown;*.txt)|*.md;*.markdown;*.mdown;*.txt|所有文件 (*.*)|*.*",
            Multiselect = true
        };
        if (dlg.ShowDialog() != true) return;
        var files = dlg.FileNames;
        _ = Task.Run(async () =>
        {
            foreach (var f in files) await Dispatcher.InvokeAsync(async () => await OpenPathAsync(f)).Task.Unwrap();
        });
    }

    private void OpenFile_Click(object sender, RoutedEventArgs e) => ShowOpenDialog();

    private async Task CloseTabAsync(DocTab? tab)
    {
        if (tab == null) return;
        if (tab.Dirty)
        {
            var r = MessageBox.Show($"「{tab.SafeName}」有未保存的修改，是否保存？", "MarkWrite",
                MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
            if (r == MessageBoxResult.Cancel) return;
            if (r == MessageBoxResult.Yes && !await SaveTabAsync(tab, false)) return;
        }

        var idx = _tabs.IndexOf(tab);
        var wasCurrent = tab == _current;
        _tabs.Remove(tab);

        if (!wasCurrent) return;

        _current = null;
        if (_tabs.Count == 0)
        {
            ShowWelcome(true);
            UpdateChrome();
            _outline = new List<OutlineItem>();
            BuildOutlinePanel();
            UpdateStatsZero();
        }
        else
        {
            await SwitchToAsync(_tabs[Math.Min(idx, _tabs.Count - 1)]);
        }
    }

    private async void CloseTab_Click(object sender, RoutedEventArgs e)
    {
        if (sender is FrameworkElement fe && fe.Tag is DocTab t) await CloseTabAsync(t);
    }

    private void RebuildTabStrip()
    {
        TabPanel.Children.Clear();
        foreach (var t in _tabs)
        {
            var active = t == _current;
            var bd = new Border
            {
                CornerRadius = new CornerRadius(5, 5, 0, 0),
                Padding = new Thickness(10, 3, 5, 3),
                Margin = new Thickness(0, 0, 3, 0),
                Background = active ? (Brush)FindResource("AppBg") : Brushes.Transparent,
                BorderBrush = active ? (Brush)FindResource("Line") : Brushes.Transparent,
                BorderThickness = new Thickness(1, 1, 1, 0),
                Cursor = Cursors.Hand,
                Tag = t
            };

            var sp = new StackPanel { Orientation = Orientation.Horizontal };
            sp.Children.Add(new TextBlock
            {
                Text = t.Title,
                FontSize = 12.5,
                VerticalAlignment = VerticalAlignment.Center,
                Foreground = active ? (Brush)FindResource("Fg") : (Brush)FindResource("FgMuted"),
                TextTrimming = TextTrimming.CharacterEllipsis,
                MaxWidth = 190
            });

            var close = new Button
            {
                Content = "\u2715",
                FontSize = 10,
                Width = 18,
                Height = 16,
                Margin = new Thickness(6, 0, 0, 0),
                Style = (Style)FindResource("FlatBtn"),
                Tag = t
            };
            close.Click += CloseTab_Click;
            sp.Children.Add(close);

            bd.Child = sp;
            bd.MouseLeftButtonUp += (s, args) =>
            {
                if (s is Border b && b.Tag is DocTab dt && dt != _current) _ = SwitchToAsync(dt);
            };
            TabPanel.Children.Add(bd);
        }
    }

    /* ===================== 外观 ===================== */

    private void UpdateChrome()
    {
        if (_current == null)
        {
            TitleText.Text = "未命名";
            DirtyText.Text = "";
            return;
        }
        TitleText.Text = _current.SafeName;
        DirtyText.Text = _current.Dirty ? "\u25CF" : "";
    }

    private void UpdateStatsZero()
    {
        StatWords.Text = "字数 0";
        StatLines.Text = "行 0";
        StatChars.Text = "字符 0";
    }

    private void ApplyTheme(string theme, bool notifyEditor = true)
    {
        _settings.Theme = theme;
        var p = ThemePalette.Get(theme);
        SetBrush("AppBg", p.Bg);
        SetBrush("PanelBg", p.Panel);
        SetBrush("SubBg", p.Sub);
        SetBrush("Fg", p.Fg);
        SetBrush("FgMuted", p.FgMuted);
        SetBrush("Line", p.Line);
        SetBrush("Accent", p.Accent);
        SetBrush("AccentSoft", p.AccentSoft);
        SetBrush("HoverBg", p.Hover);

        StatTheme.Text = ThemePalette.DisplayName(theme);
        ApplyWebBackground();
        if (notifyEditor) Send(new { cmd = "setTheme", theme = theme });
        RebuildTabStrip();
        BuildOutlinePanel();
        SyncSideTabStyles();
    }

    private void SetBrush(string key, string hex)
    {
        var c = (Color)ColorConverter.ConvertFromString(hex);
        Resources[key] = new SolidColorBrush(c);
    }

    private void ApplyWebBackground()
    {
        if (Web.CoreWebView2 == null) return;
        var p = ThemePalette.Get(_settings.Theme);
        var c = (Color)ColorConverter.ConvertFromString(p.Bg);
        try { Web.DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, c.R, c.G, c.B); } catch { }
    }

    private void ApplySidebarVisibility(bool visible)
    {
        _settings.SidebarVisible = visible;
        SidePanel.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        SideSplitter.Visibility = visible ? Visibility.Visible : Visibility.Collapsed;
        SideCol.Width = visible ? new GridLength(Math.Max(140, _settings.SidebarWidth)) : new GridLength(0);
        SidebarToggleBtn.Foreground = visible ? (Brush)FindResource("Accent") : (Brush)FindResource("FgMuted");
    }

    private void SidebarToggle_Click(object sender, RoutedEventArgs e)
    {
        ApplySidebarVisibility(!_settings.SidebarVisible);
        _settings.Save();
    }

    private void ShowWelcome(bool show)
    {
        WelcomeLayer.Visibility = show ? Visibility.Visible : Visibility.Collapsed;
        Web.Visibility = show ? Visibility.Hidden : Visibility.Visible;
    }

    private void ShowSideMode(string mode)
    {
        _settings.SidebarMode = mode;
        var files = mode != "outline";
        FileTree.Visibility = files ? Visibility.Visible : Visibility.Collapsed;
        OutlineList.Visibility = files ? Visibility.Collapsed : Visibility.Visible;
        OpenFolderBtn.Visibility = files ? Visibility.Visible : Visibility.Collapsed;
        SyncSideTabStyles();
    }

    private void SyncSideTabStyles()
    {
        var files = _settings.SidebarMode != "outline";
        FilesTabBtn.Foreground = files ? (Brush)FindResource("Accent") : (Brush)FindResource("FgMuted");
        FilesTabBtn.FontWeight = files ? FontWeights.SemiBold : FontWeights.Normal;
        OutlineTabBtn.Foreground = files ? (Brush)FindResource("FgMuted") : (Brush)FindResource("Accent");
        OutlineTabBtn.FontWeight = files ? FontWeights.Normal : FontWeights.SemiBold;
    }

    private void SideFiles_Click(object sender, RoutedEventArgs e) { ShowSideMode("files"); _settings.Save(); }
    private void SideOutline_Click(object sender, RoutedEventArgs e) { ShowSideMode("outline"); _settings.Save(); }

    private void UpdateModeButton()
    {
        var src = _current?.Mode == "source";
        ModeBtn.Content = src ? "所见即所得" : "源码";
    }

    private void ModeBtn_Click(object sender, RoutedEventArgs e) => Send(new { cmd = "toggleSource" });

    private void UpdateMaxButton()
    {
        MaxBtn.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
    }

    /* ===================== 侧栏 ===================== */

    private void BuildOutlinePanel()
    {
        OutlineList.Items.Clear();
        if (_outline.Count == 0)
        {
            OutlineList.Items.Add(new TextBlock
            {
                Text = "（当前文档没有标题）",
                Foreground = (Brush)FindResource("FgMuted"),
                FontSize = 12,
                Margin = new Thickness(8, 10, 8, 8)
            });
            return;
        }

        foreach (var item in _outline)
        {
            var tb = new TextBlock
            {
                Text = item.Text,
                FontSize = item.Level == 1 ? 13.5 : (item.Level == 2 ? 13 : 12.5),
                FontWeight = item.Level <= 2 ? FontWeights.SemiBold : FontWeights.Normal,
                Foreground = item.Level >= 3 ? (Brush)FindResource("FgMuted") : (Brush)FindResource("Fg"),
                TextTrimming = TextTrimming.CharacterEllipsis,
                TextWrapping = TextWrapping.NoWrap
            };
            var bd = new Border
            {
                Padding = new Thickness(6, 5, 6, 5),
                Margin = new Thickness(Math.Min(item.Level - 1, 4) * 13, 0, 0, 1),
                CornerRadius = new CornerRadius(5),
                Cursor = Cursors.Hand,
                Background = Brushes.Transparent,
                Child = tb
            };
            var id = item.Id;
            bd.MouseLeftButtonUp += (_, _) =>
            {
                if (!string.IsNullOrEmpty(id)) Send(new { cmd = "gotoBlock", id = id });
            };
            bd.MouseEnter += (_, _) => bd.Background = (Brush)FindResource("HoverBg");
            bd.MouseLeave += (_, _) => bd.Background = Brushes.Transparent;
            OutlineList.Items.Add(bd);
        }
    }

    private void OpenFolder_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFolderDialog { Title = "选择要浏览的文件夹" };
        if (_settings.LastFolder != null && Directory.Exists(_settings.LastFolder))
            dlg.InitialDirectory = _settings.LastFolder;
        if (dlg.ShowDialog() != true) return;
        LoadFolder(dlg.FolderName);
        ShowSideMode("files");
        ApplySidebarVisibility(true);
        _settings.Save();
    }

    private void LoadFolder(string root)
    {
        _folderRoot = root;
        _settings.LastFolder = root;
        var node = new FileNode { Name = Path.GetFileName(root.TrimEnd('\\', '/')), Path = root, IsDir = true, IsExpanded = true };
        FillNode(node, 0);
        FileTree.ItemsSource = new[] { node };
    }

    private void FillNode(FileNode node, int depth)
    {
        if (node.Path == null || depth > 6) return;
        try
        {
            foreach (var dir in Directory.GetDirectories(node.Path).OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                var name = Path.GetFileName(dir);
                if (name.StartsWith(".") || name.Equals("bin", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("obj", StringComparison.OrdinalIgnoreCase) ||
                    name.Equals("node_modules", StringComparison.OrdinalIgnoreCase)) continue;
                var child = new FileNode { Name = name, Path = dir, IsDir = true };
                node.Children.Add(child);
                FillNode(child, depth + 1);
            }
            var exts = new[] { ".md", ".markdown", ".mdown", ".txt" };
            foreach (var f in Directory.GetFiles(node.Path)
                         .Where(f => exts.Contains(Path.GetExtension(f).ToLowerInvariant()))
                         .OrderBy(x => x, StringComparer.OrdinalIgnoreCase))
            {
                node.Children.Add(new FileNode { Name = Path.GetFileName(f), Path = f, IsDir = false });
            }
        }
        catch { }
    }

    private async void FileNode_Click(object sender, MouseButtonEventArgs e)
    {
        if (sender is FrameworkElement fe && fe.DataContext is FileNode n && !n.IsDir && n.Path != null)
            await OpenPathAsync(n.Path);
    }

    /* ===================== 菜单 ===================== */

    private MenuItem MI(string header, string? gesture, Action action)
    {
        var mi = new MenuItem { Header = header, InputGestureText = gesture ?? "" };
        mi.Click += (_, _) => action();
        return mi;
    }

    private MenuItem Group(string header, params object[] items)
    {
        var mi = new MenuItem { Header = header };
        foreach (var i in items) mi.Items.Add(i);
        return mi;
    }

    private void MenuBtn_Click(object sender, RoutedEventArgs e)
    {
        var cm = new ContextMenu
        {
            PlacementTarget = MenuBtn,
            Placement = PlacementMode.Bottom,
            Style = (Style)FindResource("MenuStyle")
        };

        cm.Items.Add(Group("文件",
            MI("新建文档", "Ctrl+N", CreateNewTab),
            MI("打开文件…", "Ctrl+O", ShowOpenDialog),
            MI("打开文件夹…", null, () => OpenFolder_Click(this, new RoutedEventArgs())),
            new Separator(),
            MI("保存", "Ctrl+S", () => _ = SaveCurrentAsync(false)),
            MI("另存为…", "Ctrl+Shift+S", () => _ = SaveCurrentAsync(true)),
            new Separator(),
            Group("导出",
                MI("导出 HTML…", null, () => _ = ExportHtmlAsync()),
                MI("导出 PDF…", "Ctrl+P", () => _ = ExportPdfAsync()),
                MI("导出 Word (docx)…", null, () => _ = ExportWordAsync())),
            new Separator(),
            MI("关闭标签", "Ctrl+W", () => _ = CloseTabAsync(_current)),
            MI("退出", null, Close)));

        var recent = _settings.RecentFiles.Where(File.Exists).Take(8).ToList();
        if (recent.Count > 0)
        {
            var items = recent.Select(p => (object)MI(Path.GetFileName(p), null, () => _ = OpenPathAsync(p))).ToArray();
            cm.Items.Add(Group("最近打开", items));
        }

        cm.Items.Add(Group("编辑",
            MI("撤销", "Ctrl+Z", () => Send(new { cmd = "exec", op = "undo" })),
            MI("重做", "Ctrl+Y", () => Send(new { cmd = "exec", op = "redo" })),
            new Separator(),
            MI("查找", "Ctrl+F", () => Send(new { cmd = "find" })),
            MI("替换", "Ctrl+H", () => Send(new { cmd = "findReplace" })),
            new Separator(),
            MI("全选", "Ctrl+A", () => Send(new { cmd = "exec", op = "selectAll" }))));

        cm.Items.Add(Group("段落",
            MI("一级标题", null, () => InsertSnippet("# 标题")),
            MI("二级标题", null, () => InsertSnippet("## 标题")),
            MI("三级标题", null, () => InsertSnippet("### 标题")),
            MI("正文", null, () => InsertSnippet("正文")),
            new Separator(),
            MI("引用", null, () => InsertSnippet("> 引用")),
            MI("无序列表", null, () => InsertSnippet("- 项目")),
            MI("有序列表", null, () => InsertSnippet("1. 项目")),
            MI("任务列表", null, () => InsertSnippet("- [ ] 待办")),
            MI("代码块", null, () => InsertSnippet("```\n\n```")),
            MI("表格", null, () => InsertSnippet("| 列一 | 列二 |\n| --- | --- |\n|  |  |")),
            MI("公式块", null, () => InsertSnippet("$$\nE = mc^2\n$$")),
            MI("Mermaid 图", null, () => InsertSnippet("```mermaid\ngraph LR\n  A --> B\n```")),
            MI("分隔线", null, () => InsertSnippet("---"))));

        cm.Items.Add(Group("格式",
            MI("加粗", "Ctrl+B", () => Send(new { cmd = "format", mark = "**" })),
            MI("斜体", "Ctrl+I", () => Send(new { cmd = "format", mark = "*" })),
            MI("删除线", null, () => Send(new { cmd = "format", mark = "~~" })),
            MI("高亮", null, () => Send(new { cmd = "format", mark = "==" })),
            MI("行内代码", null, () => Send(new { cmd = "format", mark = "`" }))));

        cm.Items.Add(Group("视图",
            MI("切换源码 / 所见即所得", "Ctrl+/", () => Send(new { cmd = "toggleSource" })),
            MI(_settings.SidebarVisible ? "隐藏侧栏" : "显示侧栏", null,
                () => SidebarToggle_Click(this, new RoutedEventArgs())),
            new Separator(),
            MI("放大字号", null, () => ChangeFontSize(1)),
            MI("缩小字号", null, () => ChangeFontSize(-1)),
            MI("重置字号", null, () => ChangeFontSize(0))));

        var themeMenu = new MenuItem { Header = "主题" };
        foreach (var name in ThemePalette.Names)
        {
            var cur = string.Equals(_settings.Theme, name, StringComparison.OrdinalIgnoreCase);
            var label = (cur ? "\u2713  " : "     ") + ThemePalette.DisplayName(name);
            themeMenu.Items.Add(MI(label, null, () => { ApplyTheme(name); _settings.Save(); }));
        }
        cm.Items.Add(themeMenu);

        cm.Items.Add(Group("帮助",
            MI("关于 MarkWrite", null, () => MessageBox.Show(
                "MarkWrite 1.0\n\n所见即所得 Markdown 编辑器\nWPF + WebView2 + 自研块级渲染引擎\n\n" +
                "支持：标题 / 列表 / 表格 / 代码高亮 / 公式 / Mermaid 图表 / 图片粘贴 / 大纲 / 多标签\n" +
                "导出：HTML / PDF / Word",
                "关于 MarkWrite", MessageBoxButton.OK, MessageBoxImage.Information))));

        cm.IsOpen = true;
    }

    private void InsertSnippet(string text) => Send(new { cmd = "insert", text = text });

    private void ChangeFontSize(int delta)
    {
        _settings.FontSize = delta == 0 ? 16 : Math.Clamp(_settings.FontSize + delta, 12, 26);
        Send(new { cmd = "setPrefs", fontSize = _settings.FontSize, pageWidth = _settings.PageWidth, theme = _settings.Theme });
        _settings.Save();
        Toast("字号 " + _settings.FontSize);
    }

    /* ===================== 窗口按钮 ===================== */

    private void Min_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Max_Click(object sender, RoutedEventArgs e) =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private async void Window_Closing(object? sender, CancelEventArgs e)
    {
        if (_forceClose) { SaveWindowState(); return; }

        var dirty = _tabs.Where(t => t.Dirty).ToList();
        if (dirty.Count > 0)
        {
            var r = MessageBox.Show($"有 {dirty.Count} 个文档尚未保存，是否保存后退出？", "MarkWrite",
                MessageBoxButton.YesNoCancel, MessageBoxImage.Question);
            if (r == MessageBoxResult.Cancel) { e.Cancel = true; return; }
            if (r == MessageBoxResult.Yes)
            {
                e.Cancel = true;
                foreach (var t in dirty)
                {
                    if (!await SaveTabAsync(t, false)) return;
                }
                _forceClose = true;
                Close();
                return;
            }
        }
        SaveWindowState();
    }

    private void SaveWindowState()
    {
        try
        {
            _settings.WindowWidth = RestoreBounds.Width;
            _settings.WindowHeight = RestoreBounds.Height;
            _settings.WindowLeft = RestoreBounds.Left;
            _settings.WindowTop = RestoreBounds.Top;
            _settings.WindowMaximized = WindowState == WindowState.Maximized;
            _settings.Save();
        }
        catch { }
    }

    /* ===================== 导出 ===================== */

    private async Task<string> GetRenderedHtmlAsync()
    {
        if (!_ready || Web.CoreWebView2 == null) return "";
        _exportTcs = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        Send(new { cmd = "exportHtml" });
        var tcs = _exportTcs;
        var done = await Task.WhenAny(tcs.Task, Task.Delay(1500));
        return done == tcs.Task ? tcs.Task.Result : "";
    }

    private async Task ExportHtmlAsync()
    {
        if (_current == null) { Toast("没有打开的文档"); return; }
        var dlg = new SaveFileDialog
        {
            Filter = "HTML 文件 (*.html)|*.html",
            FileName = Path.GetFileNameWithoutExtension(_current.SafeName) + ".html"
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            var body = await GetRenderedHtmlAsync();
            var html = Exporter.BuildHtmlDocument(body, _settings.Theme, _settings.FontSize, _settings.PageWidth, EditorDir);
            await File.WriteAllTextAsync(dlg.FileName, html, new UTF8Encoding(false));
            Toast("已导出 " + Path.GetFileName(dlg.FileName));
        }
        catch (Exception ex)
        {
            MessageBox.Show("导出 HTML 失败：" + ex.Message, "MarkWrite", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task ExportPdfAsync()
    {
        if (_current == null) { Toast("没有打开的文档"); return; }
        if (Web.CoreWebView2 == null) { Toast("编辑器尚未就绪"); return; }

        var dlg = new SaveFileDialog
        {
            Filter = "PDF 文件 (*.pdf)|*.pdf",
            FileName = Path.GetFileNameWithoutExtension(_current.SafeName) + ".pdf"
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            Send(new { cmd = "printMode", on = true });
            await Task.Delay(150);
            var ok = await Web.CoreWebView2.PrintToPdfAsync(dlg.FileName, null);
            Send(new { cmd = "printMode", on = false });
            Toast(ok ? "已导出 " + Path.GetFileName(dlg.FileName) : "PDF 导出失败");
        }
        catch (Exception ex)
        {
            Send(new { cmd = "printMode", on = false });
            MessageBox.Show("导出 PDF 失败：" + ex.Message, "MarkWrite", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private async Task ExportWordAsync()
    {
        if (_current == null) { Toast("没有打开的文档"); return; }
        var dlg = new SaveFileDialog
        {
            Filter = "Word 文档 (*.docx)|*.docx",
            FileName = Path.GetFileNameWithoutExtension(_current.SafeName) + ".docx"
        };
        if (dlg.ShowDialog() != true) return;

        try
        {
            var md = await GetContentAsync();
            DocxExporter.Export(md, dlg.FileName);
            Toast("已导出 " + Path.GetFileName(dlg.FileName));
        }
        catch (Exception ex)
        {
            MessageBox.Show("导出 Word 失败：" + ex.Message, "MarkWrite", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    /* ===================== 轻提示 ===================== */

    private DateTime _toastAt;

    private async void Toast(string text)
    {
        _toastAt = DateTime.Now;
        var stamp = _toastAt;
        StatChars.Text = text;
        await Task.Delay(2400);
        if (stamp != _toastAt) return;
        if (_current == null) { StatChars.Text = "字符 0"; return; }
        var md = _current.Content;
        StatChars.Text = "字符 " + md.Count(c => !char.IsWhiteSpace(c));
    }
}

public class OutlineItem
{
    public int Level { get; set; }
    public string Text { get; set; } = "";
    public string Id { get; set; } = "";
}
