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
[assembly: System.Reflection.AssemblyVersion("0.6.2.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.6.2.0")]

namespace RaveLink.Core.WindowsHost
{
    internal static class Program
    {
        private const string MutexName = "Local\\RaveLink-Core-v0.6";
        internal const string ExitEventName = "Local\\RaveLink-Core-Exit-v0.6";

        [STAThread]
        private static void Main(string[] args)
        {
            if (HasArgument(args, "--stop"))
            {
                SignalHostExit();
                ServerControl.RequestStopAsync(ServerControl.Port()).GetAwaiter().GetResult();
                return;
            }

            bool ownsMutex;
            using (var mutex = new Mutex(true, MutexName, out ownsMutex))
            {
                if (!ownsMutex)
                {
                    ServerControl.OpenDashboard(ServerControl.Port());
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new CoreApplicationContext(AppDomain.CurrentDomain.BaseDirectory));
            }
        }

        private static bool HasArgument(string[] args, string expected)
        {
            foreach (var value in args)
                if (String.Equals(value, expected, StringComparison.OrdinalIgnoreCase)) return true;
            return false;
        }

        private static void SignalHostExit()
        {
            try
            {
                EventWaitHandle signal;
                if (EventWaitHandle.TryOpenExisting(ExitEventName, out signal))
                    using (signal) signal.Set();
            }
            catch { }
        }
    }

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
        private bool openedDashboard;

        private string PendingUpdatePath { get { return Path.Combine(root, "runtime", "updates", "pending-health.json"); } }
        private string AvailableRollbackPath { get { return Path.Combine(root, "runtime", "updates", "available-rollback.json"); } }

