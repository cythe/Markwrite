namespace MarkWrite.Services;

public record Palette(
    string Bg, string Panel, string Sub, string Fg, string FgMuted,
    string Line, string Accent, string AccentSoft, string Hover, bool IsDark);

public static class ThemePalette
{
    public static readonly string[] Names = { "github", "night", "paper", "solarized" };

    public static Palette Get(string? theme) => (theme ?? "github").ToLowerInvariant() switch
    {
        "night" => new Palette("#1B1D21", "#1F2226", "#26292E", "#D8D8D8", "#8B8F96",
                               "#2E3238", "#6CB6FF", "#22303D", "#2A2E34", true),
        "paper" => new Palette("#F4ECD8", "#F4ECD8", "#EFE5CD", "#2C2720", "#8A7D64",
                               "#DDD0B3", "#8A6A3B", "#E7DAC0", "#EADFC7", false),
        "solarized" => new Palette("#FDF6E3", "#FDF6E3", "#F5EEDB", "#073642", "#93A1A1",
                                   "#E3D9C0", "#268BD2", "#E4EDE8", "#F0E8D2", false),
        _ => new Palette("#FFFFFF", "#FFFFFF", "#F3F4F6", "#202124", "#767676",
                         "#E3E4E6", "#0969DA", "#E8F0FE", "#EFEFEF", false),
    };

    public static string DisplayName(string? theme) => (theme ?? "github").ToLowerInvariant() switch
    {
        "night" => "夜间",
        "paper" => "纸张",
        "solarized" => "日光",
        _ => "简约",
    };
}
