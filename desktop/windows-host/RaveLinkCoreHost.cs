// Windows tray host. Application policy stays in Node; this process owns the
// single-instance boundary, server child, tray UI, and update health handshake.
// See docs/DEVELOPMENT.md, "Windows host and updates", before changing ownership.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("RaveLink Core")]
[assembly: System.Reflection.AssemblyDescription("RaveLink Core Windows runtime host")]
[assembly: System.Reflection.AssemblyCompany("NameSRoby")]
[assembly: System.Reflection.AssemblyProduct("RaveLink Core")]
[assembly: System.Reflection.AssemblyVersion("0.7.4.2")]
[assembly: System.Reflection.AssemblyFileVersion("0.7.4.2")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.7.4b")]

namespace RaveLink.Core.WindowsHost
{
    internal static class Program
    {
        // These names are stable across upgrades. The v0.6 suffix is an IPC
        // compatibility identifier, not the current product version: renaming
        // it would allow old and new hosts to compete for the same local port.
        private const string MutexName = "Local\\RaveLink-Core-v0.6";
        internal const string ExitEventName = "Local\\RaveLink-Core-Exit-v0.6";
        internal const string RestartEventName = "Local\\RaveLink-Core-Restart-v0.6";
        internal const string OpenEventName = "Local\\RaveLink-Core-Open-v0.6";
        internal static string Scoped(string name) { return ServerControl.Port() == 5050 ? name : name + "-" + ServerControl.Port(); }

        [STAThread]
        private static void Main(string[] args)
        {
            if (HasArgument(args, "--stop"))
            {
                SignalHostEvent(ExitEventName);
                ServerControl.RequestStopAsync(ServerControl.Port()).GetAwaiter().GetResult();
                return;
            }

            bool ownsMutex;
            using (var mutex = new Mutex(true, Scoped(MutexName), out ownsMutex))
            {
                if (!ownsMutex)
                {
                    if (!SignalHostEvent(HasArgument(args, "--restart") ? RestartEventName : OpenEventName))
                        MessageBox.Show("An older RaveLink instance is already running. Exit it from the tray (or Task Manager if it is stuck), then launch again. Dashboard: " + ServerControl.DashboardUrl(ServerControl.Port()), "RaveLink Core");
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new CoreApplicationContext(AppDomain.CurrentDomain.BaseDirectory, HasArgument(args, "--background")));
            }
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (var value in args)
                if (String.Equals(value, expected, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static bool SignalHostEvent(string name)
        {
            try
            {
                EventWaitHandle signal;
                if (EventWaitHandle.TryOpenExisting(Scoped(name), out signal))
                    using (signal) { signal.Set(); return true; }
            }
            catch { }
            return false;
        }
    }

    // ApplicationContext keeps the message loop alive without a main window.
    // All async UI callbacks must respect the exiting flag, and shutdown must
    // release the tray icon and native job handle even if Node is unresponsive.
    internal sealed class CoreApplicationContext : ApplicationContext
    {
        private readonly string root;
        private readonly NotifyIcon tray;
        private readonly ToolStripMenuItem statusItem;
        private readonly SemaphoreSlim lifecycle = new SemaphoreSlim(1, 1);
        private readonly SynchronizationContext uiContext;
        private readonly EventWaitHandle exitSignal;
        private readonly RegisteredWaitHandle exitWait;
        private Process server;
        private IntPtr job = IntPtr.Zero;
        private bool exiting;
        private readonly object exitDeadlineLock = new object();
        private bool exitDeadlineArmed;
        private bool openedDashboard;
        private readonly bool background;
        private readonly EventWaitHandle restartSignal;
        private readonly RegisteredWaitHandle restartWait;
        private bool stopping;
        private bool restarting;
        private CancellationTokenSource startupCancellation = new CancellationTokenSource();
        private readonly Form launcher;
        private readonly Label launcherStatus;
        private readonly EventWaitHandle openSignal;
        private readonly RegisteredWaitHandle openWait;

        private string PendingUpdatePath { get { return Path.Combine(root, "runtime", "updates", "pending-health.json"); } }
        private string AvailableRollbackPath { get { return Path.Combine(root, "runtime", "updates", "available-rollback.json"); } }

        internal CoreApplicationContext(string rootDirectory, bool backgroundStartup = false)
        {
            root = Path.GetFullPath(rootDirectory);
            background = backgroundStartup;
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.Scoped(Program.ExitEventName));
            exitWait = ThreadPool.RegisterWaitForSingleObject(exitSignal, delegate
            {
                ArmExitDeadline();
                uiContext.Post(async delegate { await ExitAsync(); }, null);
            }, null, Timeout.Infinite, false);
            statusItem = new ToolStripMenuItem("Starting...") { Enabled = false };
            var openItem = new ToolStripMenuItem("Open dashboard / status", null, async delegate { await OpenOrExplainAsync(); });
            var restartItem = new ToolStripMenuItem("Restart server", null, async delegate { await RestartAsync(); });
            var exitItem = new ToolStripMenuItem("Exit RaveLink Core", null, async delegate { await ExitAsync(); });
            var menu = new ContextMenuStrip();
            menu.Items.Add(openItem);
            menu.Items.Add(statusItem);
            menu.Items.Add("Copy dashboard address", null, delegate { Clipboard.SetText(ServerControl.DashboardUrl(ServerControl.Port())); });
            menu.Items.Add("Open startup log", null, delegate { OpenLog(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(restartItem);
            menu.Items.Add(exitItem);
            var applicationIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;
            tray = new NotifyIcon
            {
                Icon = applicationIcon,
                Text = "RaveLink Core",
                ContextMenuStrip = menu,
                Visible = true
            };
            launcher = new Form { Text = "RaveLink Core", ClientSize = new Size(580, 240), StartPosition = FormStartPosition.CenterScreen, FormBorderStyle = FormBorderStyle.FixedDialog, MaximizeBox = false, Icon = applicationIcon };
            launcherStatus = new Label { Text = "Starting RaveLink Core...", Left = 20, Top = 20, Width = 540, Height = 66 };
            var address = new TextBox { Text = ServerControl.DashboardUrl(ServerControl.Port()), ReadOnly = true, Left = 20, Top = 96, Width = 540 };
            var openButton = new Button { Text = "Open dashboard", Left = 20, Top = 136, Width = 160, Height = 32 };
            openButton.Click += async delegate { await OpenOrExplainAsync(); };
            var restartButton = new Button { Text = "Restart server", Left = 190, Top = 136, Width = 150, Height = 32 };
            restartButton.Click += async delegate { await RestartAsync(); };
            var logButton = new Button { Text = "Startup log", Left = 350, Top = 136, Width = 100, Height = 32 };
            logButton.Click += delegate { OpenLog(); };
            var exitButton = new Button { Text = "Exit", Left = 460, Top = 136, Width = 100, Height = 32 };
            exitButton.Click += async delegate { await ExitAsync(); };
            launcher.Controls.AddRange(new Control[] { launcherStatus, address, openButton, restartButton, logButton, exitButton, new Label { Text = "You can reopen this window from the tray. Copy the address above if your browser does not open.", Left = 20, Top = 185, Width = 540, Height = 40 } });
            launcher.FormClosing += delegate(object sender, FormClosingEventArgs e) { if (!exiting) { e.Cancel = true; launcher.Hide(); } };
            if (!background) launcher.Show();
            restartSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.Scoped(Program.RestartEventName));
            restartWait = ThreadPool.RegisterWaitForSingleObject(restartSignal, delegate { uiContext.Post(async delegate { await RestartAsync(); }, null); }, null, Timeout.Infinite, false);
            openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.Scoped(Program.OpenEventName));
            openWait = ThreadPool.RegisterWaitForSingleObject(openSignal, delegate { uiContext.Post(async delegate { await OpenOrExplainAsync(); }, null); }, null, Timeout.Infinite, false);
            tray.DoubleClick += async delegate { await OpenOrExplainAsync(); };
            SystemEvents.SessionEnding += OnSessionEnding;
            StartOrAttachAsync();
        }

        // A healthy existing server can be attached without launching another
        // child. After an update, health must confirm the expected version before
        // rollback information is retired; process existence alone is insufficient.
        private async void StartOrAttachAsync()
        {
            await lifecycle.WaitAsync();
            try
            {
                if (exiting) return;
                int port = ServerControl.Port();
                HostLog.Write(root, "Starting server at " + ServerControl.DashboardUrl(port));
                string expectedUpdateVersion = PendingUpdateVersion();
                if (await ServerControl.IsHealthyVersionAsync(port, expectedUpdateVersion))
                {
                    ConfirmPendingUpdate();
                    SetStatus("Server online", ToolTipIcon.Info);
                    OpenDashboardOnce(port);
                    return;
                }

                if (await ServerControl.PortOccupiedAsync(port)) {
                    SetStatus("Port " + port + " is already in use. Close the older RaveLink / Bridge instance or choose another port.", ToolTipIcon.Error);
                    return;
                }
                string entryName = File.Exists(Path.Combine(root, "config", "mod-platform.enabled"))
                    ? "combined-enabled-server.js"
                    : "feature-enabled-server.js";
                string entry = Path.Combine(root, "src", "app", "optional", entryName);
                if (!File.Exists(entry))
                {
                    SetStatus("Server files missing", ToolTipIcon.Error);
                    return;
                }

                string bundledRuntime = Path.Combine(root, "runtime", "RaveLink-Core-Node.exe");
                if (!File.Exists(bundledRuntime)) throw new FileNotFoundException("Bundled Node runtime is missing. Reinstall or run Start-RaveLink.cmd for a source download.");
                string executable = bundledRuntime;
                var start = new ProcessStartInfo
                {
                    FileName = executable,
                    Arguments = Quote(entry),
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                start.EnvironmentVariables["PORT"] = port.ToString();
                start.EnvironmentVariables["HOST"] = "127.0.0.1";
                start.EnvironmentVariables["RAVELINK_WINDOWS_HOST"] = "1";
                start.EnvironmentVariables["RAVELINK_HOST_PID"] = Process.GetCurrentProcess().Id.ToString();
                server = new Process { StartInfo = start, EnableRaisingEvents = true };
                server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) HostLog.Write(root, e.Data); };
                server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) HostLog.Write(root, e.Data); };
                Process ownedServer = server;
                server.Exited += delegate { if (Object.ReferenceEquals(server, ownedServer)) OnServerExited(); };
                if (!server.Start())
                {
                    SetStatus("Server failed to start", ToolTipIcon.Error);
                    return;
                }
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
                job = NativeJob.CreateAndAssign(server.Handle);

                for (int attempt = 0; attempt < 40 && !exiting && !startupCancellation.IsCancellationRequested && !server.HasExited; attempt++)
                {
                    if (await ServerControl.IsHealthyVersionAsync(port, expectedUpdateVersion))
                    {
                        ConfirmPendingUpdate();
                        SetStatus("Server online", ToolTipIcon.Info);
                        OpenDashboardOnce(port);
                        return;
                    }
                    await Task.Delay(250, startupCancellation.Token);
                }
                if (exiting || startupCancellation.IsCancellationRequested) return;
                SetStatus(server.HasExited ? "Server exited during startup (code " + server.ExitCode + "). Open the startup log for details." : "Server did not become ready. Open the startup log, then retry.", ToolTipIcon.Error);
                if (!String.IsNullOrEmpty(expectedUpdateVersion)) await RollbackPendingUpdateAsync();
            }
            catch (OperationCanceledException) { }
            catch (Exception error)
            {
                HostLog.Write(root, "Host startup failed: " + error.GetType().Name + ": " + error.Message);
                SetStatus("Startup failed: " + error.Message, ToolTipIcon.Error);
                if (File.Exists(PendingUpdatePath)) uiContext.Post(async delegate { await RollbackPendingUpdateAsync(); }, null);
            }
            finally { lifecycle.Release(); }
        }

        private async Task RestartAsync()
        {
            if (exiting || restarting) return;
            restarting = true;
            startupCancellation.Cancel();
            await lifecycle.WaitAsync();
            try { await StopServerAsync(); openedDashboard = false; }
            catch (Exception error) { HostLog.Write(root, "Restart failed: " + error.Message); }
            finally { lifecycle.Release(); restarting = false; }
            // A new startup needs a new cancellation lifetime.
            startupCancellation.Dispose();
            startupCancellation = new CancellationTokenSource();
            StartOrAttachAsync();
        }

        private void ArmExitDeadline()
        {
            lock (exitDeadlineLock) {
                if (exitDeadlineArmed) return;
                exitDeadlineArmed = true;
                var deadline = new Thread(delegate() {
                    Thread.Sleep(8000);
                    try { NativeJob.Close(ref job); if (server != null && !server.HasExited) server.Kill(); } catch { }
                    finally { Process.GetCurrentProcess().Kill(); }
                });
                deadline.IsBackground = true;
                deadline.Name = "RaveLink exit deadline";
                deadline.Start();
            }
        }

        private async Task ExitAsync()
        {
            if (exiting) return;
            exiting = true;
            ArmExitDeadline();
            startupCancellation.Cancel();
            statusItem.Text = "Stopping...";
            await lifecycle.WaitAsync();
            try { await StopServerAsync(); }
            catch (Exception error) { HostLog.Write(root, "Stop failed: " + error.Message); }
            finally { lifecycle.Release(); FinishExit(); }
        }

        private async Task StopServerAsync()
        {
            stopping = true;
            try {
                await ServerControl.RequestStopAsync(ServerControl.Port());
                var deadline = Stopwatch.StartNew();
                while (deadline.ElapsedMilliseconds < 3000) {
                    if (server != null ? server.HasExited : !await ServerControl.IsHealthyAsync(ServerControl.Port())) break;
                    await Task.Delay(100);
                }
                if (server != null && !server.HasExited) {
                    NativeJob.Close(ref job);
                    if (!server.HasExited) { try { server.Kill(); } catch (InvalidOperationException) { } }
                }
            }
            finally {
                NativeJob.Close(ref job);
                if (server != null) { server.Dispose(); server = null; }
                stopping = false;
            }
        }

        private async Task OpenOrExplainAsync()
        {
            if (exiting) return;
            launcher.Show(); launcher.WindowState = FormWindowState.Normal; launcher.Activate();
            if (await ServerControl.IsHealthyAsync(ServerControl.Port())) ServerControl.OpenDashboard(ServerControl.Port());
            else if (!restarting) SetStatus("Dashboard unavailable while the server is starting or stopped. Check the startup log or restart.", ToolTipIcon.Warning);
        }

        private void OpenLog()
        {
            try {
                string directory = Path.Combine(root, "runtime", "logs"); Directory.CreateDirectory(directory);
                string file = Path.Combine(directory, "windows-host.log");
                if (!File.Exists(file)) HostLog.Write(root, "No server output yet.");
                Process.Start(new ProcessStartInfo(file) { UseShellExecute = true });
            } catch { launcher.Show(); }
        }

        private void OnServerExited()
        {
            if (exiting || stopping) return;
            uiContext.Post(delegate { if (!exiting && !stopping) SetStatus("Server stopped. Open the startup log for details.", ToolTipIcon.Warning); }, null);
        }

        private string PendingUpdateVersion()
        {
            try
            {
                if (!File.Exists(PendingUpdatePath)) return "";
                string json = File.ReadAllText(PendingUpdatePath, Encoding.UTF8);
                var match = System.Text.RegularExpressions.Regex.Match(json, "\\\"updatedVersion\\\"\\s*:\\s*\\\"(?<version>[0-9]+\\.[0-9]+\\.[0-9]+[a-z]?)\\\"");
                return match.Success ? match.Groups["version"].Value : "invalid";
            }
            catch { return "invalid"; }
        }

        private void ConfirmPendingUpdate()
        {
            try
            {
                if (!File.Exists(PendingUpdatePath)) return;
                Directory.CreateDirectory(Path.GetDirectoryName(AvailableRollbackPath));
                if (File.Exists(AvailableRollbackPath)) File.Delete(AvailableRollbackPath);
                File.Move(PendingUpdatePath, AvailableRollbackPath);
                string staged = Path.Combine(root, "runtime", "updates", "staged.json");
                if (File.Exists(staged)) File.Delete(staged);
                HostLog.Write(root, "Update health check passed; rollback snapshot retained.");
            }
            catch (Exception error) { HostLog.Write(root, "Could not confirm update: " + error.GetType().Name); }
        }

        private async Task RollbackPendingUpdateAsync()
        {
            if (exiting) return;
            exiting = true;
            SetStatus("Update failed; restoring previous version", ToolTipIcon.Error);
            await StopServerAsync();
            try
            {
                string runner = Path.Combine(root, "runtime", "updates", "ravelink-update-runner.ps1");
                if (!File.Exists(runner)) throw new FileNotFoundException("Update rollback helper is missing.", runner);
                var rollback = new ProcessStartInfo
                {
                    FileName = "powershell.exe",
                    Arguments = "-NoProfile -ExecutionPolicy Bypass -File " + Quote(runner) + " -Action Rollback -Root " + Quote(root) + " -HostPid " + Process.GetCurrentProcess().Id,
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                Process.Start(rollback);
                HostLog.Write(root, "Automatic rollback started.");
            }
            catch (Exception error) { HostLog.Write(root, "Automatic rollback could not start: " + error.GetType().Name); }
            FinishExit();
        }

        private void OnSessionEnding(object sender, SessionEndingEventArgs args)
        {
            if (exiting) return;
            exiting = true;
            startupCancellation.Cancel();
            try { Task.Run(async delegate { await StopServerAsync(); }).Wait(4500); }
            catch { }
            finally { NativeJob.Close(ref job); }
            FinishExit();
        }

        private void FinishExit()
        {
            SystemEvents.SessionEnding -= OnSessionEnding;
            restartWait.Unregister(null); restartSignal.Dispose();
            openWait.Unregister(null);
            openSignal.Dispose();
            startupCancellation.Cancel();
            launcher.Dispose();
            exitWait.Unregister(null);
            exitSignal.Dispose();
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        private void OpenDashboardOnce(int port)
        {
            if (openedDashboard || background) return;
            openedDashboard = true;
            ServerControl.OpenDashboard(port);
        }

        private void SetStatus(string value, ToolTipIcon icon)
        {
            launcherStatus.Text = value;
            if (icon == ToolTipIcon.Error && !background) { launcher.Show(); launcher.Activate(); }
            statusItem.Text = value.Length > 90 ? value.Substring(0, 90) : value;
            tray.Text = value.Length > 63 ? value.Substring(0, 63) : value;
            tray.BalloonTipTitle = "RaveLink Core";
            tray.BalloonTipText = value;
            tray.BalloonTipIcon = icon;
            tray.ShowBalloonTip(1200);
        }

        private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    }

    // Loopback HTTP operations use finite deadlines. Keep launch/stop behavior
    // separate from update verification so an unrelated listener cannot confirm
    // a different application version as successfully installed.
    internal static class ServerControl
    {
        internal static int Port()
        {
            int value;
            return Int32.TryParse(Environment.GetEnvironmentVariable("PORT"), out value) && value > 0 && value <= 65535 ? value : 5050;
        }

        internal static string DashboardUrl(int port) { return "http://127.0.0.1:" + port + "/"; }

        internal static async Task<bool> PortOccupiedAsync(int port)
        {
            using (var client = new System.Net.Sockets.TcpClient()) {
                try {
                    var connect = client.ConnectAsync("127.0.0.1", port);
                    if (await Task.WhenAny(connect, Task.Delay(500)) != connect) {
                        client.Close();
                        try { await connect; } catch { }
                        return false;
                    }
                    await connect; return true;
                } catch { return false; }
            }
        }

        internal static Task<bool> IsHealthyAsync(int port) { return IsHealthyVersionAsync(port, ""); }

        internal static HttpWebRequest Request(int port, string route)
        {
            var request = WebRequest.CreateHttp(DashboardUrl(port).TrimEnd('/') + route);
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.KeepAlive = false;
            return request;
        }

        internal static System.Threading.Timer Deadline(HttpWebRequest request, int milliseconds)
        {
            // HttpWebRequest.Timeout does not bound GetResponseAsync or stream reads.
            return new System.Threading.Timer(delegate { try { request.Abort(); } catch { } }, null, milliseconds, Timeout.Infinite);
        }

        internal static async Task<bool> IsHealthyVersionAsync(int port, string expectedVersion)
        {
            var request = Request(port, "/health");
            using (Deadline(request, 800)) {
                try {
                    using (var response = (HttpWebResponse)await request.GetResponseAsync())
                    using (var stream = response.GetResponseStream())
                    using (var contents = new MemoryStream()) {
                        if (response.StatusCode != HttpStatusCode.OK) return false;
                        byte[] buffer = new byte[1024]; int count;
                        while ((count = await stream.ReadAsync(buffer, 0, buffer.Length)) > 0) {
                            if (contents.Length + count > 8192) return false;
                            contents.Write(buffer, 0, count);
                        }
                        string body = Encoding.UTF8.GetString(contents.ToArray());
                        if (!body.Contains("\"ok\":true") || !body.Contains("\"profile\":\"clean-slate-core")) return false;
                        return String.IsNullOrEmpty(expectedVersion) || body.Contains("\"version\":\"" + expectedVersion + "\"");
                    }
                } catch { return false; }
            }
        }

        internal static async Task RequestStopAsync(int port)
        {
            // Never send a stop request to an unrelated application on this port.
            if (!await IsHealthyAsync(port)) return;
            var request = Request(port, "/system/stop");
            request.Method = "POST"; request.ContentType = "application/json"; request.ContentLength = 2;
            using (Deadline(request, 1500)) {
                try {
                    using (var stream = await request.GetRequestStreamAsync()) {
                        byte[] body = Encoding.ASCII.GetBytes("{}"); await stream.WriteAsync(body, 0, body.Length);
                    }
                    using (var response = (HttpWebResponse)await request.GetResponseAsync()) { }
                } catch { }
            }
        }

        internal static void OpenDashboard(int port)
        {
            try { Process.Start(new ProcessStartInfo(DashboardUrl(port)) { UseShellExecute = true }); }
            catch { }
        }
    }

    internal static class HostLog
    {
        private static readonly object Sync = new object();
        internal static void Write(string root, string value)
        {
            try
            {
                lock (Sync)
                {
                    string directory = Path.Combine(root, "runtime", "logs");
                    Directory.CreateDirectory(directory);
                    string path = Path.Combine(directory, "windows-host.log");
                    if (File.Exists(path) && new FileInfo(path).Length > 1024 * 1024)
                    {
                        string previous = path + ".previous";
                        if (File.Exists(previous)) File.Delete(previous);
                        File.Move(path, previous);
                    }
                    File.AppendAllText(path, DateTimeOffset.Now.ToString("o") + " " + value + Environment.NewLine, Encoding.UTF8);
                }
            }
            catch { }
        }
    }

    // A Windows job object ties the managed Node child to this host's lifetime.
    // Closing the last handle terminates owned children, including abnormal host
    // exit. Do not add an attached, independently owned server to this job.
    internal static class NativeJob
    {
        private const uint KillOnJobClose = 0x00002000;

        [StructLayout(LayoutKind.Sequential)] private struct IoCounters { public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct BasicLimits { public Int64 PerProcessUserTimeLimit, PerJobUserTimeLimit; public UInt32 LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public UInt32 ActiveProcessLimit; public UIntPtr Affinity; public UInt32 PriorityClass, SchedulingClass; }
        [StructLayout(LayoutKind.Sequential)] private struct ExtendedLimits { public BasicLimits BasicLimitInformation; public IoCounters IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
        [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

        internal static IntPtr CreateAndAssign(IntPtr process)
        {
            IntPtr handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) return IntPtr.Zero;
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = KillOnJobClose;
            int size = Marshal.SizeOf(typeof(ExtendedLimits));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(handle, 9, buffer, (uint)size) || !AssignProcessToJobObject(handle, process))
                {
                    CloseHandle(handle);
                    return IntPtr.Zero;
                }
                return handle;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        internal static void Close(ref IntPtr handle)
        {
            IntPtr owned = Interlocked.Exchange(ref handle, IntPtr.Zero);
            if (owned != IntPtr.Zero) CloseHandle(owned);
        }
    }
}
