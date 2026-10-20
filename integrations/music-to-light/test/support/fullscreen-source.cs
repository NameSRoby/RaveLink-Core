// Owned silent test application. It never plays or captures operator audio.
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class FullscreenSource
{
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [STAThread]
    private static void Main()
    {
        var source = new Form {
            Text = "RaveLink fullscreen capture regression",
            FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual,
            Bounds = Screen.PrimaryScreen.Bounds,
            BackColor = Color.Black
        };
        source.Shown += delegate {
            // The child console starts hidden; explicitly show only this owned
            // test window before asking Windows for foreground selection.
            ShowWindow(source.Handle, 5);
            source.Activate();
            if (!SetForegroundWindow(source.Handle)) {
                Console.WriteLine("FOCUS_UNAVAILABLE");
                source.Close();
                return;
            }
            Console.WriteLine("FULLSCREEN_READY");
            Console.Out.Flush();
            var commands = new Thread(delegate() {
                string command;
                while ((command = Console.ReadLine()) != null) {
                    if (command == "background") {
                        source.BeginInvoke((Action)delegate {
                            // Losing fullscreen focus must not end process capture.
                            source.WindowState = FormWindowState.Minimized;
                            Console.WriteLine("SOURCE_BACKGROUNDED");
                            Console.Out.Flush();
                        });
                    }
                    if (command == "stop") break;
                }
                source.BeginInvoke((Action)delegate { source.Close(); });
            });
            commands.IsBackground = true;
            commands.Start();
        };
        Application.Run(source);
    }
}
