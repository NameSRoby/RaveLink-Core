using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RaveLink.Core.WindowsHost
{
    internal sealed partial class DashboardWindow
    {
        private readonly HashSet<Form> popups = new HashSet<Form>();

        private void OpenExternal(string address)
        {
            if (!DesktopPolicy.IsExternalWeb(address)) return;
            try { Process.Start(new ProcessStartInfo(address) { UseShellExecute = true }); }
            catch (Exception error) { HostLog.Write(root, "Could not open web link: " + error.GetType().Name); }
        }

        // Preserve the about:blank WindowProxy used by provider sign-in flows.
        // Its later HTTP navigation is handed to the user's normal browser.
        private async void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            var deferral = e.GetDeferral(); e.Handled = true;
            Form popup = null;
            try {
                if (disposed || !e.IsUserInitiated || popups.Count >= 4) return;
                if (e.Uri != "about:blank" && !DesktopPolicy.IsWorkspace(e.Uri, port)) { OpenExternal(e.Uri); return; }
                popup = new Form { Text = "RaveLink", Icon = Icon, Size = new Size(900, 720), BackColor = BackColor, StartPosition = FormStartPosition.CenterParent };
                var view = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor, AllowExternalDrop = false };
                popup.Controls.Add(view); popups.Add(popup);
                var lifetime = new System.Windows.Forms.Timer { Interval = 120000 };
                Form owned = popup;
                lifetime.Tick += delegate { if (!owned.Visible) owned.Close(); lifetime.Stop(); };
                owned.FormClosed += delegate { lifetime.Dispose(); popups.Remove(owned); view.Dispose(); };
                // Initialize a real child WebView without displaying a blank helper.
                var handle = owned.Handle; view.CreateControl();
                await view.EnsureCoreWebView2Async(browser.CoreWebView2.Environment);
                if (disposed || owned.IsDisposed) return;
                var core = view.CoreWebView2;
                core.Settings.AreHostObjectsAllowed = false; core.Settings.IsWebMessageEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false; core.Settings.IsGeneralAutofillEnabled = false;
                core.NavigationStarting += delegate(object from, CoreWebView2NavigationStartingEventArgs navigation) {
                    if (navigation.Uri == "about:blank") return;
                    if (DesktopPolicy.IsWorkspace(navigation.Uri, port)) { if (!owned.Visible) owned.Show(this); return; }
                    navigation.Cancel = true; OpenExternal(navigation.Uri);
                    if (!owned.IsDisposed) owned.BeginInvoke(new Action(delegate { owned.Close(); }));
                };
                core.WindowCloseRequested += delegate { if (!owned.IsDisposed) owned.Close(); };
                core.NewWindowRequested += delegate(object from, CoreWebView2NewWindowRequestedEventArgs nested) { nested.Handled = true; };
                core.PermissionRequested += delegate(object from, CoreWebView2PermissionRequestedEventArgs permission) { permission.State = CoreWebView2PermissionState.Deny; };
                core.DownloadStarting += OnDownload;
                e.NewWindow = core; lifetime.Start();
                if (DesktopPolicy.IsWorkspace(e.Uri, port)) owned.Show(this);
            } catch (Exception error) {
                if (popup != null) popup.Close();
                HostLog.Write(root, "Could not open desktop child window: " + error.GetType().Name);
            } finally { deferral.Complete(); }
        }

        private void ClosePopups() { foreach (var popup in new List<Form>(popups)) popup.Close(); popups.Clear(); }

        private void OnDownload(object sender, CoreWebView2DownloadStartingEventArgs e)
        {
            if (disposed) { e.Cancel = true; return; }
            using (var dialog = new SaveFileDialog { FileName = Path.GetFileName(e.ResultFilePath), OverwritePrompt = true, RestoreDirectory = true, Title = "Save RaveLink download", Filter = "All files (*.*)|*.*" }) {
                e.Handled = true;
                if (dialog.ShowDialog(this) != DialogResult.OK) { e.Cancel = true; return; }
                e.ResultFilePath = dialog.FileName;
                var download = e.DownloadOperation;
                download.StateChanged += delegate {
                    if (disposed) return;
                    if (download.State == CoreWebView2DownloadState.Completed) connection.Text = "Saved " + Path.GetFileName(download.ResultFilePath);
                    else if (download.State == CoreWebView2DownloadState.Interrupted) connection.Text = "Download interrupted";
                };
            }
        }

        private string WindowStateFile { get { return Path.Combine(root, "runtime", "desktop-window.json"); } }
        private void RestoreWindow()
        {
            try {
                if (!File.Exists(WindowStateFile) || new FileInfo(WindowStateFile).Length > 2048) return;
                var data = new JavaScriptSerializer { MaxJsonLength = 2048 }.Deserialize<Dictionary<string, int>>(File.ReadAllText(WindowStateFile));
                var bounds = new Rectangle(data["x"], data["y"], Math.Max(800, Math.Min(7680, data["width"])), Math.Max(560, Math.Min(4320, data["height"])));
                bool visible = false; Rectangle working = Screen.PrimaryScreen.WorkingArea; int overlapArea = 0;
                foreach (var display in Screen.AllScreens) {
                    var overlap = Rectangle.Intersect(display.WorkingArea, bounds);
                    if (overlap.Width >= 200 && overlap.Height >= 100 && overlap.Width * overlap.Height > overlapArea) { visible = true; working = display.WorkingArea; overlapArea = overlap.Width * overlap.Height; }
                }
                if (visible) {
                    bounds.Width = Math.Min(bounds.Width, working.Width); bounds.Height = Math.Min(bounds.Height, working.Height);
                    bounds.X = Math.Max(working.Left, Math.Min(bounds.X, working.Right - bounds.Width));
                    bounds.Y = Math.Max(working.Top, Math.Min(bounds.Y, working.Bottom - bounds.Height));
                    StartPosition = FormStartPosition.Manual; Bounds = bounds;
                }
                if (data.ContainsKey("maximized") && data["maximized"] == 1) WindowState = FormWindowState.Maximized;
            } catch { }
        }
        private void SaveWindow()
        {
            try {
                Rectangle bounds = fullscreen ? normalBounds : WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                var data = new Dictionary<string, int> { { "x", bounds.X }, { "y", bounds.Y }, { "width", bounds.Width }, { "height", bounds.Height }, { "maximized", (fullscreen ? normalState : WindowState) == FormWindowState.Maximized ? 1 : 0 } };
                Directory.CreateDirectory(Path.GetDirectoryName(WindowStateFile));
                File.WriteAllText(WindowStateFile + ".tmp", new JavaScriptSerializer().Serialize(data));
                File.Copy(WindowStateFile + ".tmp", WindowStateFile, true); File.Delete(WindowStateFile + ".tmp");
            } catch { }
        }
    }
}