        internal CoreApplicationContext(string rootDirectory)
        {
            root = Path.GetFullPath(rootDirectory);
            uiContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            exitSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ExitEventName);
            exitWait = ThreadPool.RegisterWaitForSingleObject(exitSignal, delegate
            {
                uiContext.Post(async delegate { await ExitAsync(); }, null);
            }, null, Timeout.Infinite, false);
            statusItem = new ToolStripMenuItem("Starting...") { Enabled = false };
            var openItem = new ToolStripMenuItem("Open RaveLink Core", null, delegate { ServerControl.OpenDashboard(ServerControl.Port()); });
            var restartItem = new ToolStripMenuItem("Restart server", null, async delegate { await RestartAsync(); });
            var exitItem = new ToolStripMenuItem("Exit RaveLink Core", null, async delegate { await ExitAsync(); });
            var menu = new ContextMenuStrip();
            menu.Items.Add(openItem);
            menu.Items.Add(statusItem);
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
            tray.DoubleClick += delegate { ServerControl.OpenDashboard(ServerControl.Port()); };
            SystemEvents.SessionEnding += OnSessionEnding;
            StartOrAttachAsync();
        }

        private async void StartOrAttachAsync()
        {
            await lifecycle.WaitAsync();
            try
            {
                int port = ServerControl.Port();
                string expectedUpdateVersion = PendingUpdateVersion();
                if (await ServerControl.IsHealthyVersionAsync(port, expectedUpdateVersion))
                {
                    ConfirmPendingUpdate();
                    SetStatus("Server online", ToolTipIcon.Info);
                    OpenDashboardOnce(port);
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
                string executable = File.Exists(bundledRuntime) ? bundledRuntime : "node.exe";
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
                start.EnvironmentVariables["RAVELINK_WINDOWS_HOST"] = "1";
                start.EnvironmentVariables["RAVELINK_HOST_PID"] = Process.GetCurrentProcess().Id.ToString();
                server = new Process { StartInfo = start, EnableRaisingEvents = true };
                server.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) HostLog.Write(root, e.Data); };
                server.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if (e.Data != null) HostLog.Write(root, e.Data); };
                server.Exited += delegate { OnServerExited(); };
                if (!server.Start())
                {
                    SetStatus("Server failed to start", ToolTipIcon.Error);
                    return;
                }
                server.BeginOutputReadLine();
                server.BeginErrorReadLine();
                job = NativeJob.CreateAndAssign(server.Handle);

                for (int attempt = 0; attempt < 60 && !server.HasExited; attempt++)
                {
                    if (await ServerControl.IsHealthyVersionAsync(port, expectedUpdateVersion))
                    {
                        ConfirmPendingUpdate();
                        SetStatus("Server online", ToolTipIcon.Info);
                        OpenDashboardOnce(port);
                        return;
                    }
                    await Task.Delay(250);
                }
                SetStatus("Server did not become ready", ToolTipIcon.Error);
                if (!String.IsNullOrEmpty(expectedUpdateVersion)) await RollbackPendingUpdateAsync();
            }
            catch (Exception error)
            {
                HostLog.Write(root, "Host startup failed: " + error.GetType().Name);
                SetStatus("Server startup failed", ToolTipIcon.Error);
                if (File.Exists(PendingUpdatePath)) uiContext.Post(async delegate { await RollbackPendingUpdateAsync(); }, null);
            }
            finally { lifecycle.Release(); }
        }

        private async Task RestartAsync()
        {
            if (exiting) return;
            await lifecycle.WaitAsync();
            try { await StopServerAsync(); }
            finally { lifecycle.Release(); }
            StartOrAttachAsync();
        }

        private async Task ExitAsync()
        {
            if (exiting) return;
            exiting = true;
            statusItem.Text = "Stopping...";
            await lifecycle.WaitAsync();
            try { await StopServerAsync(); }
            finally { lifecycle.Release(); }
            FinishExit();
        }

        private async Task StopServerAsync()
        {
            await ServerControl.RequestStopAsync(ServerControl.Port());
            for (int attempt = 0; attempt < 28; attempt++)
            {
                if ((server == null || server.HasExited) && !await ServerControl.IsHealthyAsync(ServerControl.Port())) break;
                await Task.Delay(250);
            }
            if (server != null && !server.HasExited) NativeJob.Close(ref job);
            if (server != null) { server.Dispose(); server = null; }
            NativeJob.Close(ref job);
        }

        private void OnServerExited()
        {
            if (exiting) return;
            uiContext.Post(delegate { if (!exiting) SetStatus("Server stopped", ToolTipIcon.Warning); }, null);
        }

        private string PendingUpdateVersion()
        {
            try
            {
                if (!File.Exists(PendingUpdatePath)) return "";
                string json = File.ReadAllText(PendingUpdatePath, Encoding.UTF8);
                var match = System.Text.RegularExpressions.Regex.Match(json, "\\\"updatedVersion\\\"\\s*:\\s*\\\"(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\\"");
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
            try { StopServerAsync().Wait(4500); }
            catch { }
            FinishExit();
        }

        private void FinishExit()
        {
            SystemEvents.SessionEnding -= OnSessionEnding;
            exitWait.Unregister(null);
            exitSignal.Dispose();
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        private void OpenDashboardOnce(int port)
        {
            if (openedDashboard) return;
            openedDashboard = true;
            ServerControl.OpenDashboard(port);
        }

        private void SetStatus(string value, ToolTipIcon icon)
        {
            statusItem.Text = value;
            tray.Text = value.Length > 63 ? value.Substring(0, 63) : value;
            tray.BalloonTipTitle = "RaveLink Core";
            tray.BalloonTipText = value;
            tray.BalloonTipIcon = icon;
            tray.ShowBalloonTip(1200);
        }

        private static string Quote(string value) { return "\"" + value.Replace("\"", "\\\"") + "\""; }
    }

    internal static class ServerControl
    {
        internal static int Port()
        {
            int value;
            return Int32.TryParse(Environment.GetEnvironmentVariable("PORT"), out value) && value > 0 && value <= 65535 ? value : 5050;
        }

        internal static async Task<bool> IsHealthyAsync(int port)
        {
            return await IsHealthyVersionAsync(port, "");
        }

        internal static async Task<bool> IsHealthyVersionAsync(int port, string expectedVersion)
        {
            try
            {
                var request = WebRequest.CreateHttp("http://127.0.0.1:" + port + "/health");
                request.Method = "GET";
                request.Timeout = 800;
                using (var response = (HttpWebResponse)await request.GetResponseAsync())
                using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
                {
                    if (response.StatusCode != HttpStatusCode.OK) return false;
                    if (String.IsNullOrEmpty(expectedVersion)) return true;
                    string body = await reader.ReadToEndAsync();
                    return body.Contains("\"version\":\"" + expectedVersion + "\"");
                }
            }
            catch { return false; }
        }

        internal static async Task RequestStopAsync(int port)
        {
            try
            {
                var request = WebRequest.CreateHttp("http://127.0.0.1:" + port + "/system/stop");
                request.Method = "POST";
                request.ContentType = "application/json";
                request.ContentLength = 2;
                request.Timeout = 1500;
                using (var stream = await request.GetRequestStreamAsync())
                {
                    byte[] body = Encoding.ASCII.GetBytes("{}");
                    await stream.WriteAsync(body, 0, body.Length);
                }
                using (var response = (HttpWebResponse)await request.GetResponseAsync()) { }
            }
            catch { }
        }

        internal static void OpenDashboard(int port)
        {
            try { Process.Start(new ProcessStartInfo("http://127.0.0.1:" + port) { UseShellExecute = true }); }
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
            if (handle == IntPtr.Zero) return;
            CloseHandle(handle);
            handle = IntPtr.Zero;
        }
    }
}
