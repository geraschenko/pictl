use std::path::Path;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio_util::codec::{FramedRead, FramedWrite};

use crate::connect_with_retry::connect_with_retry;
use crate::error::{Error, Result};
use crate::frame_codec::{Frame, FrameCodec, TtyHello, TtyResize};

/// A tty.sock attach client. A background reader task drains the socket
/// eagerly into [`TtyEvents`] (the server writes without backpressure, so a
/// client must never stop reading). Dropping the client aborts the task and
/// disconnects.
pub struct TtyClient {
    writer: FramedWrite<tokio::net::unix::OwnedWriteHalf, FrameCodec>,
    reader_task: JoinHandle<()>,
}

/// Server-to-client frames, delivered in order. `next()` returning `None`
/// means the connection is gone.
pub struct TtyEvents {
    rx: mpsc::UnboundedReceiver<Result<TtyEvent>>,
}

#[derive(Debug)]
pub enum TtyEvent {
    /// xterm-serialized ANSI screen state, sent once after connect.
    Snapshot(Bytes),
    /// Raw PTY output bytes.
    Output(Bytes),
    Exit { reason: String },
}

impl TtyClient {
    /// Connects and sends hello `{ pid: std::process::id(), client: client_name }`.
    /// Retries with backoff until `deadline` elapses: the socket may not
    /// exist yet right after spawn.
    pub async fn connect(
        tty_sock: impl AsRef<Path>,
        client_name: &str,
        deadline: Duration,
    ) -> Result<(TtyClient, TtyEvents)> {
        let stream = connect_with_retry(tty_sock.as_ref(), deadline).await?;
        let (read_half, write_half) = stream.into_split();
        let mut writer = FramedWrite::new(write_half, FrameCodec);
        writer
            .send(Frame::Hello(TtyHello {
                pid: std::process::id(),
                client: client_name.to_owned(),
            }))
            .await?;
        let (tx, rx) = mpsc::unbounded_channel();
        let reader_task = tokio::spawn(async move {
            let mut reader = FramedRead::new(read_half, FrameCodec);
            while let Some(item) = reader.next().await {
                let event = match item {
                    Ok(Frame::Snapshot(bytes)) => Ok(TtyEvent::Snapshot(bytes)),
                    Ok(Frame::Output(bytes)) => Ok(TtyEvent::Output(bytes)),
                    Ok(Frame::Exit(exit)) => Ok(TtyEvent::Exit { reason: exit.reason }),
                    Ok(other) => Err(Error::Protocol(format!(
                        "unexpected server-to-client frame type {}",
                        other.type_byte()
                    ))),
                    Err(err) => Err(err),
                };
                let unrecoverable = event.is_err();
                if tx.send(event).is_err() || unrecoverable {
                    break;
                }
            }
        });
        Ok((TtyClient { writer, reader_task }, TtyEvents { rx }))
    }

    pub async fn input(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer
            .send(Frame::Input(Bytes::copy_from_slice(bytes)))
            .await
    }

    pub async fn resize(&mut self, size: TtyResize) -> Result<()> {
        self.writer.send(Frame::Resize(size)).await
    }
}

impl Drop for TtyClient {
    fn drop(&mut self) {
        self.reader_task.abort();
    }
}

impl TtyEvents {
    pub async fn next(&mut self) -> Option<Result<TtyEvent>> {
        self.rx.recv().await
    }
}

#[cfg(test)]
mod tests;
