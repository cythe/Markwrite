using System.ComponentModel;
using System.IO;

namespace MarkWrite.Models;

public class DocTab : INotifyPropertyChanged
{
    public string Id { get; } = Guid.NewGuid().ToString("N");
    public string? FilePath { get; set; }
    public string Content { get; set; } = "";
    public string Mode { get; set; } = "wysiwyg";
    public double ScrollRatio { get; set; }

    private bool _dirty;
    public bool Dirty
    {
        get => _dirty;
        set
        {
            if (_dirty == value) return;
            _dirty = value;
            Raise(nameof(Dirty));
            Raise(nameof(Title));
        }
    }

    public string SafeName => string.IsNullOrEmpty(FilePath) ? "未命名" : Path.GetFileName(FilePath);
    public string Title => (Dirty ? "\u25CF " : "") + SafeName;

    public event PropertyChangedEventHandler? PropertyChanged;
    private void Raise(string name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public class FileNode
{
    public string Name { get; set; } = "";
    public string? Path { get; set; }
    public bool IsDir { get; set; }
    public bool IsExpanded { get; set; }
    public string Icon => IsDir ? "\uE8B7" : "\uE7C3";
    public List<FileNode> Children { get; } = new();
}
