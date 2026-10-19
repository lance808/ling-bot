// Ling-bot 启动器（C# 源码，编译成 Ling-bot.exe）
//
// 为什么用 C# 而不是 Electron 打包：
//   打包会把整个 Electron 塞进产物（200MB+），而这个启动器只做一件事——
//   检查环境、然后拉 npm start。用系统自带的 .NET Framework 编译，
//   产物只有几十 KB，零新增依赖。
//
// 它做的检查（顺序不能乱，因为后面的检查依赖前面的结果）：
//   1. Node 是否存在、版本是否 >= 24.22 且 < 25
//   2. 依赖是否已安装（node_modules/electron 在不在）
//   3. 通过后启动 npm start，并把 stdout/stderr 转发到控制台窗口
//
// 失败时：弹出对话框说明**具体缺什么**，并给出下载链接。
// 这一步比"一闪而过"重要得多——双击启动失败的人最需要知道该装什么。

using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Forms;

namespace LingBot
{
    static class Launcher
    {
        // 与 package.json 的 engines 保持一致
        const int MIN_NODE_MAJOR = 24;
        const int MIN_NODE_MINOR = 22;
        const int MAX_NODE_MAJOR = 24;

        const string NODE_DOWNLOAD = "https://nodejs.org/dist/v24.22.0/";
        const string SNOWLUMA_DOWNLOAD = "https://github.com/SnowLuma/SnowLuma/releases";
        const string NPM_MIRROR = "https://npmmirror.com/mirrors/electron/";

        [STAThread]
        static int Main(string[] args)
        {
            // GUI 子系统（静默版）下没有控制台，设置输出编码可能抛异常，
            // 而且 Console.WriteLine 写的是无效句柄——都不能让它把启动搞崩。
            TrySetEncoding();

            // --check-only：只做环境检查并把结果打到控制台，不弹窗、不启动。
            // 这是给自动化测试用的——否则每次测失败路径都要人去点弹窗。
            bool checkOnly = Array.IndexOf(args, "--check-only") >= 0;

            string root = AppDomain.CurrentDomain.BaseDirectory;
            // 编译产物放在 build/ 下，源码在仓库根；两种位置都要能找到 package.json
            if (!File.Exists(Path.Combine(root, "package.json")))
            {
                string parent = Path.GetFullPath(Path.Combine(root, ".."));
                if (File.Exists(Path.Combine(parent, "package.json")))
                    root = parent;
            }

            if (!File.Exists(Path.Combine(root, "package.json")))
            {
                return Problem(checkOnly, "找不到 package.json。\n\n请把 Ling-bot.exe 放在项目根目录（与 package.json 同级），或放在 build 子目录里。",
                     root, null);
            }

            // ---- 1. Node ----
            string nodeExe = FindNode();
            if (nodeExe == null)
            {
                return Problem(checkOnly, "没有找到 Node.js。\n\nLing-bot 需要 Node.js 24.22（或 24.x）。\n装好后重新双击本文件即可。",
                     root, NODE_DOWNLOAD);
            }

            string version = GetNodeVersion(nodeExe);
            if (version == null)
            {
                return Problem(checkOnly, "Node.js 存在但无法获取版本号。\n\n路径：" + nodeExe + "\n请确认安装完整。",
                     root, NODE_DOWNLOAD);
            }

            string verProblem = CheckVersion(version);
            if (verProblem != null)
            {
                return Problem(checkOnly, "Node.js 版本不合适。\n\n当前：" + version + "\n要求：>= 24.22 且 < 25\n\n" + verProblem,
                     root, NODE_DOWNLOAD);
            }

            // ---- 2. 依赖 ----
            // 检查 electron 这个包：它是唯一的重依赖，没有它一定跑不起来
            string electronDir = Path.Combine(root, "node_modules", "electron");
            if (!Directory.Exists(electronDir))
            {
                string msg = "还没安装依赖（node_modules 里没有 electron）。\n\n" +
                             "请在项目目录执行一次：\n    npm install\n\n" +
                             "国内网络如果卡住，先设置镜像：\n    set ELECTRON_MIRROR=" + NPM_MIRROR;
                return Problem(checkOnly, msg, root, null);
            }

            if (checkOnly)
            {
                Say("OK");
                Say("node=" + version);
                Say("path=" + nodeExe);
                Say("root=" + root);
                return 0;
            }

            // ---- 3. 启动 ----
            return Run(root, nodeExe, args);
        }

