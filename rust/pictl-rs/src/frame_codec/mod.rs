//! The framed tty.sock attach protocol:
//! `[type: u8][payloadLength: u32 BE][payload]`, payload cap 16 MiB.
//! Client→server: hello (required first frame), input, resize.
//! Server→client: snapshot (once, after connect), output, exit.

use bytes::{Bytes, BytesMut};
use serde::{Deserialize, Serialize};
use tokio_util::codec::{Decoder, Encoder};

use crate::error::{Error, Result};

/// Upper bound on a single frame's payload, far above anything legitimate
/// (the largest frame is a snapshot with scrollback, ~hundreds of KB). Its
/// only job is to keep a corrupt or hostile length prefix from committing
/// the decoder to buffering gigabytes.
pub const MAX_PAYLOAD_BYTES: usize = 16 * 1024 * 1024;

const HEADER_BYTES: usize = 5; // [type: u8][payloadLength: u32 BE]
const MAX_DIMENSION: u16 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Input(Bytes),
    Resize(TtyResize),
    Snapshot(Bytes),
    Output(Bytes),
    Exit(TtyExit),
    Hello(TtyHello),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TtyHello {
    pub pid: u32,
    pub client: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TtyResize {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TtyExit {
    pub reason: String,
}

impl Frame {
    pub(crate) fn type_byte(&self) -> u8 {
        match self {
            Frame::Input(_) => 1,
            Frame::Resize(_) => 2,
            Frame::Snapshot(_) => 3,
            Frame::Output(_) => 4,
            Frame::Exit(_) => 5,
            Frame::Hello(_) => 6,
        }
    }
}

fn decode_resize(payload: &[u8]) -> Result<TtyResize> {
    let bad = || Error::Protocol(format!("invalid resize payload: {}", String::from_utf8_lossy(payload)));
    let size: TtyResize = serde_json::from_slice(payload).map_err(|_| bad())?;
    if size.cols == 0 || size.cols > MAX_DIMENSION || size.rows == 0 || size.rows > MAX_DIMENSION {
        return Err(bad());
    }
    Ok(size)
}

fn decode_hello(payload: &[u8]) -> Result<TtyHello> {
    let bad = || Error::Protocol(format!("invalid hello payload: {}", String::from_utf8_lossy(payload)));
    let hello: TtyHello = serde_json::from_slice(payload).map_err(|_| bad())?;
    if hello.pid == 0 {
        return Err(bad());
    }
    Ok(hello)
}

/// Lenient like the TS decoder: a missing or non-string `reason` becomes "".
fn decode_exit(payload: &[u8]) -> Result<TtyExit> {
    let value: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|_| Error::Protocol(format!("invalid exit payload: {}", String::from_utf8_lossy(payload))))?;
    let reason = value.get("reason").and_then(|r| r.as_str()).unwrap_or("");
    Ok(TtyExit { reason: reason.to_owned() })
}

/// Decode errors (unknown frame type, oversized declared length, malformed
/// JSON payload) are unrecoverable framing violations; the caller must drop
/// the connection, matching the TS `FrameDecoder` contract.
pub struct FrameCodec;

impl Decoder for FrameCodec {
    type Item = Frame;
    type Error = Error;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Frame>> {
        use bytes::Buf;
        if src.len() < HEADER_BYTES {
            return Ok(None);
        }
        let frame_type = src[0];
        if !(1..=6).contains(&frame_type) {
            return Err(Error::Protocol(format!("unknown tty frame type {frame_type}")));
        }
        let payload_len = u32::from_be_bytes([src[1], src[2], src[3], src[4]]) as usize;
        if payload_len > MAX_PAYLOAD_BYTES {
            return Err(Error::Protocol(format!(
                "tty frame payload length {payload_len} exceeds limit {MAX_PAYLOAD_BYTES}"
            )));
        }
        if src.len() < HEADER_BYTES + payload_len {
            src.reserve(HEADER_BYTES + payload_len - src.len());
            return Ok(None);
        }
        src.advance(HEADER_BYTES);
        let payload = src.split_to(payload_len).freeze();
        Ok(Some(match frame_type {
            1 => Frame::Input(payload),
            2 => Frame::Resize(decode_resize(&payload)?),
            3 => Frame::Snapshot(payload),
            4 => Frame::Output(payload),
            5 => Frame::Exit(decode_exit(&payload)?),
            6 => Frame::Hello(decode_hello(&payload)?),
            _ => unreachable!("frame type validated above"),
        }))
    }
}

impl Encoder<Frame> for FrameCodec {
    type Error = Error;

    fn encode(&mut self, frame: Frame, dst: &mut BytesMut) -> Result<()> {
        use bytes::BufMut;
        let type_byte = frame.type_byte();
        let payload = match frame {
            Frame::Input(bytes) | Frame::Snapshot(bytes) | Frame::Output(bytes) => bytes,
            Frame::Resize(size) => serde_json::to_vec(&size)?.into(),
            Frame::Exit(exit) => serde_json::to_vec(&exit)?.into(),
            Frame::Hello(hello) => serde_json::to_vec(&hello)?.into(),
        };
        dst.reserve(HEADER_BYTES + payload.len());
        dst.put_u8(type_byte);
        dst.put_u32(payload.len() as u32);
        dst.extend_from_slice(&payload);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
