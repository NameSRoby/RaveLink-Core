// Windows Core Audio only: no recording, keyboard input, private APIs or process injection.
// https://learn.microsoft.com/windows/win32/coreaudio/endpoint-volume-controls
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

namespace RaveLink.WindowsAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class DeviceEnumerator {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint mask, out IDeviceCollection collection);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IDevice device);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IPropertyStore store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
  }
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] struct PropertyValue {
    [FieldOffset(0)] public ushort type;
    [FieldOffset(8)] public IntPtr pointer;
  }
  [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
  }
  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr callback);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr callback);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float value, ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float value, ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float value);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float value);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float value, ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float value, ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float value);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float value);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool value, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool value);
  }
  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionManager {
    [PreserveSig] int GetAudioSessionControl(ref Guid session, uint flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(ref Guid session, uint flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out ISessionEnumerator sessions);
  }
  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionEnumerator {
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, [MarshalAs(UnmanagedType.IUnknown)] out object control);
  }
  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISessionControl {
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
    [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
    [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
    [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(ref Guid group, ref Guid context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr callback);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr callback);
    [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetProcessId(out uint processId);
    [PreserveSig] int IsSystemSoundsSession();
  }
  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface ISimpleVolume {
    [PreserveSig] int SetMasterVolume(float value, ref Guid context);
    [PreserveSig] int GetMasterVolume(out float value);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool value, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool value);
  }
  public class AudioRow {
    public string key, name, kind;
    public int? volume;
    public bool? muted;
    public bool mixed, active, isDefault;
    public int sessions;
  }
  public class AudioSnapshot {
    public bool available=true;
    public AudioRow output, input;
    public AudioRow[] devices, apps;
  }
  public static class Control {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropertyValue value);
    static readonly Guid endpointGuid=new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static readonly Guid sessionsGuid=new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    static void Check(int hr) { if(hr<0) Marshal.ThrowExceptionForHR(hr); }
    static void Release(object value) { if(value!=null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value); }
    static string Key(string kind,string value) { using(var sha=SHA256.Create())return kind+":"+BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value.ToLowerInvariant()))).Replace("-","").ToLowerInvariant(); }
    static string Name(IDevice device) {
      IPropertyStore store=null; var value=new PropertyValue();
      try { Check(device.OpenPropertyStore(0,out store));var key=new PropertyKey{format=new Guid("A45C254E-DF1C-4EFD-8020-67D146A850E0"),id=14};Check(store.GetValue(ref key,out value));return value.type==31 ? Marshal.PtrToStringUni(value.pointer) : "Audio device"; }
      finally { PropVariantClear(ref value);Release(store); }
    }
    static string DefaultId(IDeviceEnumerator enumerator,int flow,int role) {
      IDevice device=null;try { if(enumerator.GetDefaultAudioEndpoint(flow,role,out device)<0)return null;string id;Check(device.GetId(out id));return id; }finally{Release(device);}
    }
    static IEndpointVolume Endpoint(IDevice device) { object obj;var iid=endpointGuid;Check(device.Activate(ref iid,23,IntPtr.Zero,out obj));return (IEndpointVolume)obj; }
    static AudioRow ReadEndpoint(IDevice device,string key,string kind,bool selected) {
      IEndpointVolume volume=null;try{volume=Endpoint(device);float level;bool mute;Check(volume.GetMasterVolumeLevelScalar(out level));Check(volume.GetMute(out mute));return new AudioRow{key=key,name=Name(device),kind=kind,volume=(int)Math.Round(level*100),muted=mute,isDefault=selected,active=true};}finally{Release(volume);}
    }
    static string SessionName(ISessionControl session) {
      if(session.IsSystemSoundsSession()==0)return "System sounds";
      uint pid;Check(session.GetProcessId(out pid));if(pid==0)return null;
      try{using(var process=Process.GetProcessById((int)pid))return process.ProcessName;}catch(ArgumentException){return null;}catch(System.ComponentModel.Win32Exception){return null;}
    }
    static void Sessions(IDevice device,Action<ISessionControl,ISimpleVolume,string> action) {
      object managerObject=null;ISessionEnumerator sessions=null;
      try {var iid=sessionsGuid;Check(device.Activate(ref iid,23,IntPtr.Zero,out managerObject));Check(((ISessionManager)managerObject).GetSessionEnumerator(out sessions));int count;Check(sessions.GetCount(out count));
        for(int i=0;i<Math.Min(count,256);i++) {object raw=null;try{Check(sessions.GetSession(i,out raw));var session=(ISessionControl)raw;int state;Check(session.GetState(out state));if(state==2)continue;var name=SessionName(session);if(String.IsNullOrEmpty(name))continue;action(session,(ISimpleVolume)raw,name);}catch(COMException){}finally{Release(raw);}}
      }finally{Release(sessions);Release(managerObject);}
    }
    public static AudioSnapshot Read() {
      if(IntPtr.Size!=8)throw new InvalidOperationException("audio_platform_unsupported");
      var enumerator=(IDeviceEnumerator)new DeviceEnumerator();var devices=new List<AudioRow>();var apps=new Dictionary<string,List<AudioRow>>();
      var result=new AudioSnapshot();
      try{var outputId=DefaultId(enumerator,0,1);var inputId=DefaultId(enumerator,1,0);
        for(int flow=0;flow<2;flow++){IDeviceCollection collection=null;try{Check(enumerator.EnumAudioEndpoints(flow,1,out collection));uint count;Check(collection.GetCount(out count));
          for(uint i=0;i<Math.Min(count,32);i++){IDevice device=null;try{Check(collection.Item(i,out device));string id;Check(device.GetId(out id));var selected=id==(flow==0?outputId:inputId);var row=ReadEndpoint(device,Key("device",id),flow==0?"output":"input",selected);devices.Add(row);if(selected){if(flow==0)result.output=row;else result.input=row;}
            if(flow==0)Sessions(device,(session,volume,name)=>{float level;bool mute;int state;Check(volume.GetMasterVolume(out level));Check(volume.GetMute(out mute));Check(session.GetState(out state));var key=Key("app",name);if(!apps.ContainsKey(key))apps[key]=new List<AudioRow>();apps[key].Add(new AudioRow{key=key,name=name,kind="app",volume=(int)Math.Round(level*100),muted=mute,active=state==1});});
          }catch(COMException){}finally{Release(device);}}
        }finally{Release(collection);}}
        result.devices=devices.ToArray();result.apps=apps.Values.Select(rows=>{var first=rows[0];var sameVolume=rows.All(row=>row.volume==first.volume);var sameMute=rows.All(row=>row.muted==first.muted);return new AudioRow{key=first.key,name=first.name,kind="app",volume=sameVolume?first.volume:null,muted=sameMute?first.muted:null,mixed=!sameVolume||!sameMute,active=rows.Any(row=>row.active),sessions=rows.Count};}).OrderBy(row=>row.name,StringComparer.OrdinalIgnoreCase).Take(64).ToArray();return result;
      }finally{Release(enumerator);}
    }
    public static AudioSnapshot Apply(string target,string operation,int level,bool muted) {
      if(String.IsNullOrEmpty(target)||!(operation=="volume"||operation=="mute"||operation=="toggle-mute")||level<0||level>100)throw new InvalidOperationException("audio_command_invalid");
      var before=Read();AudioRow selected=target=="system"?before.output:target=="microphone"?before.input:before.devices.Concat(before.apps).FirstOrDefault(row=>row.key==target);
      if(selected==null)throw new InvalidOperationException("audio_target_unavailable");
      bool desired=operation=="toggle-mute"?selected.muted!=true:muted;int changed=0;var context=Guid.Empty;
      var enumerator=(IDeviceEnumerator)new DeviceEnumerator();
      try{for(int flow=0;flow<2;flow++){IDeviceCollection collection=null;try{Check(enumerator.EnumAudioEndpoints(flow,1,out collection));uint count;Check(collection.GetCount(out count));
        for(uint i=0;i<Math.Min(count,32);i++){IDevice device=null;try{Check(collection.Item(i,out device));string id;Check(device.GetId(out id));if(selected.kind!="app"&&Key("device",id)==selected.key){IEndpointVolume volume=null;try{volume=Endpoint(device);if(operation=="volume")Check(volume.SetMasterVolumeLevelScalar(level/100f,ref context));else Check(volume.SetMute(desired,ref context));changed++;}finally{Release(volume);}}
          if(selected.kind=="app"&&flow==0)Sessions(device,(session,volume,name)=>{if(Key("app",name)!=selected.key)return;if(operation=="volume")Check(volume.SetMasterVolume(level/100f,ref context));else Check(volume.SetMute(desired,ref context));changed++;});
        }finally{Release(device);}}
      }finally{Release(collection);}}}finally{Release(enumerator);}
      if(changed==0)throw new InvalidOperationException("audio_target_unavailable");
      var after=Read();var confirmed=after.devices.Concat(after.apps).FirstOrDefault(row=>row.key==selected.key);
      if(confirmed==null || (operation=="volume" ? !confirmed.volume.HasValue || Math.Abs(confirmed.volume.Value-level)>1 : confirmed.muted!=desired))throw new InvalidOperationException("audio_change_unconfirmed");
      return after;
    }
  }
}
