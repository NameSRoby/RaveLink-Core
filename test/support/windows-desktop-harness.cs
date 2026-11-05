using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using RaveLink.Core.WindowsHost;

internal static class DesktopHarness
{
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [STAThread] private static void Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += DesktopPolicy.ResolveDependency;
        if (args[0] == "policy") { Policy(); return; }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        var window = new DashboardWindow(args[1], Int32.Parse(args[2]), SystemIcons.Application,
            delegate { return Task.FromResult(0); }, delegate { }, delegate { return Task.FromResult(0); });
        window.Opacity = 0; window.ShowInTaskbar = false;
        var deadline = new Timer { Interval = 40000 };
        deadline.Tick += delegate { Console.WriteLine("{\"error\":\"desktop test deadline\"}"); Environment.Exit(1); };
        window.Shown += async delegate {
            try { await Exercise(window, args); }
            catch (Exception error) { Console.WriteLine(new JavaScriptSerializer().Serialize(new { error = error.ToString() })); Environment.ExitCode = 1; }
            finally { deadline.Stop(); window.Dispose(); Application.ExitThread(); }
        };
        deadline.Start(); Application.Run(window);
    }

    private static WebView2 Browser(DashboardWindow window)
    {
        return (WebView2)typeof(DashboardWindow).GetField("browser", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
    }
    private static async Task Until(Func<Task<bool>> check)
    {
        for (int i = 0; i < 150; i++) { if (await check()) return; await Task.Delay(100); }
        throw new Exception("WebView condition timed out");
    }
    private static bool PolishedToolbar(DashboardWindow window)
    {
        var bar = (ToolStrip)typeof(DashboardWindow).GetField("toolbar", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
        bar.Refresh();
        using (var pixels = new Bitmap(bar.Width, bar.Height)) {
            bar.DrawToBitmap(pixels, bar.ClientRectangle);
            for (int x = 2; x < bar.Width - 2; x++) {
                var color = pixels.GetPixel(x, bar.Height - 1);
                if (color.R > 160 || color.G > 160 || color.B > 160) return false;
            }
        }
        return bar.Items[4].Bounds.Left > bar.Items[3].Bounds.Right;
    }
    private static async Task Exercise(DashboardWindow window, string[] args)
    {
        await window.OpenDashboardAsync();
        if (args[0] == "fallback") {
            var message = (Label)typeof(DashboardWindow).GetField("message", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window);
            Console.WriteLine(new JavaScriptSerializer().Serialize(new { fallback = message.Text, visible = window.Visible })); return;
        }
        var browser = Browser(window);
        await Until(async delegate { return browser != null && browser.CoreWebView2 != null && await browser.ExecuteScriptAsync("Boolean(document.getElementById('themeButton'))") == "true"; });
        uint process = browser.CoreWebView2.BrowserProcessId;
        await browser.ExecuteScriptAsync("localStorage.setItem('desktop-test','retained');document.documentElement.style.setProperty('--bg','#101219');document.documentElement.style.setProperty('--accent','#2474bf');document.documentElement.style.setProperty('--text','#eef2ff');");
        await Until(delegate { return Task.FromResult(window.BackColor == ColorTranslator.FromHtml("#101219")); });
        await browser.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.evaluate", new JavaScriptSerializer().Serialize(new { expression = "window.desktopPopup=window.open('about:blank','ravelink-desktop-test'); Boolean(window.desktopPopup)", userGesture = true, returnByValue = true }));
        await Until(async delegate { return await browser.ExecuteScriptAsync("Boolean(window.desktopPopup && !window.desktopPopup.closed)") == "true"; });
        await browser.ExecuteScriptAsync("window.desktopPopup.close()");
        await Until(async delegate { return await browser.ExecuteScriptAsync("window.desktopPopup.closed") == "true"; });
        window.Hide(); window.Show();
        var originalSize = window.Size;
        window.Size = window.MinimumSize;
        bool chrome = PolishedToolbar(window);
        window.Size = originalSize;
        chrome &= PolishedToolbar(window);
        bool retained = process == browser.CoreWebView2.BrowserProcessId;
        browser.CoreWebView2.Navigate("file:///C:/Windows/win.ini");
        await Task.Delay(350);
        bool blocked = DesktopPolicy.IsWorkspace(browser.CoreWebView2.Source, Int32.Parse(args[2]));
        await window.OpenDashboardAsync(true);
        await Until(async delegate { return await browser.ExecuteScriptAsync("document.readyState === 'complete' && Boolean(document.getElementById('themeButton')) && Boolean(document.getElementById('light-tab-music'))") == "true"; });
        string stored = await browser.ExecuteScriptAsync("localStorage.getItem('desktop-test')");
        string clipboard = await browser.ExecuteScriptAsync("Boolean(navigator.clipboard && navigator.clipboard.writeText)");
        await browser.ExecuteScriptAsync("document.querySelector('[data-tab=lights]').click();document.querySelector('[data-light-tab=music]').click();");
        await Until(async delegate { return await browser.ExecuteScriptAsync("document.getElementById('music-fixtureRandomization') && !document.getElementById('music-fixtureRandomization').disabled") == "true"; });
        using (var file = File.Create(args[3])) await browser.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, file);
        using (var bitmap = new Bitmap(window.Width, window.Height)) using (var graphics = Graphics.FromImage(bitmap)) {
            IntPtr dc = graphics.GetHdc(); try { PrintWindow(window.Handle, dc, 2); } finally { graphics.ReleaseHdc(dc); }
            bitmap.Save(Path.ChangeExtension(args[3], ".frame.png"), System.Drawing.Imaging.ImageFormat.Png);
        }
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { rendered = true, popup = true, theme = true, chrome, retained, blocked, stored, clipboard, source = browser.CoreWebView2.Source }));
    }

    private static void Policy()
    {
        Color background, accent, text;
        string good = "{\"type\":\"ravelink-theme\",\"background\":\"#050507\",\"accent\":\"#8b001f\",\"text\":\"#eaeaea\"}";
        var denied = new[] { "https://127.0.0.1:5050/", "http://127.0.0.1:5051/", "http://127.0.0.1.evil.example:5050/", "file:///C:/Windows/win.ini", "http://evil@127.0.0.1:5050/" };
        bool blocked = true; foreach (string value in denied) blocked &= !DesktopPolicy.IsWorkspace(value, 5050);
        Console.WriteLine(new JavaScriptSerializer().Serialize(new {
            local = DesktopPolicy.IsWorkspace("http://127.0.0.1:5050/core/", 5050), blocked,
            external = DesktopPolicy.IsExternalWeb("https://login.tidal.com/authorize"),
            schemes = !DesktopPolicy.IsExternalWeb("powershell:evil") && !DesktopPolicy.IsExternalWeb("file:///C:/Windows/win.ini"),
            theme = DesktopPolicy.ReadTheme(good, out background, out accent, out text),
            extraDenied = !DesktopPolicy.ReadTheme(good.Replace("\"ravelink-theme\"", "\"ravelink-theme\",\"command\":\"exit\""), out background, out accent, out text),
            valueDenied = !DesktopPolicy.ReadTheme(good.Replace("#050507", "javascript:evil"), out background, out accent, out text),
            bounded = !DesktopPolicy.ReadTheme(new string('x', 513), out background, out accent, out text),
            profiles = DesktopPolicy.ProfilePath("C:\\Example",5050) != DesktopPolicy.ProfilePath("C:\\Example",5051)
        }));
    }
}
