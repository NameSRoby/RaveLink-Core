using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace RaveLink.Core.WindowsHost
{
    internal sealed partial class DashboardWindow : Form
    {
        private static readonly object loaderGate = new object();
        private static bool loaderConfigured;
        private readonly string root;
        private readonly int port;
        private readonly Func<Task> restart;
        private readonly Action openLog;
        private readonly Func<Task> exit;
        private readonly Panel surface = new Panel { Dock = DockStyle.Fill };
        private readonly Panel overlay = new Panel { Dock = DockStyle.Fill };
        private readonly Panel card = new Panel { Size = new Size(540, 260) };
        private readonly Label message = new Label { Left = 24, Top = 74, Width = 492, Height = 85 };
        private readonly Label heading = new Label { Text = "Your workspace is starting", Left = 24, Top = 30, Width = 492, Height = 35, Font = new Font("Segoe UI", 17, FontStyle.Bold) };
        private readonly Button retry = new Button { Text = "Retry", Left = 24, Top = 174, Width = 105, Height = 36 };
        private readonly Button restartButton = new Button { Text = "Restart Core", Left = 138, Top = 174, Width = 122, Height = 36 };
        private readonly LinkLabel runtimeLink = new LinkLabel { Text = "Get Microsoft WebView2", Left = 24, Top = 224, Width = 300, Visible = false };
        private readonly ToolStrip toolbar = new DesktopAppBar { GripStyle = ToolStripGripStyle.Hidden, Dock = DockStyle.Top, AutoSize = false, Height = 44, Padding = new Padding(12, 6, 14, 6), ShowItemToolTips = true };
        private readonly ToolStripLabel connection = new ToolStripLabel("Starting Core") { Name = "desktop-connection", Alignment = ToolStripItemAlignment.Right, AutoSize = false, Width = 156 };
        private readonly ToolStripButton back = new ToolStripButton("Back");
        private readonly ToolStripButton forward = new ToolStripButton("Forward");
        private readonly ToolStripButton reload = new ToolStripButton("Reload");
        private WebView2 browser;
        private Task initializing;
        private int fullscreenGeneration;
        private bool loaded;
        private bool disposed;
        private bool fullscreen;
        private Rectangle normalBounds;
        private FormWindowState normalState;
        private Color frameAccent = Color.FromArgb(139, 0, 31);

        [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr handle, int attribute, ref int value, int size);

        internal DashboardWindow(string directory, int serverPort, Icon icon, Func<Task> restartCore, Action log, Func<Task> exitCore)
        {
            root = directory; port = serverPort; restart = restartCore; openLog = log; exit = exitCore;
            Text = "RaveLink Core"; Icon = icon; ClientSize = new Size(1360, 900);
            Rectangle workArea = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(Width, workArea.Width), Math.Min(Height, workArea.Height));
            MinimumSize = new Size(Math.Min(800, workArea.Width), Math.Min(560, workArea.Height)); StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi; Font = new Font("Segoe UI", 9.5f); KeyPreview = true;
            DoubleBuffered = true; ResizeRedraw = true;
            var menu = new ToolStripDropDownButton("RAVELINK") { Font = new Font("Segoe UI", 9, FontStyle.Bold), Margin = new Padding(0, 0, 14, 0), Padding = new Padding(10, 2, 8, 2), AccessibleName = "RaveLink app menu" };
            ((ToolStripDropDownMenu)menu.DropDown).ShowImageMargin = false;
            menu.DropDownItems.Add("Open in browser", null, delegate { ServerControl.OpenDashboard(port); });
            menu.DropDownItems.Add("Copy workspace address", null, delegate { Clipboard.SetText(ServerControl.DashboardUrl(port)); });
            menu.DropDownItems.Add("Full screen (F11)", null, delegate { ToggleFullscreen(); });
            menu.DropDownItems.Add("Startup log", null, delegate { openLog(); });
            menu.DropDownItems.Add("Restart Core", null, async delegate { await restart(); });
            menu.DropDownItems.Add(new ToolStripSeparator());
            menu.DropDownItems.Add("Hide to tray", null, delegate { Hide(); });
            menu.DropDownItems.Add("Exit RaveLink", null, async delegate { await exit(); });
            PrepareNavigation(back, "back", "Go back (Alt+Left)");
            PrepareNavigation(forward, "forward", "Go forward (Alt+Right)");
            PrepareNavigation(reload, "reload", "Reload workspace (Ctrl+R)");
            toolbar.Items.AddRange(new ToolStripItem[] { menu, back, forward, reload, connection });
            connection.ToolTipText = "Closing this window keeps Core running in the tray. Use RaveLink > Exit to stop it.";
            back.Click += delegate { if (browser != null && browser.CanGoBack) browser.GoBack(); };
            forward.Click += delegate { if (browser != null && browser.CanGoForward) browser.GoForward(); };
            reload.Click += async delegate { await OpenDashboardAsync(true); };
            retry.Click += async delegate { await OpenDashboardAsync(true); };
            restartButton.Click += async delegate { await restart(); };
            runtimeLink.LinkClicked += delegate { OpenExternal("https://developer.microsoft.com/microsoft-edge/webview2/"); };
            var external = new Button { Text = "Open in browser", Left = 269, Top = 174, Width = 145, Height = 36 };
            external.Click += delegate { ServerControl.OpenDashboard(port); };
            card.Controls.AddRange(new Control[] { heading, message, retry, restartButton, external, runtimeLink });
            overlay.Controls.Add(card); surface.Controls.Add(overlay);
            Controls.Add(surface); Controls.Add(toolbar);
            overlay.SizeChanged += delegate { card.Location = new Point(Math.Max(12, (overlay.Width - card.Width) / 2), Math.Max(12, (overlay.Height - card.Height) / 2)); };
            SetColors(Color.FromArgb(5, 5, 7), Color.FromArgb(139, 0, 31), Color.FromArgb(234, 234, 234));
            message.Text = "Connecting to your local RaveLink workspace. Your lights and music remain managed by Core.";
            RestoreWindow();
        }

        private static void PrepareNavigation(ToolStripButton button, string name, string hint)
        {
            button.Name = "desktop-" + name; button.AutoSize = false; button.Width = 34;
            button.Margin = new Padding(2, 0, 2, 0); button.DisplayStyle = ToolStripItemDisplayStyle.Text;
            button.ToolTipText = hint; button.AccessibleName = hint;
        }

        internal void SetServerStatus(string value, bool online)
        {
            if (disposed) return;
            connection.Text = online ? "LOCAL / Connected" : "LOCAL / " + value;
            if (!online) { message.Text = value; overlay.Show(); overlay.BringToFront(); }
        }

        internal async Task OpenDashboardAsync(bool refresh = false)
        {
            if (disposed) return;
            try {
                if (!await ServerControl.IsHealthyAsync(port)) {
                    SetServerStatus("Core is starting or unavailable. Retry or restart Core to reconnect.", false); return;
                }
                if (initializing == null) initializing = InitializeBrowserAsync();
                await initializing;
                if (disposed || browser == null || browser.CoreWebView2 == null) return;
                if (!loaded) { browser.CoreWebView2.Navigate(ServerControl.DashboardUrl(port)); loaded = true; }
                else if (refresh) browser.Reload();
                connection.Text = "LOCAL / Connected";
                if (!refresh) { overlay.Hide(); browser.Focus(); }
            } catch (Exception error) {
                initializing = null; loaded = false;
                HostLog.Write(root, "Desktop viewer: " + error.GetType().Name + ": " + error.Message);
                heading.Text = "Your workspace is still available";
                message.Text = "The desktop viewer could not open. Retry, or open your workspace in a browser. Core continues running.";
                runtimeLink.Visible = error is WebView2RuntimeNotFoundException;
                if (runtimeLink.Visible) message.Text = "Install Microsoft Edge WebView2 to display RaveLink in this window. You can use Open in browser while it is unavailable.";
                overlay.Show(); overlay.BringToFront();
            }
        }

        private async Task InitializeBrowserAsync()
        {
            if (browser != null) { surface.Controls.Remove(browser); browser.Dispose(); }
            // The SDK forbids setting this again after its loader has run. A
            // failed browser initialization may be retried within this process.
            lock (loaderGate) {
                if (!loaderConfigured) {
                    CoreWebView2Environment.SetLoaderDllFolderPath(Path.Combine(root, "runtime", "desktop"));
                    loaderConfigured = true;
                }
            }
            var environment = await CoreWebView2Environment.CreateAsync(null, DesktopPolicy.ProfilePath(root, port));
            if (disposed) return;
            browser = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor, AllowExternalDrop = false };
            surface.Controls.Add(browser); overlay.BringToFront();
            await browser.EnsureCoreWebView2Async(environment);
            if (disposed) return;
            var core = browser.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                if (DesktopPolicy.IsWorkspace(e.Uri, port)) return;
                e.Cancel = true;
                if (DesktopPolicy.IsExternalWeb(e.Uri)) OpenExternal(e.Uri);
            };
            core.NewWindowRequested += OnNewWindow;
            core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs e) {
                if (e.PermissionKind != CoreWebView2PermissionKind.ClipboardRead || !e.IsUserInitiated || !DesktopPolicy.IsWorkspace(e.Uri, port)) e.State = CoreWebView2PermissionState.Deny;
            };
            core.DownloadStarting += OnDownload;
            core.WebMessageReceived += delegate(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
                if (!DesktopPolicy.IsWorkspace(e.Source, port) || e.Source != core.Source) return;
                Color background, accent, text;
                if (DesktopPolicy.ReadTheme(e.WebMessageAsJson, out background, out accent, out text)) SetColors(background, accent, text);
            };
            core.HistoryChanged += delegate { back.Enabled = core.CanGoBack; forward.Enabled = core.CanGoForward; };
            core.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                if (disposed) return;
                if (e.IsSuccess) { overlay.Hide(); connection.Text = "LOCAL / Connected"; browser.Focus(); }
                else if (e.WebErrorStatus != CoreWebView2WebErrorStatus.OperationCanceled) {
                    heading.Text = "Let's reconnect your workspace";
                    message.Text = "The page could not load. Retry to reconnect, or restart Core if it has stopped.";
                    overlay.Show(); overlay.BringToFront();
                }
            };
            core.ProcessFailed += delegate { loaded = false; initializing = null; SetServerStatus("The viewer stopped. Retry to reopen it; Core is still running.", false); };
            core.ContainsFullScreenElementChanged += delegate { if (core.ContainsFullScreenElement != fullscreen) ToggleFullscreen(); };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(DesktopPolicy.ThemeScript(port));
            back.Enabled = forward.Enabled = false;
            runtimeLink.Visible = false;
        }

        private void SetColors(Color background, Color accent, Color text)
        {
            frameAccent = accent;
            BackColor = surface.BackColor = overlay.BackColor = background;
            ForeColor = toolbar.ForeColor = card.ForeColor = text;
            toolbar.BackColor = background; card.BackColor = Tint(background, text, 0.04);
            toolbar.Renderer = new DesktopToolbarRenderer(background, accent, text);
            foreach (ToolStripItem item in toolbar.Items) {
                item.ForeColor = text;
                var dropdown = item as ToolStripDropDownItem;
                if (dropdown != null) { dropdown.DropDown.BackColor = background; dropdown.DropDown.ForeColor = text; }
            }
            heading.ForeColor = text; runtimeLink.LinkColor = text;
            foreach (Control control in card.Controls) if (control is Button) {
                var button = (Button)control; button.FlatStyle = FlatStyle.Flat;
                button.FlatAppearance.BorderColor = accent; button.BackColor = Tint(background, text, 0.07); button.ForeColor = text;
            }
            if (browser != null) browser.DefaultBackgroundColor = background;
            if (IsHandleCreated) {
                try {
                    int dark = background.GetBrightness() < 0.5 ? 1 : 0, color = ColorTranslator.ToWin32(background), captionText = ColorTranslator.ToWin32(text), border = unchecked((int)0xFFFFFFFE);
                    // Windows 11 can suppress its contrasting one-pixel frame.
                    // Earlier Windows builds use the immersive dark-frame hint.
                    if (DwmSetWindowAttribute(Handle, 20, ref dark, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref dark, 4);
                    DwmSetWindowAttribute(Handle, 34, ref border, 4); DwmSetWindowAttribute(Handle, 35, ref color, 4); DwmSetWindowAttribute(Handle, 36, ref captionText, 4);
                } catch { }
            }
        }

        private static Color Tint(Color from, Color to, double amount) { return Color.FromArgb((int)(from.R + (to.R - from.R) * amount), (int)(from.G + (to.G - from.G) * amount), (int)(from.B + (to.B - from.B) * amount)); }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); SetColors(BackColor, frameAccent, ForeColor); }
        protected override void OnVisibleChanged(EventArgs e) { base.OnVisibleChanged(e); if (browser != null) browser.Visible = Visible; }
        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.F11 || (fullscreen && keyData == Keys.Escape)) {
                var core = browser == null ? null : browser.CoreWebView2;
                if (fullscreen && core != null && core.ContainsFullScreenElement) Observe(ExitBrowserFullscreenAsync(core, fullscreenGeneration));
                else ToggleFullscreen();
                return true;
            }
            if (keyData == Keys.F5 || keyData == (Keys.Control | Keys.R)) { var pending = OpenDashboardAsync(true); Observe(pending); return true; }
            if (keyData == (Keys.Alt | Keys.Left)) { if (back.Enabled) back.PerformClick(); return true; }
            if (keyData == (Keys.Alt | Keys.Right)) { if (forward.Enabled) forward.PerformClick(); return true; }
            return base.ProcessCmdKey(ref msg, keyData);
        }
        private static async void Observe(Task task) { try { await task; } catch { } }
        private async Task ExitBrowserFullscreenAsync(CoreWebView2 core, int generation)
        {
            // The fullscreen-change event restores the host after the DOM exits.
            // Leaving only the native window would strand the button-only page.
            // WebView's native fullscreen notification can precede its DOM state.
            // Retry briefly without allowing an old exit to close a newer session.
            try {
                for (int attempt = 0; attempt < 10 && generation == fullscreenGeneration && core.ContainsFullScreenElement; attempt++) {
                    await core.ExecuteScriptAsync("if (document.fullscreenElement) document.exitFullscreen().catch(function () {});");
                    await Task.Delay(25);
                }
            }
            catch { /* A disposed or navigating viewer owns its own recovery. */ }
        }
        private void ToggleFullscreen()
        {
            bool entering = !fullscreen;
            if (entering) { normalBounds = Bounds; normalState = WindowState; }
            fullscreen = entering; fullscreenGeneration++;
            if (entering) { WindowState = FormWindowState.Normal; FormBorderStyle = FormBorderStyle.None; Bounds = Screen.FromControl(this).Bounds; }
            else { FormBorderStyle = FormBorderStyle.Sizable; Bounds = normalBounds; WindowState = normalState; }
            toolbar.Visible = !fullscreen;
        }
        internal void Reveal() { Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); }
        protected override void OnFormClosing(FormClosingEventArgs e) { SaveWindow(); base.OnFormClosing(e); }
        protected override void Dispose(bool disposing)
        {
            disposed = true;
            if (disposing) { SaveWindow(); ClosePopups(); if (browser != null) browser.Dispose(); }
            base.Dispose(disposing);
        }
    }

    internal sealed class DesktopAppBar : ToolStrip
    {
        internal DesktopAppBar() { SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.ResizeRedraw, true); }
    }

    // Paint the complete chrome ourselves. ProfessionalRenderer can reintroduce
    // system highlight borders on focus, resizing and Windows theme changes.
    internal sealed class DesktopToolbarRenderer : ToolStripRenderer
    {
        private readonly Color background, accent, text, edge, hover, muted;
        internal DesktopToolbarRenderer(Color bg, Color active, Color foreground)
        {
            background = bg; accent = active; text = foreground;
            edge = Mix(bg, foreground, 0.12); hover = Mix(bg, foreground, 0.075); muted = Mix(bg, foreground, 0.60);
        }
        private static Color Mix(Color a, Color b, double t) { return Color.FromArgb((int)(a.R + (b.R - a.R) * t), (int)(a.G + (b.G - a.G) * t), (int)(a.B + (b.B - a.B) * t)); }
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e) { e.Graphics.Clear(background); }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            using (var pen = new Pen(edge)) {
                if (e.ToolStrip is ToolStripDropDown) e.Graphics.DrawRectangle(pen, 0, 0, e.ToolStrip.Width - 1, e.ToolStrip.Height - 1);
                else e.Graphics.DrawLine(pen, 0, e.ToolStrip.Height - 1, e.ToolStrip.Width, e.ToolStrip.Height - 1);
            }
        }
        private void Button(ToolStripItemRenderEventArgs e)
        {
            if (!e.Item.Enabled || (!e.Item.Selected && !e.Item.Pressed)) return;
            var bounds = new Rectangle(0, 1, e.Item.Width - 1, e.Item.Height - 3);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (var path = Round(bounds, 6)) using (var brush = new SolidBrush(e.Item.Pressed ? Mix(background, accent, 0.25) : hover)) using (var pen = new Pen(edge)) {
                e.Graphics.FillPath(brush, path); e.Graphics.DrawPath(pen, path);
            }
        }
        protected override void OnRenderButtonBackground(ToolStripItemRenderEventArgs e) { Button(e); }
        protected override void OnRenderDropDownButtonBackground(ToolStripItemRenderEventArgs e) { Button(e); }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e) { Button(e); }
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e) { }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            using (var pen = new Pen(edge)) e.Graphics.DrawLine(pen, 10, e.Item.Height / 2, e.Item.Width - 10, e.Item.Height / 2);
        }
        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float x = e.ArrowRectangle.Left + e.ArrowRectangle.Width / 2f, y = e.ArrowRectangle.Top + e.ArrowRectangle.Height / 2f;
            using (var pen = new Pen(muted, 1.3f)) e.Graphics.DrawLines(pen, new[] { new PointF(x - 3, y - 1), new PointF(x, y + 2), new PointF(x + 3, y - 1) });
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            if (e.Item is ToolStripButton && e.Item.Name.StartsWith("desktop-", StringComparison.Ordinal)) { Navigation(e); return; }
            if (e.Item.Name == "desktop-connection") {
                e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
                bool connected = e.Item.Text.Contains("Connected") || e.Item.Text.StartsWith("Saved", StringComparison.Ordinal);
                int diameter = Math.Max(5, e.Item.Height / 5), left = 12;
                using (var brush = new SolidBrush(connected ? Color.FromArgb(72, 190, 134) : Color.FromArgb(220, 164, 63))) e.Graphics.FillEllipse(brush, left, (e.Item.Height - diameter) / 2, diameter, diameter);
                var bounds = new Rectangle(left + diameter + 8, 0, e.Item.Width - left - diameter - 12, e.Item.Height);
                string status = e.Item.Text.Replace("LOCAL / ", "");
                TextRenderer.DrawText(e.Graphics, status, e.TextFont, bounds, muted, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.SingleLine);
                return;
            }
            e.TextColor = e.Item.Enabled ? text : muted;
            base.OnRenderItemText(e);
        }
        private void Navigation(ToolStripItemTextRenderEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float x = e.Item.Width / 2f, y = e.Item.Height / 2f, radius = Math.Min(7, e.Item.Height * 0.23f);
            using (var pen = new Pen(e.Item.Enabled ? text : Mix(background, text, 0.28), 1.6f)) {
                pen.StartCap = pen.EndCap = LineCap.Round; pen.LineJoin = LineJoin.Round;
                if (e.Item.Name == "desktop-reload") {
                    e.Graphics.DrawArc(pen, x - radius, y - radius, radius * 2, radius * 2, 40, 290);
                    e.Graphics.DrawLines(pen, new[] { new PointF(x + radius - 5, y - radius - 1), new PointF(x + radius, y - radius - 1), new PointF(x + radius, y - radius + 4) });
                } else {
                    float direction = e.Item.Name == "desktop-back" ? -1 : 1;
                    e.Graphics.DrawLine(pen, x - radius * direction, y, x + radius * direction, y);
                    e.Graphics.DrawLines(pen, new[] { new PointF(x + direction * (radius - 5), y - 5), new PointF(x + direction * radius, y), new PointF(x + direction * (radius - 5), y + 5) });
                }
            }
        }
        private static GraphicsPath Round(Rectangle r, int radius)
        {
            var path = new GraphicsPath(); int diameter = radius * 2;
            path.AddArc(r.Left, r.Top, diameter, diameter, 180, 90); path.AddArc(r.Right - diameter, r.Top, diameter, diameter, 270, 90);
            path.AddArc(r.Right - diameter, r.Bottom - diameter, diameter, diameter, 0, 90); path.AddArc(r.Left, r.Bottom - diameter, diameter, diameter, 90, 90); path.CloseFigure(); return path;
        }
    }
}
