use super::*;

fn encode(frame: Frame) -> BytesMut {
    let mut buf = BytesMut::new();
    FrameCodec.encode(frame, &mut buf).unwrap();
    buf
}

fn decode_one(buf: &mut BytesMut) -> Result<Option<Frame>> {
    FrameCodec.decode(buf)
}

#[test]
fn round_trips_every_frame_type() {
    let frames = [
        Frame::Input(Bytes::from_static(b"ls\r")),
        Frame::Resize(TtyResize { cols: 80, rows: 24 }),
        Frame::Snapshot(Bytes::from_static(b"\x1b[2J\x1b[Hscreen")),
        Frame::Output(Bytes::from_static(b"hello world")),
        Frame::Exit(TtyExit { reason: "agent shut down".into() }),
        Frame::Hello(TtyHello { pid: 1234, client: "test".into() }),
    ];
    for frame in frames {
        let mut buf = encode(frame.clone());
        assert_eq!(decode_one(&mut buf).unwrap(), Some(frame));
        assert!(buf.is_empty());
    }
}

#[test]
fn decodes_frames_split_across_reads() {
    let encoded = encode(Frame::Output(Bytes::from_static(b"split me")));
    let mut buf = BytesMut::new();
    for (i, byte) in encoded.iter().enumerate() {
        buf.extend_from_slice(&[*byte]);
        let result = decode_one(&mut buf).unwrap();
        if i < encoded.len() - 1 {
            assert!(result.is_none(), "premature frame at byte {i}");
        } else {
            assert_eq!(result, Some(Frame::Output(Bytes::from_static(b"split me"))));
        }
    }
}

#[test]
fn decodes_multiple_frames_from_one_buffer() {
    let mut buf = encode(Frame::Output(Bytes::from_static(b"one")));
    buf.extend_from_slice(&encode(Frame::Output(Bytes::from_static(b"two"))));
    assert_eq!(decode_one(&mut buf).unwrap(), Some(Frame::Output(Bytes::from_static(b"one"))));
    assert_eq!(decode_one(&mut buf).unwrap(), Some(Frame::Output(Bytes::from_static(b"two"))));
    assert_eq!(decode_one(&mut buf).unwrap(), None);
}

#[test]
fn rejects_unknown_frame_type() {
    let mut buf = BytesMut::from(&[7u8, 0, 0, 0, 0][..]);
    assert!(matches!(decode_one(&mut buf), Err(Error::Protocol(_))));
}

#[test]
fn rejects_oversized_payload_length() {
    let declared = (MAX_PAYLOAD_BYTES as u32 + 1).to_be_bytes();
    let mut buf = BytesMut::from(&[1u8, declared[0], declared[1], declared[2], declared[3]][..]);
    assert!(matches!(decode_one(&mut buf), Err(Error::Protocol(_))));
}

#[test]
fn rejects_invalid_resize_dimensions() {
    for payload in [
        &br#"{"cols":0,"rows":24}"#[..],
        &br#"{"cols":80,"rows":10001}"#[..],
        &br#"{"cols":80.5,"rows":24}"#[..],
        &br#"{"rows":24}"#[..],
        &br#"not json"#[..],
    ] {
        let mut buf = BytesMut::new();
        use bytes::BufMut;
        buf.put_u8(2);
        buf.put_u32(payload.len() as u32);
        buf.extend_from_slice(payload);
        assert!(matches!(decode_one(&mut buf), Err(Error::Protocol(_))), "accepted {payload:?}");
    }
}

#[test]
fn rejects_invalid_hello() {
    for payload in [&br#"{"pid":0,"client":"x"}"#[..], &br#"{"client":"x"}"#[..]] {
        let mut buf = BytesMut::new();
        use bytes::BufMut;
        buf.put_u8(6);
        buf.put_u32(payload.len() as u32);
        buf.extend_from_slice(payload);
        assert!(matches!(decode_one(&mut buf), Err(Error::Protocol(_))), "accepted {payload:?}");
    }
}

#[test]
fn exit_reason_is_lenient() {
    let mut buf = BytesMut::new();
    use bytes::BufMut;
    buf.put_u8(5);
    buf.put_u32(2);
    buf.extend_from_slice(b"{}");
    assert_eq!(decode_one(&mut buf).unwrap(), Some(Frame::Exit(TtyExit { reason: String::new() })));
}
