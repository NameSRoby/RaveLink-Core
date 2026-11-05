using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

namespace RaveLink.Core.WindowsHost
{
    internal static class DesktopPolicy
    {
        internal static Assembly ResolveDependency(object sender, ResolveEventArgs args)
        {
            string name = new AssemblyName(args.Name).Name;
            if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
            string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "runtime", "desktop", name + ".dll");
            return File.Exists(file) ? Assembly.LoadFrom(file) : null;
        }

        internal static bool IsWorkspace(string address, int port)
        {
            Uri uri;
            return Uri.TryCreate(address, UriKind.Absolute, out uri) && uri.Scheme == "http" &&
                uri.Host == "127.0.0.1" && uri.Port == port && String.IsNullOrEmpty(uri.UserInfo);
        }

        internal static bool IsExternalWeb(string address)
        {
            Uri uri;
            return !String.IsNullOrEmpty(address) && address.Length <= 16384 &&
                Uri.TryCreate(address, UriKind.Absolute, out uri) &&
                (uri.Scheme == "https" || uri.Scheme == "http") && String.IsNullOrEmpty(uri.UserInfo);
        }

        internal static string ProfilePath(string root, int port)
        {
            string identity = Path.GetFullPath(root).TrimEnd('\\').ToUpperInvariant() + ":" + port;
            using (var hash = SHA256.Create()) {
                string id = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(identity))).Replace("-", "").Substring(0, 24);
                return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RaveLink", "Core", "WebView2", id);
            }
        }

        internal static bool ReadTheme(string json, out Color background, out Color accent, out Color text)
        {
            background = Color.FromArgb(5, 5, 7); accent = Color.FromArgb(139, 0, 31); text = Color.FromArgb(234, 234, 234);
            if (String.IsNullOrEmpty(json) || json.Length > 512) return false;
            try {
                var value = new JavaScriptSerializer { MaxJsonLength = 512 }.DeserializeObject(json) as Dictionary<string, object>;
                if (value == null || value.Count != 4 || !value.ContainsKey("type") || !Object.Equals(value["type"], "ravelink-theme")) return false;
                Color[] colors = new Color[3]; int i = 0;
                foreach (string key in new[] { "background", "accent", "text" }) {
                    object item;
                    if (!value.TryGetValue(key, out item) || !(item is string) ||
                        !System.Text.RegularExpressions.Regex.IsMatch((string)item, "^#[0-9a-fA-F]{6}$")) return false;
                    colors[i++] = ColorTranslator.FromHtml((string)item);
                }
                background = colors[0]; accent = colors[1]; text = colors[2]; return true;
            } catch { return false; }
        }

        internal static string ThemeScript(int port)
        {
            string origin = new JavaScriptSerializer().Serialize(ServerControl.DashboardUrl(port).TrimEnd('/'));
            return @"(() => {
if (window.top !== window || location.origin !== " + origin + @") return;
const send = () => {
  const css = getComputedStyle(document.documentElement);
  const hex = (key, fallback) => /^#[0-9a-f]{6}$/i.test(css.getPropertyValue(key).trim()) ? css.getPropertyValue(key).trim() : fallback;
  window.chrome.webview.postMessage({ type: 'ravelink-theme', background: hex('--bg','#050507'), accent: hex('--accent','#8b001f'), text: hex('--text','#eaeaea') });
};
addEventListener('DOMContentLoaded', () => {
  send(); new MutationObserver(send).observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
}, { once: true });
})();";
        }
    }
}
