use std::path::Path;
use std::time::Duration;

use tokio::net::UnixStream;

use crate::error::Result;

/// Connect to a Unix socket, retrying with exponential backoff (50ms
/// doubling to a 500ms cap) until `deadline` elapses. Mirrors pictl's TS
/// `connectWithRetry`: right after spawn the socket may not exist yet
/// (NotFound) or the daemon may not be accepting yet (ConnectionRefused);
/// there is no event to await for socket creation short of inotify, so
/// bounded backoff is the fallback. Other errors fail immediately.
pub(crate) async fn connect_with_retry(path: &Path, deadline: Duration) -> Result<UnixStream> {
    let deadline_at = tokio::time::Instant::now() + deadline;
    let mut delay = Duration::from_millis(50);
    loop {
        match UnixStream::connect(path).await {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                let retryable = matches!(
                    err.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                );
                if !retryable || tokio::time::Instant::now() + delay > deadline_at {
                    return Err(err.into());
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_millis(500));
            }
        }
    }
}
