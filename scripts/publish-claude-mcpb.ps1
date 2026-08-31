param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class ClaudeMcpbPublisher {
  [StructLayout(LayoutKind.Sequential)] private struct Info {
    public uint Attributes; public long Creation; public long Access; public long Write;
    public uint Volume; public uint SizeHigh; public uint SizeLow; public uint Links; public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
  [DllImport("kernel32.dll", SetLastError=true)] private static extern bool DeviceIoControl(SafeFileHandle handle, uint control, IntPtr input, uint inputSize, byte[] output, uint outputSize, out uint returned, IntPtr overlapped);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern bool CreateHardLinkW(string destination, string source, IntPtr attributes);
  private const uint ReadAttributes=0x80, ShareReadWrite=3, ShareRead=1, OpenExisting=3, BackupAndReparse=0x02200000, Reparse=0x400, DirectoryAttribute=0x10, FsctlGetReparsePoint=0x000900A8;
  private static SafeFileHandle Open(string path, bool directory) {
    SafeFileHandle handle=CreateFileW(path, ReadAttributes, directory ? ShareReadWrite : ShareRead, IntPtr.Zero, OpenExisting, BackupAndReparse, IntPtr.Zero);
    if(handle.IsInvalid) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); }
    Info info; if(!GetFileInformationByHandle(handle,out info)) { int code=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(code); }
    if(((info.Attributes & DirectoryAttribute)!=0)!=directory) { handle.Dispose(); throw new InvalidOperationException("file_type_invalid"); }
    if((info.Attributes & Reparse)!=0) { byte[] tag=new byte[8]; uint returned; DeviceIoControl(handle, FsctlGetReparsePoint, IntPtr.Zero, 0, tag, (uint)tag.Length, out returned, IntPtr.Zero); handle.Dispose(); throw new InvalidOperationException("reparse_point_rejected"); }
    return handle;
  }
  private static IEnumerable<string> ExistingAncestors(string destination) {
    string parent=Path.GetDirectoryName(Path.GetFullPath(destination)); string root=Path.GetPathRoot(parent); string current=root;
    string remainder=parent.Substring(root.Length); foreach(string part in remainder.Split(new[]{Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar}, StringSplitOptions.RemoveEmptyEntries)) { current=Path.Combine(current,part); if(!Directory.Exists(current)) yield break; yield return current; }
  }
  public static void Publish(string source, string destination) {
    var handles=new List<SafeFileHandle>();
    try {
      foreach(string ancestor in ExistingAncestors(destination)) handles.Add(Open(ancestor,true));
      handles.Add(Open(source,false));
      if(!CreateHardLinkW(destination,source,IntPtr.Zero)) { int code=Marshal.GetLastWin32Error(); if(code==80 || code==183) throw new IOException("output_exists"); throw new Win32Exception(code); }
    } finally { for(int i=handles.Count-1;i>=0;--i) handles[i].Dispose(); }
  }
}
'@

[ClaudeMcpbPublisher]::Publish([IO.Path]::GetFullPath($Source), [IO.Path]::GetFullPath($Destination))
