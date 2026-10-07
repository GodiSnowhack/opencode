/** Managed shells join a Windows Job before launching children. KILL_ON_JOB_CLOSE
 * also cleans descendants when an intermediate parent has already exited; the
 * upstream taskkill /T finalizer alone cannot discover such an orphan reliably.
 * This is process-local PowerShell bootstrap, not an installed helper/config change.
 */
export const windowsJobBootstrap = `
try {
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OpenCodeManagedJob {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static void Attach() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    int size = IntPtr.Size == 8 ? 144 : 112;
    var info = Marshal.AllocHGlobal(size);
    try {
      Marshal.Copy(new byte[size], 0, info, size);
      Marshal.WriteInt32(info, 16, 0x2000);
      if (!SetInformationJobObject(job, 9, info, (uint)size) || !AssignProcessToJobObject(job, GetCurrentProcess())) {
        int error = Marshal.GetLastWin32Error();
        CloseHandle(job);
        throw new Win32Exception(error);
      }
      // Keep the handle alive until this shell exits. Children inherit job membership,
      // not this non-inheritable handle. Closing the shell kills the entire owned job.
    } finally { Marshal.FreeHGlobal(info); }
  }
}
'@
  [OpenCodeManagedJob]::Attach()
} catch { [Console]::Error.WriteLine('MANAGED_JOB_SETUP_FAILED'); exit 125 }
`
