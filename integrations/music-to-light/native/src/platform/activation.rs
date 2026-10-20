//! First-party implementation of Microsoft's process-loopback activation API.
//! Reference: Microsoft ApplicationLoopback sample / AUDIOCLIENT_ACTIVATION_PARAMS
//! documentation. This is not a copy of a third-party capture wrapper.
use super::sources;
use crate::{cli::Source, Failure};
use std::{
    mem::{size_of, ManuallyDrop},
    sync::mpsc::{sync_channel, SyncSender},
    time::Duration,
};
use windows::core::{implement, IUnknown, Interface, Ref, HRESULT};
use windows::Win32::{
    Media::Audio::*,
    System::{
        Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
        Com::{BLOB, CLSCTX_ALL},
        Variant::VT_BLOB,
    },
};

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion {
    done: SyncSender<()>,
    // The OS callback owns this box, so a timeout cannot free activation data
    // while Windows is still reading it. The allocation never moves or mutates.
    _params: Box<AUDIOCLIENT_ACTIVATION_PARAMS>,
}
impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.done.try_send(());
        Ok(())
    }
}

pub fn client(source: &Source) -> Result<(IAudioClient, Option<sources::Process>), Failure> {
    match source {
        Source::Process { pid, created } => {
            let process = sources::Process::open(*pid)?;
            if process.created != *created {
                return Err(Failure::new("source_identity_changed"));
            }
            Ok((process_client(*pid)?, Some(process)))
        }
        Source::Output(id) => Ok((
            unsafe { sources::output(Some(id))?.Activate(CLSCTX_ALL, None)? },
            None,
        )),
        Source::FullscreenApp => Err(Failure::new("fullscreen_app_unavailable")),
        Source::DefaultOutput => Ok((
            unsafe { sources::output(None)?.Activate(CLSCTX_ALL, None)? },
            None,
        )),
    }
}

fn process_client(pid: u32) -> Result<IAudioClient, Failure> {
    let params = Box::new(AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    });
    let data = (&*params as *const AUDIOCLIENT_ACTIVATION_PARAMS)
        .cast_mut()
        .cast();
    let (done, ready) = sync_channel(1);
    let callback: IActivateAudioInterfaceCompletionHandler = Completion {
        done,
        _params: params,
    }
    .into();
    // Borrowed BLOB: never PropVariantClear this stack-owned wrapper, because
    // its data belongs to Completion rather than the COM task allocator.
    let variant = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: data,
                    },
                },
                ..Default::default()
            }),
        },
    });
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*variant),
            &callback,
        )?
    };
    ready
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| Failure::new("activation_timeout"))?;
    let mut status = HRESULT(0);
    let mut value: Option<IUnknown> = None;
    unsafe {
        operation.GetActivateResult(&mut status, &mut value)?;
    }
    status.ok()?;
    Ok(value
        .ok_or_else(|| Failure::new("activation_returned_no_client"))?
        .cast()?)
}
