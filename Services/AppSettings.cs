using System.IO;
using System.Text.Json;

namespace MarkWrite.Services;

public class AppSettings
{
    public string Theme { get; set; } = "github";
    public double FontSize { get; set; } = 16;
    public int PageWidth { get; set; } = 880;
    public double SidebarWidth { get; set; } = 260;
    public bool SidebarVisible { get; set; } = true;
    public string SidebarMode { get; set; } = "files";
    public string? LastFolder { get; set; }
    public double WindowWidth { get; set; } = 1200;
    public double WindowHeight { get; set; } = 780;
    public double? WindowLeft { get; set; }
    public double? WindowTop { get; set; }
    public bool WindowMaximized { get; set; }
    public List<string> RecentFiles { get; set; } = new();

    private static string Dir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MarkWrite");
    private static string FilePath => Path.Combine(Dir, "settings.json");

    public static AppSettings Load()
    {
        try
        {
            if (File.Exists(FilePath))
            {
                var json = File.ReadAllText(FilePath);
                var s = JsonSerializer.Deserialize<AppSettings>(json);
                if (s != null) return s;
            }
        }
        catch { /* 配置损坏则用默认值 */ }
        return new AppSettings();
    }

    public void Save()
    {
        try
        {
            Directory.CreateDirectory(Dir);
            File.WriteAllText(FilePath, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch { /* 忽略写盘失败 */ }
    }

    public void PushRecent(string path)
    {
        RecentFiles.RemoveAll(p => string.Equals(p, path, StringComparison.OrdinalIgnoreCase));
        RecentFiles.Insert(0, path);
        if (RecentFiles.Count > 12) RecentFiles = RecentFiles.Take(12).ToList();
    }
}
