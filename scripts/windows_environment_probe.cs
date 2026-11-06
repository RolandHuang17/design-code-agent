// Verification helper, separate from DesignCodeAgent. Uses Windows' built-in .NET Framework.
// Reads only OS metadata, PATH candidates and relevant uninstall entries. Never reads API keys.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Win32;

class EnvironmentProbe {
    static void Inventory(RegistryHive hive, RegistryView view, List<string> names) {
        try {
            using (RegistryKey root = RegistryKey.OpenBaseKey(hive, view))
            using (RegistryKey uninstall = root.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall")) {
                if (uninstall == null) return;
                foreach (string child in uninstall.GetSubKeyNames()) {
                    using (RegistryKey key = uninstall.OpenSubKey(child)) {
                        string name = Convert.ToString(key.GetValue("DisplayName", ""));
                        if (Regex.IsMatch(name, @"Python|Node\.js|Docker", RegexOptions.IgnoreCase))
                            names.Add(hive + "/" + view + ": " + name);
                    }
                }
            }
        } catch (Exception error) { names.Add("Inventory unavailable: " + error.GetType().Name); }
    }
    [STAThread] static void Main() {
        StringBuilder report = new StringBuilder();
        report.AppendLine("DCA CLEAN WINDOWS ENVIRONMENT INVENTORY");
        report.AppendLine("UTC: " + DateTime.UtcNow.ToString("o"));
        report.AppendLine("64-bit OS: " + Environment.Is64BitOperatingSystem);
        using (RegistryKey os = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion")) {
            foreach (string name in new string[] {"ProductName", "DisplayVersion", "CurrentBuild", "UBR"})
                report.AppendLine(name + ": " + Convert.ToString(os.GetValue(name, "unknown")));
        }
        List<string> apps = new List<string>();
        foreach (RegistryHive hive in new RegistryHive[] {RegistryHive.LocalMachine, RegistryHive.CurrentUser})
            foreach (RegistryView view in new RegistryView[] {RegistryView.Registry64, RegistryView.Registry32})
                Inventory(hive, view, apps);
        report.AppendLine("\r\nRelevant installed-program entries:");
        report.AppendLine(apps.Count == 0 ? "NONE FOUND" : String.Join("\r\n", apps.ToArray()));
        report.AppendLine("\r\nPATH executable candidates:");
        int found = 0;
        foreach (string segment in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
            foreach (string name in new string[] {"python.exe", "py.exe", "node.exe", "docker.exe", "docker.cmd"}) {
                try {
                    string candidate = Path.Combine(Environment.ExpandEnvironmentVariables(segment.Trim().Trim('"')), name);
                    if (File.Exists(candidate)) {
                        found++;
                        report.AppendLine(candidate + (candidate.IndexOf("WindowsApps", StringComparison.OrdinalIgnoreCase) >= 0
                            ? " [Windows app-execution alias; not proof of an installed runtime]" : " [present]"));
                    }
                } catch (ArgumentException) { }
            }
        }
        if (found == 0) report.AppendLine("NONE FOUND");
        report.AppendLine("\r\nDesktop acceptance executable SHA256 (read-only):");
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        foreach(string folder in Directory.GetDirectories(desktop)) {
            if(!Path.GetFileName(folder).StartsWith("\u4e2d\u6587 \u7a7a\u683c", StringComparison.Ordinal)) continue;
            string executable=Path.Combine(folder,"Agent", "DesignCodeAgent.exe");
            if(!File.Exists(executable)) continue;
            using(var stream=File.OpenRead(executable)) using(var hash=SHA256.Create())
                report.AppendLine(executable+"\r\n"+BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant());
        }
        report.AppendLine("\r\nBundled runtimes inside standalone executables are not system installations.");
        report.AppendLine("This inventory alone does not prove absence of every portable runtime; pair it with the fresh-OS snapshot and GUI evidence.");
        string output = Path.Combine(desktop, "DCA-clean-environment-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+".txt");
        try { File.WriteAllText(output, report.ToString(), new UTF8Encoding(false)); report.AppendLine("\r\nSaved: " + output); }
        catch (Exception error) { report.AppendLine("Save unavailable: " + error.GetType().Name); }
        Application.EnableVisualStyles();
        Form form = new Form(); form.Text = "Clean Windows Environment Inventory"; form.Size = new Size(920, 650);
        TextBox text = new TextBox(); text.Multiline = true; text.ReadOnly = true; text.WordWrap = false;
        text.ScrollBars = ScrollBars.Both; text.Dock = DockStyle.Fill; text.Font = new Font("Consolas", 10);
        text.Text = report.ToString(); form.Controls.Add(text); Application.Run(form);
    }
}