        /// <summary>
        /// 统一的"出问题"出口：check-only 时只打印，否则弹窗。
        /// </summary>
        static int Problem(bool checkOnly, string message, string root, string url)
        {
            if (checkOnly)
            {
                Say("FAIL " + message.Replace("\r", "").Replace("\n", " | "));
                if (url != null) Say("download=" + url);
                return 1;
            }
            Fail(message, root, url);
            return 1;
        }

        /// <summary>往启动器日志写一行。失败绝不抛。</summary>
        static void LogLine(string logPath, string text)
        {
            try
            {
                File.AppendAllText(logPath,
                    "[" + DateTime.Now.ToString("HH:mm:ss.fff") + "] " + text + "\r\n",
                    Utf8NoBom);
            }
            catch { /* 写不了日志也不能影响启动 */ }
        }

        /// <summary>
        /// 输出一行。
        ///
        /// **总是写文件**，有控制台时额外写控制台。
        ///
        /// 为什么总是写文件：控制台的代码页不一定是 UTF-8，
        /// 通过管道读到 Node 那边再按 UTF-8 解码，中文会变成乱码。
        /// 让自动化测试只依赖文件（明确 UTF-8），就不会受环境影响。
        /// </summary>
        static void Say(string line)
        {
            try
            {
                File.AppendAllText(CheckLogPath, line + "\r\n", Utf8NoBom);
            }
            catch { /* 写不了就算了，不能因此崩 */ }

            try
            {
                if (HasConsole()) Console.WriteLine(line);
            }
            catch { /* 没有控制台时忽略 */ }
        }

        static string CheckLogPath
        {
            get
            {
                string root = AppDomain.CurrentDomain.BaseDirectory;
                try { Directory.CreateDirectory(root); } catch { }
                return Path.Combine(root, "launcher-check.log");
            }
        }

        static bool HasConsole()
        {
            try
            {
                // 标准输出句柄无效时，任何 GetStdHandle 相关操作都会失败
                IntPtr h = GetStdHandle(STD_OUTPUT_HANDLE);
                return h != IntPtr.Zero && h != new IntPtr(-1);
            }
            catch { return false; }
        }

        const int STD_OUTPUT_HANDLE = -11;

        /// <summary>写文件统一用这个：不带 BOM，避免开头多出 ﻿</summary>
        static readonly Encoding Utf8NoBom = new UTF8Encoding(false);

        [System.Runtime.InteropServices.DllImport("kernel32.dll")]
        static extern IntPtr GetStdHandle(int nStdHandle);

        static void TrySetEncoding()
        {
            try { Console.OutputEncoding = Encoding.UTF8; }
            catch { /* GUI 子系统下会抛，忽略 */ }
        }

        /// <summary>
        /// 找 node.exe：先看 PATH，再看几个常见安装位置。
        ///
        /// 为什么不能只依赖 PATH：双击启动时的 PATH 常常和命令行里不一样
        /// （Explorer 启动的进程继承的是登录时的环境）。
        ///
        /// 注意这里**不能写死某个人的自定义安装路径**（比如 D:\Node）。
        /// 那对别人的机器毫无意义，还会掩盖"其实没装 Node"的真实情况——
        /// 表现为"在作者机器上好好的，别人一跑就莫名失败"。
        /// 只列官方安装器的标准位置。
        /// </summary>
        static string FindNode()
        {
            // 1) 当前进程的 PATH
            string pathVar = Environment.GetEnvironmentVariable("PATH") ?? "";
            string found = ScanPath(pathVar);
            if (found != null) return found;

            // 2) 机器级 PATH（用户环境变量里没有、但系统里装了的情况）
            string machinePath = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) ?? "";
            found = ScanPath(machinePath);
            if (found != null) return found;

            // 3) 官方安装器的默认位置
            string[] common =
            {
                @"C:\Program Files\nodejs\node.exe",
                @"C:\Program Files (x86)\nodejs\node.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\nodejs\node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe"),
                // nvm-windows 的默认根目录（它会把当前版本软链到 C:\Program Files\nodejs，
                // 但有时用户直接用 nvm 的版本目录）
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"nvm\node.exe"),
            };
            foreach (string c in common)
                if (File.Exists(c)) return c;

            return null;
        }

        /// <summary>在一个 PATH 串里找 node.exe。</summary>
        static string ScanPath(string pathVar)
        {
            foreach (string dir in pathVar.Split(Path.PathSeparator))
            {
                if (string.IsNullOrWhiteSpace(dir)) continue;
                try
                {
                    string candidate = Path.Combine(dir.Trim().Trim('"'), "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
                catch { /* 非法路径跳过 */ }
            }
            return null;
        }

        static string GetNodeVersion(string nodeExe)
        {
            try
            {
                var psi = new ProcessStartInfo(nodeExe, "--version")
                {
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                };
                using (var p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit(5000);
                    return string.IsNullOrEmpty(outp) ? null : outp;
                }
            }
            catch { return null; }
        }

        /// <summary>返回 null 表示版本合格，否则返回原因。</summary>
        static string CheckVersion(string v)
        {
            Match m = Regex.Match(v, @"v(\d+)\.(\d+)\.(\d+)");
            if (!m.Success) return "无法解析版本号：" + v;

            int major = int.Parse(m.Groups[1].Value);
            int minor = int.Parse(m.Groups[2].Value);

            if (major < MIN_NODE_MAJOR) return "版本太旧，请升级到 24.22。";
            if (major == MIN_NODE_MAJOR && minor < MIN_NODE_MINOR) return "版本太旧，请升级到 24.22。";
            if (major > MAX_NODE_MAJOR)
                return "版本太新。SnowLuma 2.0 要求 >=24，本项目锁定在 24.x 以避免行为差异。";
            return null;
        }

        /// <summary>
        /// 启动应用。
        ///
        /// ## 为什么绕过 npm（这是消除黑窗口的关键）
        ///
        /// `npm start` 的实际执行链是：
        ///     launcher → node npm-cli.js → cmd.exe /c "node scripts/start.mjs" → electron
        ///
        /// 中间那个 **cmd.exe 是 npm 自己 spawn 的**，它没有加 CREATE_NO_WINDOW，
        /// 所以会给自己分配一个控制台 —— 表现为一闪而过的黑框或常驻黑窗。
        /// 这一层在我们的进程里设 CreateNoWindow **管不到**，因为不是我们创建的。
        ///
        /// 结论：只有不经过 npm，才能保证全程无窗口。
        /// 直接跑 scripts/start.mjs —— 它本身就负责清 ELECTRON_RUN_AS_NODE
        /// 并拉起 Electron，功能与 npm start 完全一致。
        ///
        /// ## 输出去哪了
        ///
        /// 没有控制台，stdout/stderr 重定向到 logs/launcher.log。
        /// 必须**异步读取**：只重定向不读，管道缓冲写满后子进程会卡死。
        /// </summary>
        static int Run(string root, string nodeExe, string[] args)
        {
            string startScript = Path.Combine(root, "scripts", "start.mjs");

            string fileName;
            string argLine;

            if (File.Exists(startScript))
            {
                // 首选：直接跑启动脚本，不经过 npm → 不产生 cmd.exe → 不产生控制台
                fileName = nodeExe;
                argLine = Quote(startScript) + " " + JoinArgs(args);
            }
            else
            {
                // 兜底：老布局才用 npm（会产生一个黑窗，但至少能跑起来）
                string npmCli = Path.Combine(Path.GetDirectoryName(nodeExe) ?? "", "node_modules", "npm", "bin", "npm-cli.js");
                if (File.Exists(npmCli))
                {
                    fileName = nodeExe;
                    argLine = Quote(npmCli) + " start " + JoinArgs(args);
                }
                else
                {
                    fileName = "cmd.exe";
                    argLine = "/c npm start " + JoinArgs(args);
                }
            }

            string logDir = Path.Combine(root, "logs");
            try { Directory.CreateDirectory(logDir); } catch { }
            string logPath = Path.Combine(logDir, "launcher.log");

            // 一启动就写一行"我要用什么命令启动"，
            // 这样"没有日志"这件事本身就能被区分：
            // 文件都不存在 = 这段没跑到；文件存在但为空 = 子进程没有输出。
            LogLine(logPath, "启动器开始工作");
            LogLine(logPath, "root=" + root);
            LogLine(logPath, "node=" + nodeExe);
            LogLine(logPath, "cmd =" + fileName + " " + argLine);

            var psi = new ProcessStartInfo(fileName, argLine)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8,
                StandardErrorEncoding = Encoding.UTF8,
            };

            // 关键：清掉 ELECTRON_RUN_AS_NODE
            // 这台机器上曾出现该变量导致 Electron 退化成纯 Node（无窗口、app undefined）。
            psi.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");

            try
            {
                psi.EnvironmentVariables["ELECTRON_NO_ATTACH_CONSOLE"] = "1";
            }
            catch { /* 只读环境变量表时忽略 */ }

            try
            {
                Action<string, string> append = (tag, line) => LogLine(logPath, tag + " " + line);

                using (var p = new Process())
                {
                    p.StartInfo = psi;
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) append("", e.Data); };
                    p.ErrorDataReceived += (s, e) => { if (e.Data != null) append("! ", e.Data); };

                    p.Start();
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    p.WaitForExit();

                    append("", "进程结束，退出码 " + p.ExitCode);
                    return p.ExitCode;
                }
            }
            catch (Exception ex)
            {
                Fail("启动失败：\n\n" + ex.Message + "\n\n详细日志：" + logPath, root, null);
                return 1;
            }
        }

        static string JoinArgs(string[] args)
        {
            if (args == null || args.Length == 0) return "";
            var sb = new StringBuilder();
            foreach (string a in args) sb.Append(Quote(a)).Append(' ');
            return sb.ToString().Trim();
        }

        static string Quote(string s)
        {
            if (s == null) return "\"\"";
            return s.IndexOf(' ') >= 0 ? "\"" + s + "\"" : s;
        }

        /// <summary>
        /// 失败时弹窗 + 可选打开下载页。
        ///
        /// 同时把详情写到 build/launcher-error.log：
        /// 万一弹窗被关掉，事后还能查。
        /// </summary>
        static void Fail(string message, string root, string url)
        {
            try
            {
                string hint = url != null
                    ? "\n\n点「确定」会打开下载页面。"
                    : "\n\n（本机缺少 SnowLuma 时也需要它：SnowLuma 负责 QQ 接入）";

                DialogResult r = MessageBox.Show(
                    message + hint,
                    "Ling-bot 无法启动",
                    MessageBoxButtons.OKCancel,
                    MessageBoxIcon.Error);

                if (url != null)
                {
                    if (r == DialogResult.OK) OpenUrl(url);
                }
                else
                {
                    if (r == DialogResult.OK) OpenUrl(SNOWLUMA_DOWNLOAD);
                }
            }
            catch { /* 弹窗失败也不能崩 */ }

            try
            {
                string logPath = Path.Combine(root ?? ".", "launcher-error.log");
                File.AppendAllText(logPath,
                    "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message.Replace("\n", " ") + "\r\n",
                    Utf8NoBom);
            }
            catch { /* 写日志失败忽略 */ }
        }

        static void OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch { /* 打开浏览器失败忽略 */ }
        }
    }
}
